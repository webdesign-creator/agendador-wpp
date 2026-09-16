// Painel do agendador de WhatsApp.
const $ = (id) => document.getElementById(id);
const DEFAULT_GROUP = "SELEÇÃO PARA O SEU LAR [#03]"; // grupo pré-selecionado
let connected = false;
let groupsLoaded = false;
let listTab = "pending"; // aba ativa em Mensagens: pending | sent
let pastedImage = null; // data URL da imagem colada (reserva)
let thumbTimer = null;
let lastThumb = null; // thumb do link do produto (prioridade)
let editingId = null; // id da mensagem em edição (null = agendando uma nova)

function toast(m) { const t = $("toast"); t.textContent = m; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2200); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function waFormat(t) { let h = esc(t); h = h.replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>"); h = h.replace(/~([^}\n]+)~/g, "<del>$1</del>"); h = h.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>"); return h; }
function nowTime() { return new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); }
function firstUrl(t) { const m = (t || "").match(/https?:\/\/[^\s]+/); return m ? m[0].replace(/[)\].,]+$/, "") : null; }
async function api(path, opts) {
	const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
	return data;
}

// ---- Status / QR ----
async function loadStatus() {
	try {
		const s = await api("/api/status");
		connected = s.connected;
		const box = $("status");
		if (s.connected) {
			box.innerHTML = `<span class="dot on"></span> <strong>Conectado</strong> ${s.me?.name ? "como " + esc(s.me.name) : ""}
				<button class="btn ghost small" id="btn-logout">Desconectar</button>`;
			$("btn-logout").onclick = async () => { if (confirm("Desconectar o WhatsApp?")) { await api("/api/logout", { method: "POST" }); groupsLoaded = false; loadStatus(); } };
			if (!groupsLoaded) loadGroups();
		} else if (s.qr) {
			box.innerHTML = `<img class="qr" src="${s.qr}" alt="QR Code" />
				<div><strong>Escaneie o QR</strong><div class="hint">No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho.</div></div>`;
		} else {
			box.innerHTML = `<span class="dot off"></span> ${s.loggedOut ? "Sessão encerrada — gerando novo QR…" : "Iniciando conexão…"}`;
		}
	} catch (e) {
		$("status").innerHTML = `<span class="hint">${esc(e.message)}</span>`;
	}
}
async function loadGroups() {
	try {
		const { groups } = await api("/api/groups");
		const sel = $("group");
		if (!groups.length) { sel.innerHTML = '<option value="">Nenhum grupo encontrado</option>'; return; }
		sel.innerHTML = groups.map((g) => `<option value="${esc(g.jid)}" data-name="${esc(g.name)}">${esc(g.name)}</option>`).join("");
		// Pré-seleciona o grupo padrão, se existir na conta.
		const def = groups.find((g) => (g.name || "").trim() === DEFAULT_GROUP);
		if (def) sel.value = def.jid;
		groupsLoaded = true;
	} catch (e) { toast(e.message); }
}

// ---- Imagem colada (Ctrl+V / clique / arquivo) ----
const zone = $("paste-zone");
zone.addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) readImage(f); });
zone.addEventListener("paste", (e) => handlePaste(e));
document.addEventListener("paste", (e) => { if (document.activeElement === $("text") || document.activeElement === zone) handlePaste(e); });
zone.addEventListener("dragover", (e) => { e.preventDefault(); });
zone.addEventListener("drop", (e) => { e.preventDefault(); const f = [...e.dataTransfer.files].find((x) => x.type.startsWith("image/")); if (f) readImage(f); });
$("btn-clear-img").addEventListener("click", () => setPastedImage(null));

