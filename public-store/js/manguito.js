// Manguito Pro — chat con IA de liordark.com (prueba privada).
// Habla con /api/store/ai (ver src/routes/manguito.routes.ts). El modelo lo
// elige el servidor; aquí solo se escribe, se suben imágenes (achicadas
// para gastar menos) y se muestra la respuesta a medida que llega.
(function () {
  "use strict";

  const API = "/api/store/ai";
  const MAX_IMAGES = 4;
  const IMG_MAX_SIDE = 1568;          // más grande no mejora y gasta más tokens
  const UPLOAD_MAX_BYTES = 900 * 1024; // el servidor web acepta hasta ~1 MB por pedido

  const $ = id => document.getElementById(id);
  const state = {
    convId: null,
    conversations: [],
    streaming: false,
    controller: null,
    pending: [],   // { key, url (vista previa), id (subida), loading }
  };

  // ── Utilidades ──
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let toastTimer = null;
  function toast(msg) {
    const el = $("mg-toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* nada */ }
      ta.remove();
    }
    toast("✓ Copiado");
  }

  async function api(path, opts) {
    const res = await fetch(API + path, { credentials: "include", cache: "no-store", ...(opts || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.message || "Algo falló. Intenta de nuevo."); e.status = res.status; throw e; }
    return data;
  }

  // ── Markdown seguro (todo se escapa antes de dar formato) ──
  function inline(s) {
    return s.split(/(`[^`\n]+`)/g).map(part => {
      if (/^`[^`\n]+`$/.test(part)) return "<code>" + part.slice(1, -1) + "</code>";
      return part
        .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(¿¡])\*([^*\n]+?)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
        .replace(/(^|[\s(])_([^_\n]+?)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    }).join("");
  }
  const isFence = l => /^\s*```/.test(l);
  const isUl = l => /^\s*[-*+]\s+/.test(l);
  const isOl = l => /^\s*\d+[.)]\s+/.test(l);
  const isTableRow = l => /^\s*\|.*\|\s*$/.test(l);
  const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const isBlockStart = l => isFence(l) || isUl(l) || isOl(l) || /^#{1,4}\s/.test(l) || /^>\s?/.test(l) || isTableRow(l);
  const cells = l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => inline(esc(c.trim())));

  function md(src) {
    const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isFence(line)) {
        const lang = line.replace(/^\s*```/, "").trim();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<div class="mg-code"><div class="mg-code-head"><span>' + esc(lang || "código") +
          '</span><button type="button" data-copy-code>Copiar</button></div><pre><code>' + esc(buf.join("\n")) + "</code></pre></div>");
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { const n = h[1].length + 1; out.push(`<h${n}>${inline(esc(h[2]))}</h${n}>`); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
      if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && isTableRow(lines[i])) { rows.push(cells(lines[i])); i++; }
        out.push('<div class="mg-table"><table><thead><tr>' + head.map(c => "<th>" + c + "</th>").join("") + "</tr></thead><tbody>" +
          rows.map(r => "<tr>" + r.map(c => "<td>" + c + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>");
        continue;
      }
      if (isUl(line) || isOl(line)) {
        const ordered = isOl(line);
        const items = [];
        while (i < lines.length && (ordered ? isOl(lines[i]) : isUl(lines[i]))) {
          items.push(inline(esc(lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, ""))));
          i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !isUl(lines[i]) && !isOl(lines[i])) {
            items[items.length - 1] += "<br>" + inline(esc(lines[i].trim())); i++;
          }
        }
        const tag = ordered ? "ol" : "ul";
        out.push(`<${tag}>` + items.map(t => "<li>" + t + "</li>").join("") + `</${tag}>`);
        continue;
      }
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(inline(esc(lines[i].replace(/^>\s?/, "")))); i++; }
        out.push("<blockquote>" + buf.join("<br>") + "</blockquote>");
        continue;
      }
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { buf.push(lines[i]); i++; }
      out.push("<p>" + buf.map(l => inline(esc(l))).join("<br>") + "</p>");
    }
    return out.join("");
  }

  // ── Mensajes ──
  const COPY_IC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

  function userMessageEl(m) {
    const el = document.createElement("div");
    el.className = "mg-msg user";
    const imgs = (m.images || []).map(u => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Imagen enviada" loading="lazy"></a>`).join("");
    el.innerHTML = (imgs ? `<div class="mg-msg-imgs">${imgs}</div>` : "") +
      (m.text ? `<div class="mg-bubble">${esc(m.text)}</div>` : "") +
      (m.text ? `<div class="mg-meta"><button class="mg-act" type="button" data-copy>${COPY_IC}Copiar</button></div>` : "");
    el._raw = m.text || "";
    return el;
  }

  function assistantMessageEl(m) {
    const el = document.createElement("div");
    el.className = "mg-msg assistant";
    el.innerHTML = '<div class="mg-answer"></div><div class="mg-meta"></div>';
    setAssistant(el, m);
    return el;
  }

  function setAssistant(el, m) {
    el._raw = m.text || "";
    const answer = el.querySelector(".mg-answer");
    if (m.typing && !m.text) answer.innerHTML = '<span class="mg-typing" aria-label="Pensando"><i></i><i></i><i></i></span>';
    else answer.innerHTML = md(m.text) || "";
    let note = "";
    if (m.status === "stopped") note = "Respuesta detenida.";
    if (m.status === "error") note = m.error || "No se pudo responder. Intenta de nuevo.";
    if (note) answer.insertAdjacentHTML("beforeend", `<div class="mg-note">${esc(note)}</div>`);
    const meta = el.querySelector(".mg-meta");
    meta.innerHTML = (m.label ? `<span class="mg-tier" title="Elegido automáticamente">${esc(m.label)}</span>` : "") +
      (!m.typing && m.text ? `<button class="mg-act" type="button" data-copy>${COPY_IC}Copiar</button>` : "");
  }

  function scrollToEnd(force) {
    const t = $("mg-thread");
    if (force || t.scrollHeight - t.scrollTop - t.clientHeight < 160) t.scrollTop = t.scrollHeight;
  }

  function renderMessages(list) {
    const box = $("mg-messages");
    box.innerHTML = "";
    for (const m of list) box.appendChild(m.role === "user" ? userMessageEl(m) : assistantMessageEl(m));
    $("mg-hello").hidden = list.length > 0;
    scrollToEnd(true);
  }

  // Copiar respuesta / código (delegado)
  document.addEventListener("click", e => {
    const code = e.target.closest("[data-copy-code]");
    if (code) { copyText(code.closest(".mg-code").querySelector("pre").textContent); return; }
    const btn = e.target.closest("[data-copy]");
    if (btn) copyText(btn.closest(".mg-msg")._raw || "");
  });

  // ── Conversaciones ──
  function renderConversations() {
    const ul = $("mg-conv-list");
    ul.innerHTML = state.conversations.map(c =>
      `<li class="${c.id === state.convId ? "active" : ""}" data-id="${c.id}">` +
      `<button class="mg-conv" type="button" data-open="${c.id}">${esc(c.title || "Conversación")}</button>` +
      `<button class="mg-conv-del" type="button" data-del="${c.id}" aria-label="Borrar"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button></li>`
    ).join("");
    $("mg-conv-empty").hidden = state.conversations.length > 0;
  }

  async function loadConversations() {
    try { state.conversations = (await api("/conversations")).conversations || []; } catch { state.conversations = []; }
    renderConversations();
  }

  async function openConversation(id) {
    if (state.streaming) return;
    closeSide();
    try {
      const data = await api("/conversations/" + id);
      state.convId = data.conversation.id;
      $("mg-title").textContent = data.conversation.title || "Manguito Pro";
      renderMessages(data.messages || []);
      renderConversations();
      try { localStorage.setItem("mg_conv", String(state.convId)); } catch { /* sin storage */ }
    } catch (err) { toast(err.message); }
  }

  function newConversation() {
    if (state.streaming) return;
    state.convId = null;
    $("mg-title").textContent = "Manguito Pro";
    renderMessages([]);
    renderConversations();
    closeSide();
    try { localStorage.removeItem("mg_conv"); } catch { /* sin storage */ }
    $("mg-input").focus();
  }

  async function deleteConversation(id) {
    if (!confirm("¿Borrar esta conversación?")) return;
    try {
      await api("/conversations/" + id, { method: "DELETE" });
      state.conversations = state.conversations.filter(c => c.id !== id);
      if (state.convId === id) newConversation();
      renderConversations();
    } catch (err) { toast(err.message); }
  }

  $("mg-conv-list").addEventListener("click", e => {
    const del = e.target.closest("[data-del]");
    if (del) { deleteConversation(Number(del.dataset.del)); return; }
    const open = e.target.closest("[data-open]");
    if (open) openConversation(Number(open.dataset.open));
  });
  $("mg-new").addEventListener("click", newConversation);

  // Cajón lateral (celular)
  function openSide() { $("mg-side").classList.add("open"); $("mg-scrim").hidden = false; }
  function closeSide() { $("mg-side").classList.remove("open"); $("mg-scrim").hidden = true; }
  $("mg-side-open").addEventListener("click", openSide);
  $("mg-side-close").addEventListener("click", closeSide);
  $("mg-scrim").addEventListener("click", closeSide);

  // ── Imágenes: achicar en el navegador y subir una por una ──
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { resolve({ img, url }); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("No se pudo leer la imagen.")); };
      img.src = url;
    });
  }

  async function compress(file) {
    const { img, url } = await loadImage(file);
    try {
      let w = img.naturalWidth, h = img.naturalHeight;
      const scale = Math.min(1, IMG_MAX_SIDE / Math.max(w, h));
      w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); // PNG transparente → fondo blanco
      ctx.drawImage(img, 0, 0, w, h);
      let blob = null;
      for (const q of [0.85, 0.75, 0.62, 0.5]) {
        blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", q));
        if (blob && blob.size <= UPLOAD_MAX_BYTES) break;
      }
      if (!blob || blob.size > UPLOAD_MAX_BYTES) throw new Error("La imagen es muy pesada.");
      return blob;
    } finally { URL.revokeObjectURL(url); }
  }

  function renderThumbs() {
    const box = $("mg-thumbs");
    box.hidden = state.pending.length === 0;
    box.innerHTML = state.pending.map(p =>
      `<div class="mg-thumb${p.loading ? " loading" : ""}"><img src="${esc(p.url)}" alt=""><button type="button" data-rm="${p.key}" aria-label="Quitar">✕</button></div>`
    ).join("");
    updateSend();
  }
  $("mg-thumbs").addEventListener("click", e => {
    const rm = e.target.closest("[data-rm]");
    if (!rm) return;
    state.pending = state.pending.filter(p => String(p.key) !== rm.dataset.rm);
    renderThumbs();
  });

  let keySeq = 0;
  async function addImages(files) {
    const list = [...files].filter(f => /^image\//.test(f.type));
    if (!list.length) return;
    for (const file of list) {
      if (state.pending.length >= MAX_IMAGES) { toast(`Máximo ${MAX_IMAGES} imágenes por mensaje.`); break; }
      const p = { key: ++keySeq, url: "", id: null, loading: true };
      state.pending.push(p);
      try {
        const blob = await compress(file);
        p.url = URL.createObjectURL(blob);
        renderThumbs();
        const fd = new FormData();
        fd.append("image", blob, "imagen.jpg");
        const data = await api("/upload", { method: "POST", body: fd });
        p.id = data.id;
        p.loading = false;
      } catch (err) {
        state.pending = state.pending.filter(x => x !== p);
        toast(err.message || "No se pudo subir la imagen.");
      }
      renderThumbs();
    }
  }

  $("mg-file").addEventListener("change", e => { addImages(e.target.files); e.target.value = ""; });

  // Pegar imágenes (Ctrl+V) y arrastrarlas
  document.addEventListener("paste", e => {
    if (!e.clipboardData) return;
    const files = [...e.clipboardData.items].filter(it => it.kind === "file" && /^image\//.test(it.type)).map(it => it.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addImages(files); }
  });
  let dragDepth = 0;
  const main = $("mg-main");
  main.addEventListener("dragenter", e => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { dragDepth++; $("mg-drop").hidden = false; } });
  main.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("mg-drop").hidden = true; });
  main.addEventListener("dragover", e => { if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault(); });
  main.addEventListener("drop", e => {
    dragDepth = 0; $("mg-drop").hidden = true;
    if (e.dataTransfer?.files?.length) { e.preventDefault(); addImages(e.dataTransfer.files); }
  });

  // ── Escribir y enviar ──
  const input = $("mg-input");
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + "px"; }
  function updateSend() {
    const uploading = state.pending.some(p => p.loading);
    $("mg-send").disabled = state.streaming || uploading || (!input.value.trim() && !state.pending.length);
  }
  input.addEventListener("input", () => { autosize(); updateSend(); });
  input.addEventListener("keydown", e => {
    // Enter envía; Shift+Enter (o el celular) hace salto de línea.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !matchMedia("(pointer: coarse)").matches) {
      e.preventDefault();
      if (!$("mg-send").disabled) $("mg-composer").requestSubmit();
    }
  });

  $("mg-sugg").addEventListener("click", e => {
    const b = e.target.closest("[data-prompt]");
    if (!b) return;
    input.value = b.dataset.prompt;
    autosize(); updateSend(); input.focus();
    if (b.dataset.attach) $("mg-file").click();
  });

  function setStreaming(on) {
    state.streaming = on;
    $("mg-send").hidden = on;
    $("mg-stop").hidden = !on;
    updateSend();
  }
  $("mg-stop").addEventListener("click", () => { if (state.controller) state.controller.abort(); });

  $("mg-composer").addEventListener("submit", async e => {
    e.preventDefault();
    if (state.streaming) return;
    const text = input.value.trim();
    const ready = state.pending.filter(p => p.id);
    if (!text && !ready.length) return;

    const images = ready.map(p => p.id);
    const shown = ready.map(p => p.url);
    $("mg-hello").hidden = true;
    $("mg-messages").appendChild(userMessageEl({ text, images: shown }));
    const reply = assistantMessageEl({ text: "", typing: true });
    $("mg-messages").appendChild(reply);
    scrollToEnd(true);
    input.value = ""; autosize();
    state.pending = []; renderThumbs();

    const msg = { text: "", typing: true, label: "", status: "ok" };
    let frame = 0;
    const paint = () => { frame = 0; setAssistant(reply, msg); scrollToEnd(false); };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };

    setStreaming(true);
    state.controller = new AbortController();
    try {
      const res = await fetch(API + "/chat", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: state.convId, text, images }),
        signal: state.controller.signal,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.message || "No se pudo enviar. Intenta de nuevo.");
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === "meta") {
            msg.label = ev.label;
            if (!state.convId) {
              state.convId = ev.conversationId;
              try { localStorage.setItem("mg_conv", String(state.convId)); } catch { /* sin storage */ }
              loadConversations();
              $("mg-title").textContent = (text || "Imagen").slice(0, 60);
            }
            schedule();
          } else if (ev.type === "text") {
            msg.text += ev.text; msg.typing = false; schedule();
          } else if (ev.type === "done") {
            msg.typing = false; msg.status = ev.status;
            if (ev.status === "error") msg.error = ev.message;
          }
        }
      }
      if (msg.typing) { msg.typing = false; }
    } catch (err) {
      msg.typing = false;
      if (err.name === "AbortError") msg.status = "stopped";
      else { msg.status = "error"; msg.error = err.message; }
    } finally {
      state.controller = null;
      setStreaming(false);
      if (frame) cancelAnimationFrame(frame);
      paint();
      loadConversations();
    }
  });

  // ── Arranque: ¿tiene acceso? ──
  function gate(title, text, loginBtn) {
    $("mg-thread").hidden = true;
    $("mg-composer").hidden = true;
    $("mg-gate").hidden = false;
    $("mg-gate-title").textContent = title;
    $("mg-gate-text").textContent = text;
    $("mg-gate-btn").hidden = !loginBtn;
  }

  async function init() {
    let access;
    try { access = await api("/access"); }
    catch (err) {
      if (err.status === 401 || err.status === 403) gate("Inicia sesión", "Para usar Manguito Pro, ingresa con tu celular y tu PIN de liordark.com.", true);
      else gate("Sin conexión", "No pudimos cargar Manguito Pro. Revisa tu internet y recarga la página.", false);
      return;
    }
    if (!access.allowed) { gate("Prueba privada", "Manguito Pro está en prueba privada por ahora. ¡Muy pronto para todos! 🥭", false); return; }
    if (!access.configured) { gate("Casi listo", "Manguito Pro todavía no está conectado. Vuelve en un rato.", false); return; }
    await loadConversations();
    let last = null;
    try { last = Number(localStorage.getItem("mg_conv")) || null; } catch { /* sin storage */ }
    if (last && state.conversations.some(c => c.id === last)) await openConversation(last);
    updateSend();
    if (!matchMedia("(pointer: coarse)").matches) input.focus();
  }

  init();
})();
