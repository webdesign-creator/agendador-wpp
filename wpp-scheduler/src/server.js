/**
 * Servidor do agendador de WhatsApp.
 *
 * - Serve o painel (public/index.html)
 * - API para status/QR, grupos, agendar, editar, listar e cancelar
 * - Agendador (loop) que dispara as mensagens vencidas no grupo escolhido,
 *   com intervalo mínimo entre envios (para não parecer spam)
 *
 * Roda 24h num host sempre ligado → dispara mesmo com seu PC desligado.
 */
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { store } from "./store.js";
import { wa } from "./wa.js";
import { fetchThumb, firstUrl } from "./thumb.js";

// Se algo no processamento de mensagens do WhatsApp (Baileys) rejeitar uma
// Promise sem tratamento — comum quando a sessão local fica com chaves do
// Signal dessincronizadas ("MessageCounterError", falha ao decriptar) — o
// Node por padrão derruba o processo inteiro. Com "restart always" no
// Railway, isso virava um loop de crash-restart que gerava tráfego de rede
// enorme a cada reinício (fetch da versão do Baileys, handshake novo, etc).
// Por isso só registramos o erro e seguimos rodando; o wa.js já cuida de
// detectar sessão corrompida (muitas reconexões seguidas) e pedir um QR novo.
process.on("unhandledRejection", (err) => {
  console.error("⚠️ unhandledRejection (ignorado, processo continua):", err);
});
process.on("uncaughtException", (err) => {
  console.error("⚠️ uncaughtException (ignorado, processo continua):", err);
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const MIN_GAP = (Number(process.env.MIN_SEND_GAP_SECONDS) || 8) * 1000;
const PASSWORD = process.env.DASHBOARD_PASSWORD || "";
// Quanto tempo depois de enviada (ou de falhar/ser cancelada) uma mensagem
// fica guardada no histórico antes de ser apagada. Sem esse limite o
// messages.json só cresce (cada mensagem guarda a imagem em base64 pra
// sempre) até lotar o disco — foi o que já derrubou o app uma vez (ENOSPC).
const MESSAGE_RETENTION_MS = (Number(process.env.MESSAGE_RETENTION_HOURS) || 8) * 60 * 60 * 1000;
// Falhas de envio costumam ser transitórias (rede, sessão reconectando etc.),
// não um problema da mensagem em si — inclusive mensagens sem link e sem
// imagem, que são perfeitamente válidas. Por isso, em vej de marcar como
// "failed" na primeira falha (o que parecia "a mensagem sumiu" pro usuário),
// tentamos de novo automaticamente algumas vezes antes de desistir.
const MAX_SEND_RETRIES = Number(process.env.MAX_SEND_RETRIES) || 3;
const RETRY_DELAY_MS = (Number(process.env.RETRY_DELAY_MINUTES) || 2) * 60 * 1000;

const app = express();
// Limite maior para aceitar imagens coladas (base64) no corpo do POST.
app.use(express.json({ limit: "12mb" }));

// Proteção opcional por senha (Basic Auth, usuário "admin").
if (PASSWORD) {
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || "";
    const [, b64] = hdr.split(" ");
    const [, pass] = Buffer.from(b64 || "", "base64").toString().split(":");
    if (pass === PASSWORD) return next();
    res.set("WWW-Authenticate", 'Basic realm="Ofertas Scheduler"');
    return res.status(401).send("Autenticação necessária.");
  });
}

app.use(express.static(join(__dirname, "..", "public")));

// ---- API ----
app.get("/api/status", (_req, res) => res.json(wa.status()));