function handlePaste(e) {
	const items = e.clipboardData?.items || [];
	for (const it of items) {
		if (it.type.startsWith("image/")) { const f = it.getAsFile(); if (f) { readImage(f); e.preventDefault(); return; } }
	}
}
function readImage(file) {
	const r = new FileReader();
	r.onload = () => setPastedImage(r.result);
	r.readAsDataURL(file);
}
function setPastedImage(dataUrl) {
	pastedImage = dataUrl;
	const img = $("paste-preview"), hint = $("pz-hint"), clear = $("btn-clear-img");
	if (dataUrl) { img.src = dataUrl; img.hidden = false; hint.hidden = true; zone.classList.add("has-img"); clear.hidden = false; }
	else { img.hidden = true; img.src = ""; hint.hidden = false; zone.classList.remove("has-img"); clear.hidden = true; $("file-input").value = ""; }
	updatePreview();
}

// ---- Prévia (texto + imagem, com prioridade da thumb do link) ----
$("text").addEventListener("input", () => { updatePreview(); scheduleThumb(); });
function updatePreview() {
	const text = $("text").value;
	$("prev-text").innerHTML = waFormat(text) || '<span class="hint">Sua mensagem aparece aqui…</span>';
	$("prev-time").textContent = text ? nowTime() + " ✓✓" : "";
	const img = $("prev-img");
	if (lastThumb) { img.src = lastThumb; img.hidden = false; $("prev-src").textContent = "🖼️ Imagem: do link do produto (prioridade)"; }
	else if (pastedImage) { img.src = pastedImage; img.hidden = false; $("prev-src").textContent = "🖼️ Imagem: colada (reserva)"; }
	else { img.hidden = true; img.src = ""; $("prev-src").textContent = "Sem imagem — será enviado só o texto."; }
}
function scheduleThumb() {
	clearTimeout(thumbTimer);
	thumbTimer = setTimeout(fetchThumbForPreview, 700);
}
async function fetchThumbForPreview() {
	const link = firstUrl($("text").value);
	if (!link) { lastThumb = null; updatePreview(); return; }
	try {
		const { image } = await api(`/api/thumb?url=${encodeURIComponent(link)}`);
		lastThumb = image || null;
	} catch { lastThumb = null; }
	updatePreview();
}

// ---- Agendar / editar ----
// O mesmo formulário serve para criar uma mensagem nova (qualquer tipo: bom
// dia, cupom, aviso, com ou sem link — link nunca é obrigatório) e para
// corrigir uma já agendada, sem precisar excluir e reescrever do zero.
$("btn-schedule").addEventListener("click", async () => {
	$("sched-msg").textContent = "";
	try {
		if (!connected) throw new Error("Conecte o WhatsApp primeiro.");
		const sel = $("group");
		const groupJid = sel.value;
		const groupName = sel.selectedOptions[0]?.dataset.name || groupJid;
		const text = $("text").value.trim();
		const dt = $("scheduledAt").value;
		if (!groupJid) throw new Error("Escolha o grupo.");
		if (!text && !pastedImage && !lastThumb) throw new Error("Escreva a mensagem ou cole uma imagem.");
		if (!dt) throw new Error("Escolha a data e hora.");
		const scheduledAt = new Date(dt).getTime();
		const body = JSON.stringify({ text, imageData: pastedImage, groupJid, groupName, scheduledAt });
		if (editingId) {
			await api(`/api/messages/${editingId}`, { method: "PUT", body });
			toast("Edição salva! 💾");
		} else {
			await api("/api/messages", { method: "POST", body });
			toast("Mensagem agendada! 📅");
		}
		cancelEdit();
		loadList();
	} catch (e) {
		$("sched-msg").innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
	}
});

