/**
 * Conexão com o WhatsApp via Baileys (WhatsApp Web não-oficial).
 *
 * - Guarda a sessão em ./auth (escaneia o QR só na primeira vez).
 * - Reconecta sozinho se cair (a não ser que a sessão seja deslogada).
 * - Se a sessão local ficar corrompida (erros de chave do Signal em
 *   sequência: "MessageCounterError", "Failed to decrypt message with
 *   any known session"), o Baileys pode entrar num loop de falhas que
 *   gera tráfego de rede enorme (reconexões/ressincronizações repetidas
 *   sem parar). Por isso contamos reconexões dentro de uma janela curta
 *   e, se passar do limite, limpamos a sessão sozinhos e pedimos um QR
 *   novo — em vez de ficar preso reconectando pra sempre.
 * - Expõe: estado da conexão, QR atual (para o painel), lista de grupos e envio.
 */
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";
import { join } from "node:path";
import { rm } from "node:fs/promises";

const logger = pino({ level: "silent" });
// A sessão do WhatsApp fica no disco persistente (DATA_DIR/auth), para
// escanear o QR só uma vez, mesmo após reinícios/deploys.
const DATA_DIR = process.env.DATA_DIR || new URL("..", import.meta.url).pathname;
const AUTH_DIR = join(DATA_DIR, "auth");

// Se a conexão cair e reconectar mais que isso dentro da janela abaixo,
// tratamos como sessão corrompida (não como uma queda normal de rede) e
// forçamos um QR novo em vez de continuar reconectando indefinidamente —
// isso é o que estava gerando o consumo alto de banda.
const MAX_RECONNECTS_BEFORE_RESET = 5;
const RECONNECT_WINDOW_MS = 60_000;

class WhatsApp {
  constructor() {
    this.sock = null;
    this.connected = false;
    this.qrDataUrl = null; // QR em imagem (data URL) para o painel
    this.me = null; // dados da conta conectada
    this.loggedOut = false;
    this.starting = false;
    this.reconnectTimestamps = [];
  }

  /** Fecha o socket anterior (se existir) antes de abrir outro, para não
   * deixar conexões "zumbis" ativas ao mesmo tempo — isso por si só já
   * pode causar sessão dessincronizada e tráfego duplicado. */
  async _teardownSocket() {
    if (!this.sock) return;
    try {
      this.sock.ev.removeAllListeners();
      this.sock.end(undefined);
    } catch {
      /* ignore */
    }
    this.sock = null;
  }

  /** Registra mais uma tentativa de reconexão e devolve quantas
   * aconteceram dentro da janela recente (RECONNECT_WINDOW_MS). */
  _registerReconnectAttempt() {
    const now = Date.now();
    this.reconnectTimestamps = this.reconnectTimestamps.filter(
      (t) => now - t < RECONNECT_WINDOW_MS
    );
    this.reconnectTimestamps.push(now);
    return this.reconnectTimestamps.length;
  }

  async start() {
    if (this.starting) return;
    this.starting = true;
    await this._teardownSocket();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: ["Ofertas Scheduler", "Chrome", "1.0.0"],
      syncFullHistory: false,
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.qrDataUrl = await QRCode.toDataURL(qr);
        this.connected = false;
      }
      if (connection === "open") {
        this.connected = true;
        this.qrDataUrl = null;
        this.loggedOut = false;
        this.me = this.sock.user || null;
        this.reconnectTimestamps = []; // conexão estável: zera o contador
        console.log("✅ WhatsApp conectado:", this.me?.id);
      }
      if (connection === "close") {
        this.connected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        const attempts = this._registerReconnectAttempt();
        const sessionLooksCorrupted = attempts > MAX_RECONNECTS_BEFORE_RESET;

        if (code === DisconnectReason.loggedOut || sessionLooksCorrupted) {
          // Sessão encerrada (pelo painel, pelo celular, ou porque a sessão
          // salva já estava inválida/corrompida — muitas reconexões em
          // pouco tempo é sinal disso): limpa as credenciais antigas e
          // reinicia para gerar um QR novo automaticamente, em vez de
          // ficar travado reconectando e gerando tráfego sem parar.
          this.loggedOut = true;
          this.me = null;
          this.qrDataUrl = null;
          this.starting = false;
          this.reconnectTimestamps = [];
          if (sessionLooksCorrupted) {
            console.warn(
              `⚠️ ${attempts} reconexões em menos de 1 minuto — sessão parece corrompida, limpando e gerando novo QR…`
            );
          } else {
            console.warn("⚠️ WhatsApp deslogado — gerando novo QR…");
          }
          await rm(AUTH_DIR, { recursive: true, force: true }).catch(() => {});
          setTimeout(() => this.start().catch(console.error), 1000);
        } else {
          console.warn(`🔄 Conexão caiu (tentativa ${attempts}), reconectando…`, code);
          this.starting = false;
          // Pequeno backoff crescente pra não martelar a rede caso a queda
          // se repita várias vezes seguidas.
          const delay = Math.min(2000 * attempts, 15000);
          setTimeout(() => this.start().catch(console.error), delay);
        }
      }
    });

    this.starting = false;
  }

  status() {
    return {
      connected: this.connected,
      loggedOut: this.loggedOut,
      qr: this.qrDataUrl,
      me: this.me ? { id: this.me.id, name: this.me.name } : null,
    };
  }

  /** Lista os grupos em que a conta participa. */
  async groups() {
    if (!this.connected) return [];
    const map = await this.sock.groupFetchAllParticipating();
    return Object.values(map)
      .map((g) => ({ jid: g.id, name: g.subject }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Envia uma mensagem para um grupo. A imagem pode vir por URL (`imageUrl`,
   * ex.: thumb do link do produto) ou por dados colados (`imageData`, data URL
   * base64). O texto vira legenda quando há imagem. Sem imagem, envia só texto.
   * Os asteriscos do WhatsApp (*negrito*, ~riscado~, _itálico_) são preservados.
   */
  async send({ groupJid, text, imageUrl, imageData }) {
    if (!this.connected) throw new Error("WhatsApp não está conectado.");
    const caption = text || "";
    if (imageUrl) {
      await this.sock.sendMessage(groupJid, { image: { url: imageUrl }, caption });
    } else if (imageData) {
      const base64 = String(imageData).split(",").pop();
      await this.sock.sendMessage(groupJid, { image: Buffer.from(base64, "base64"), caption });
    } else {
      await this.sock.sendMessage(groupJid, { text: caption });
    }
  }

  /** Encerra a sessão (logout) e já reabre uma conexão nova para gerar outro QR. */
  async logout() {
    try {
      await this.sock?.logout();
    } catch {
      /* ignore */
    }
    this.connected = false;
    this.me = null;
    this.loggedOut = true;
    this.qrDataUrl = null;
    await this._teardownSocket();
    this.reconnectTimestamps = [];
    // Limpa as credenciais antigas (senão o Baileys tenta reusar a sessão já
    // invalidada e nunca chega a pedir um QR novo).
    await rm(AUTH_DIR, { recursive: true, force: true }).catch(() => {});
    this.starting = false;
    this.start().catch(console.error);
  }
}

export const wa = new WhatsApp();