app.get("/api/groups", async (_req, res) => {
  try {
    res.json({ groups: await wa.groups() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/messages", (_req, res) => res.json({ messages: store.list() }));

// Prévia da imagem do link (og:image). Usado pelo painel para mostrar qual
// imagem será enviada, e internamente na hora do disparo.
app.get("/api/thumb", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Informe ?url=" });
  res.json({ image: await fetchThumb(String(url)) });
});

app.post("/api/messages", (req, res) => {
  try {
    const { text, imageUrl, imageData, groupJid, groupName, scheduledAt } = req.body || {};
    if (!groupJid) throw new Error("Escolha o grupo de destino.");
    if (!text && !imageUrl && !imageData) throw new Error("A mensagem não pode ser vazia.");
    const when = Number(scheduledAt);
    if (!when || !isFinite(when)) throw new Error("Data/hora de agendamento inválida.");
    // Nenhum tipo de mensagem é obrigatório ter link: bom dia, cupom, aviso ou
    // qualquer outro texto livre agenda e envia normalmente, com ou sem imagem.
    const rec = store.add({ text, imageUrl, imageData, groupJid, groupName, scheduledAt: when });
    res.status(201).json(rec);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * Edita uma mensagem ainda não enviada (agendada ou que falhou), sem precisar
 * excluir e recriar. Volta o status para "pending" (limpando erro/tentativas
 * anteriores), para que a versão corrigida entre na fila normalmente.
 */
app.put("/api/messages/:id", (req, res) => {
  try {
    const existing = store.get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Mensagem não encontrada." });
    if (existing.status === "sent") throw new Error("Mensagens já enviadas não podem ser editadas.");

    const { text, imageUrl, imageData, groupJid, groupName, scheduledAt } = req.body || {};
    const patch = {
      text: text ?? existing.text,
      imageUrl: imageUrl ?? existing.imageUrl,
      imageData: imageData ?? existing.imageData,
      groupJid: groupJid || existing.groupJid,
      groupName: groupName || existing.groupName,
    };
    if (!patch.groupJid) throw new Error("Escolha o grupo de destino.");
    if (!patch.text && !patch.imageUrl && !patch.imageData) throw new Error("A mensagem não pode ser vazia.");

    if (scheduledAt !== undefined) {
      const when = Number(scheduledAt);
      if (!when || !isFinite(when)) throw new Error("Data/hora de agendamento inválida.");
      patch.scheduledAt = when;
    }

    // Reagenda como pendente: uma correção deve poder ser reenviada mesmo que
    // a versão anterior tivesse falhado.
    patch.status = "pending";
    patch.error = null;
    patch.retries = 0;

    const rec = store.update(existing.id, patch);
    res.json(rec);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * Decide a imagem do envio: prioridade para a thumb do link do produto (dentro
 * do texto); se não houver, usa a imagem colada; senão, envia só o texto.
 */
async function resolveSend(msg) {
  const base = { groupJid: msg.groupJid, text: msg.text };
  const link = firstUrl(msg.text) || msg.imageUrl;
  if (link) {
    const thumb = await fetchThumb(link);
    if (thumb) return { ...base, imageUrl: thumb };
  }
  if (msg.imageData) return { ...base, imageData: msg.imageData };
  if (msg.imageUrl) return { ...base, imageUrl: msg.imageUrl };
  return base;
}

app.delete("/api/messages/:id", (req, res) => {
  const ok = store.remove(req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});

// Enviar agora (teste manual) — tentativa única e imediata, sem reagendar.
app.post("/api/messages/:id/send-now", async (req, res) => {
  const msg = store.list().find((m) => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: "Mensagem não encontrada." });
  try {
    await wa.send(await resolveSend(msg));
    store.update(msg.id, { status: "sent", sentAt: Date.now(), error: null });
    res.json({ ok: true });
  } catch (e) {
    store.update(msg.id, { status: "failed", error: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/logout", async (_req, res) => {
  await wa.logout();
  res.json({ ok: true });
});

// ---- Agendador ----
let lastSentAt = 0;
async function tick() {
  if (!wa.connected) return;
  const now = Date.now();
  if (now - lastSentAt < MIN_GAP) return; // respeita o intervalo mínimo
  const due = store.due(now);
  if (!due.length) return;
  const msg = due[0]; // um por vez, com intervalo entre eles
  try {
    await wa.send(await resolveSend(msg));
    store.update(msg.id, { status: "sent", sentAt: Date.now(), error: null });
    lastSentAt = Date.now();
    console.log(`📤 Enviada para ${msg.groupName}: ${(msg.text || "").slice(0, 40)}…`);
  } catch (e) {
    // Falha ao enviar nem sempre é definitiva (conexão reconectando, rede
    // instável etc.) — isso valia tanto pra mensagem com link quanto sem.
    // Em vez de desistir na primeira falha, tenta de novo mais algumas vezes
    // antes de marcar como "failed" de verdade.
    const retries = (msg.retries || 0) + 1;
    if (retries < MAX_SEND_RETRIES) {
      store.update(msg.id, { retries, error: e.message, scheduledAt: Date.now() + RETRY_DELAY_MS });
      console.warn(`⚠️ Falha ao enviar (tentativa ${retries}/${MAX_SEND_RETRIES}), tentando de novo em breve:`, e.message);
    } else {
      store.update(msg.id, { status: "failed", retries, error: e.message });
      console.error("Falha ao enviar (esgotou as tentativas):", e.message);
    }
  }
}

/**
 * Limpa do histórico as mensagens já enviadas/com falha/canceladas há mais de
 * MESSAGE_RETENTION_MS (padrão 8h). Roda ao subir e depois periodicamente,
 * para o messages.json não voltar a crescer sem limite e lotar o disco.
 */
function pruneOldMessages() {
  try {
    const removed = store.pruneOld(MESSAGE_RETENTION_MS);
    if (removed) {
      const hours = (MESSAGE_RETENTION_MS / 3600000).toFixed(1);
      console.log(`🧹 ${removed} mensagem(ns) com mais de ${hours}h removida(s) do histórico.`);
    }
  } catch (e) {
    console.error("Erro ao limpar mensagens antigas:", e.message);
  }
}

// ---- Boot ----
wa.start().catch((e) => console.error("Erro ao iniciar o WhatsApp:", e));
setInterval(tick, 5000);
pruneOldMessages(); // já limpa uma vez ao subir, sem esperar o primeiro intervalo
setInterval(pruneOldMessages, 10 * 60 * 1000); // depois, a cada 10 minutos
app.listen(PORT, () => {
  console.log(`🚀 Painel em http://localhost:${PORT}`);
  console.log("Abra o painel e escaneie o QR para conectar o WhatsApp.");
});