/** Carrega uma mensagem existente no formulário para corrigir algo nela. */
function editMsg(m) {
	editingId = m.id;
	if (groupsLoaded) $("group").value = m.groupJid;
	$("text").value = m.text || "";
	setPastedImage(m.imageData || null);
	lastThumb = m.imageUrl || null;
	const d = new Date(m.scheduledAt);
	const pad = (n) => String(n).padStart(2, "0");
	$("scheduledAt").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	$("btn-schedule").textContent = "💾 Salvar edição";
	$("btn-cancel-edit").hidden = false;
	$("sched-msg").textContent = "";
	updatePreview();
	$("schedule-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

function cancelEdit() {
	editingId = null;
	$("text").value = ""; $("scheduledAt").value = ""; setPastedImage(null); lastThumb = null; updatePreview();
	$("btn-schedule").textContent = "📅 Agendar disparo";
	$("btn-cancel-edit").hidden = true;
	$("sched-msg").textContent = "";
}
$("btn-cancel-edit").addEventListener("click", cancelEdit);

// ---- Lista (abas Agendadas / Enviadas) ----
$("btn-refresh").addEventListener("click", loadList);
document.querySelectorAll(".tab2[data-tab]").forEach((t) => t.addEventListener("click", () => {
	listTab = t.dataset.tab;
	document.querySelectorAll(".tab2[data-tab]").forEach((x) => x.classList.toggle("active", x === t));
	loadList();
}));
const isSent = (m) => m.status === "sent";
async function loadList() {
	const box = $("list");
	try {
		const { messages } = await api("/api/messages");
		const sent = messages.filter(isSent);
		const pending = messages.filter((m) => !isSent(m)); // agendadas + falhas
		$("cnt-pending").textContent = pending.length;
		$("cnt-sent").textContent = sent.length;
		const rows = listTab === "sent" ? sent : pending;
		if (!rows.length) {
			box.innerHTML = `<div class="empty">${listTab === "sent" ? "✅ Nenhuma mensagem enviada ainda." : "📭 Nenhuma mensagem agendada."}</div>`;
			return;
		}
		// Enviadas: mais recentes primeiro (pela hora de envio).
		if (listTab === "sent") rows.sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));
		box.innerHTML = "";
		rows.forEach((m) => box.appendChild(renderMsg(m)));
	} catch (e) { box.innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
}
function renderMsg(m) {
	const div = document.createElement("div");
	div.className = "item";
	const when = new Date(m.scheduledAt).toLocaleString("pt-BR");
	const sentWhen = m.sentAt ? new Date(m.sentAt).toLocaleString("pt-BR") : null;
	const hasImg = m.imageData || m.imageUrl || firstUrl(m.text);
	const retrying = m.status === "pending" && m.retries > 0;
	div.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
			<strong>${esc(m.groupName)}</strong>
			<span class="pill ${m.status}">${statusLabel(m.status)}</span>
		</div>
		<div class="meta">${sentWhen ? `<span>📤 Enviada: ${sentWhen}</span>` : `<span>🕒 ${when}</span>`}${hasImg ? "<span>🖼️ com imagem</span>" : ""}${retrying ? `<span>🔁 tentativa ${m.retries}/3</span>` : ""}${m.error ? `<span style="color:var(--danger)">${esc(m.error)}</span>` : ""}</div>
		<pre>${waFormat(m.text || "(somente imagem)")}</pre>`;
	const actions = document.createElement("div");
	actions.className = "actions";
	if (m.status === "pending" || m.status === "failed") {
		actions.appendChild(mkBtn("✏️ Editar", "ghost small", () => editMsg(m)));
		actions.appendChild(mkBtn("Enviar agora", "ghost small", () => sendNow(m.id)));
	}
	actions.appendChild(mkBtn("Excluir", "danger small", () => remove(m.id)));
	div.appendChild(actions);
	return div;
}
function mkBtn(l, c, fn) { const b = document.createElement("button"); b.className = "btn " + c; b.textContent = l; b.onclick = fn; return b; }
function statusLabel(s) { return { pending: "Agendada", sent: "Enviada", failed: "Falhou", canceled: "Cancelada" }[s] || s; }
async function sendNow(id) {
	try { await api(`/api/messages/${id}/send-now`, { method: "POST" }); toast("Enviada!"); loadList(); }
	catch (e) { toast(e.message); loadList(); }
}
async function remove(id) {
	if (!confirm("Excluir esta mensagem?")) return;
	await api(`/api/messages/${id}`, { method: "DELETE" });
	if (editingId === id) cancelEdit();
	toast("Excluída"); loadList();
}

// ---- Loop ----
updatePreview();
loadStatus(); loadList();
setInterval(loadStatus, 3000);
setInterval(loadList, 10000);
