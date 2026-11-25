// Manguito Pro — chat con IA de liordark.com.
// Habla con /api/store/ai (ver src/routes/manguito.routes.ts). El modelo lo
// elige el servidor; aquí se escribe, se suben imágenes (achicadas para
// gastar menos), se muestra la respuesta a medida que llega, el saldo
// (plan mensual / créditos), los planes para comprar y los links para
// compartir. Todo texto pasa por MangoMD (escapado) antes de mostrarse.
(function () {
  "use strict";

  const API = "/api/store/ai";
  const MAX_IMAGES = 4;
  const IMG_MAX_SIDE = 1568;          // más grande no mejora y gasta más tokens
  const UPLOAD_MAX_BYTES = 900 * 1024; // el servidor web acepta hasta ~1 MB por pedido
  const PAY_WINDOW_MS = 5 * 60 * 1000;
  const POLL_MS = 4000;
  const POLL_MAX_MS = 15 * 60 * 1000;

  const { md, esc } = window.MangoMD;
  const $ = id => document.getElementById(id);
  const state = {
    convId: null,
    conversations: [],
    streaming: false,
    controller: null,
    pending: [],      // { key, url (vista previa), id (subida), loading }
    authed: false,
    allowed: false,
    store: null,      // planes a la venta
    meter: null,      // saldo del cliente
    view: "chat",
  };

  // ── Utilidades ──
  let toastTimer = null;
  function toast(msg) {
    const el = $("mg-toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  async function copyText(text, msg) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* nada */ }
      ta.remove();
    }
    toast(msg || "✓ Copiado");
  }

  async function api(path, opts) {
    const res = await fetch((path.startsWith("/api/") ? "" : API) + path, { credentials: "include", cache: "no-store", ...(opts || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.message || "Algo falló. Intenta de nuevo."); e.status = res.status; e.data = data; throw e; }
    return data;
  }
  const jsonBody = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

  const usd = n => "US$ " + (Number(n) || 0).toFixed(2);
  const soles = n => "S/ " + (Number(n) % 1 ? Number(n).toFixed(2) : String(Number(n)));
  const hhmm = ms => new Date(ms).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
  const dayLabel = ms => new Date(ms).toLocaleDateString("es-PE", { day: "numeric", month: "short" });
  const dayTime = ms => dayLabel(ms) + ", " + hhmm(ms);
  const sqlDate = s => new Date(String(s || "").replace(" ", "T") + "Z").getTime();
  const pct = (used, limit) => limit > 0 ? Math.max(0, Math.min(100, Math.round(used / limit * 100))) : 100;

  // Anchos de las barras (la política de la página no deja estilos en el HTML).
  function applyWidths(root) { root.querySelectorAll("[data-w]").forEach(i => { i.style.width = i.dataset.w + "%"; }); }

  // ── Ventana genérica ──
  let modalOnClose = null;
  function openModal(html, onClose) {
    if (modalOnClose) { const f = modalOnClose; modalOnClose = null; f(); }
    // Cuerpo nuevo cada vez: así no quedan escuchas de la ventana anterior.
    const old = $("mg-modal-body");
    const body = old.cloneNode(false);
    old.replaceWith(body);
    body.innerHTML = html;
    $("mg-modal").hidden = false;
    modalOnClose = onClose || null;
    return body;
  }
  function closeModal() {
    $("mg-modal").hidden = true;
    $("mg-modal-body").innerHTML = "";
    if (modalOnClose) { const f = modalOnClose; modalOnClose = null; f(); }
  }
  $("mg-modal-x").addEventListener("click", closeModal);
  $("mg-modal").addEventListener("click", e => { if (e.target.id === "mg-modal") closeModal(); });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (!$("mg-modal").hidden) closeModal();
    else if (!$("mg-menu").hidden) toggleMenu(false);
  });

  // ── Mensajes ──
  const IC = {
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  };

  function userMessageEl(m) {
    const el = document.createElement("div");
    el.className = "mg-msg user";
    const imgs = (m.images || []).map(u => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Imagen enviada" loading="lazy"></a>`).join("");
    el.innerHTML = (imgs ? `<div class="mg-msg-imgs">${imgs}</div>` : "") +
      (m.text ? `<div class="mg-bubble">${esc(m.text)}</div>` : "") +
      (m.text ? `<div class="mg-meta"><button class="mg-act" type="button" data-copy>${IC.copy}Copiar</button></div>` : "");
    el._raw = m.text || "";
    return el;
  }

  function assistantMessageEl(m) {
    const el = document.createElement("div");
    el.className = "mg-msg assistant";
    el.innerHTML = '<div class="mg-who"><img src="/assets/logo.webp" alt=""><b>Manguito</b><span class="mg-tier" hidden></span></div>' +
      '<div class="mg-answer"></div><div class="mg-meta"></div>';
    setAssistant(el, m);
    return el;
  }

  function setAssistant(el, m) {
    el._raw = m.text || "";
    if (m.id) el.dataset.id = m.id;
    const tier = el.querySelector(".mg-tier");
    tier.hidden = !m.label;
    tier.textContent = m.label || "";
    const answer = el.querySelector(".mg-answer");
    if (m.typing && !m.text) answer.innerHTML = '<span class="mg-typing" aria-label="Pensando"><i></i><i></i><i></i></span>';
    else answer.innerHTML = md(m.text) || "";
    if (m.status === "stopped") answer.insertAdjacentHTML("beforeend", '<div class="mg-note">Respuesta detenida.</div>');
    if (m.status === "error") {
      const buy = m.code && /^(no_balance|no_access|plan_limit)$/.test(m.code) && state.store && state.store.enabled;
      answer.insertAdjacentHTML("beforeend", `<div class="mg-note">${esc(m.error || "No se pudo responder. Intenta de nuevo.")}` +
        (buy ? ` <button type="button" data-open-plans>${m.code === "no_access" ? "Ver planes" : "Recargar"}</button>` : "") + "</div>");
    }
    const meta = el.querySelector(".mg-meta");
    meta.innerHTML = !m.typing && m.text
      ? `<button class="mg-act" type="button" data-copy>${IC.copy}Copiar</button><button class="mg-act" type="button" data-share-msg>${IC.share}Compartir</button>`
      : "";
  }

  function scrollToEnd(force) {
    const t = $("mg-thread");
    if (force || t.scrollHeight - t.scrollTop - t.clientHeight < 160) t.scrollTop = t.scrollHeight;
  }

  function renderMessages(list, conv) {
    const box = $("mg-messages");
    box.innerHTML = "";
    if (conv && conv.summary && conv.compacted > 0) {
      const d = document.createElement("details");
      d.className = "mg-summary";
      d.innerHTML = `<summary>📦 ${conv.compacted} mensaje(s) anteriores resumidos para ahorrar espacio</summary><div>${esc(conv.summary)}</div>`;
      box.appendChild(d);
    }
    for (const m of list) box.appendChild(m.role === "user" ? userMessageEl(m) : assistantMessageEl(m));
    $("mg-hello").hidden = list.length > 0 || !!(conv && conv.compacted > 0);
    $("mg-share").hidden = !state.convId;
    scrollToEnd(true);
  }

  // Imagen que ya se borró (las imágenes duran 14 días): aviso en su lugar.
  document.addEventListener("error", e => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.closest(".mg-msg-imgs")) return;
    const span = document.createElement("span");
    span.className = "mg-img-gone";
    span.textContent = "Imagen vencida (se borran a los 14 días)";
    (img.closest("a") || img).replaceWith(span);
  }, true);

  // Copiar / compartir / planes (delegado)
  document.addEventListener("click", e => {
    const code = e.target.closest("[data-copy-code]");
    if (code) { copyText(code.closest(".mg-code").querySelector("pre").textContent); return; }
    const btn = e.target.closest("[data-copy]");
    if (btn) { copyText(btn.closest(".mg-msg")._raw || ""); return; }
    const sh = e.target.closest("[data-share-msg]");
    if (sh) { openShare(sh.closest(".mg-msg")); return; }
    if (e.target.closest("[data-open-plans]")) { showPlans(true); return; }
  });

  // ── Conversaciones (agrupadas por fecha, con buscador) ──
  function groupOf(ms) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= start) return "Hoy";
    if (ms >= start - 864e5) return "Ayer";
    if (ms >= start - 7 * 864e5) return "Últimos 7 días";
    if (ms >= start - 30 * 864e5) return "Últimos 30 días";
    return "Anteriores";
  }

  function renderConversations() {
    const q = $("mg-search").value.trim().toLowerCase();
    const list = state.conversations.filter(c => !q || String(c.title || "").toLowerCase().includes(q));
    let html = "", last = "";
    for (const c of list) {
      const g = groupOf(sqlDate(c.updatedAt));
      if (g !== last) { html += `<p class="mg-group">${g}</p>`; last = g; }
      html += `<div class="mg-conv-row${c.id === state.convId ? " active" : ""}">` +
        `<button class="mg-conv" type="button" data-open="${c.id}" title="${esc(c.title || "Conversación")}">${esc(c.title || "Conversación")}</button>` +
        `<button class="mg-conv-del" type="button" data-del="${c.id}" aria-label="Borrar">${IC.trash}</button></div>`;
    }
    $("mg-conv-nav").innerHTML = html;
    $("mg-conv-empty").hidden = state.conversations.length > 0;
    $("mg-conv-empty").textContent = "Aún no tienes conversaciones.";
    if (state.conversations.length && !list.length) { $("mg-conv-empty").hidden = false; $("mg-conv-empty").textContent = "Sin resultados."; }
  }
  $("mg-search").addEventListener("input", renderConversations);

  async function loadConversations() {
    try { state.conversations = (await api("/conversations")).conversations || []; } catch { state.conversations = []; }
    renderConversations();
  }

  async function openConversation(id) {
    if (state.streaming) return;
    closeSide();
    showView("chat");
    try {
      const data = await api("/conversations/" + id);
      state.convId = data.conversation.id;
      $("mg-title").textContent = data.conversation.title || "Manguito Pro";
      renderMessages(data.messages || [], data.conversation);
      renderConversations();
      try { localStorage.setItem("mg_conv", String(state.convId)); } catch { /* sin storage */ }
    } catch (err) { toast(err.message); }
  }

  function newConversation() {
    if (state.streaming) return;
    state.convId = null;
    showView("chat");
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

  $("mg-conv-nav").addEventListener("click", e => {
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

  // Menú de la cuenta
  function toggleMenu(open) {
    const m = $("mg-menu");
    const on = open === undefined ? m.hidden : open;
    m.hidden = !on;
    $("mg-menu-btn").setAttribute("aria-expanded", String(on));
  }
  $("mg-menu-btn").addEventListener("click", e => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener("click", e => { if (!$("mg-menu").hidden && !e.target.closest(".mg-account")) toggleMenu(false); });
  $("mg-menu").addEventListener("click", e => {
    const b = e.target.closest("[data-menu]");
    if (!b) return;
    toggleMenu(false);
    closeSide();
    const k = b.dataset.menu;
    if (k === "plans") showPlans(true);
    if (k === "memory") openMemory();
    if (k === "links") openLinks();
    if (k === "wipe") openWipe();
  });

  // ── Vistas: chat / planes / puerta ──
  function showView(v) {
    state.view = v;
    $("mg-thread").hidden = v !== "chat";
    $("mg-composer").hidden = v !== "chat";
    $("mg-plans").hidden = v !== "plans";
    $("mg-gate").hidden = v !== "gate";
    if (v !== "chat") { $("mg-banner").hidden = true; $("mg-share").hidden = true; }
    else { $("mg-share").hidden = !state.convId; renderBanner(); }
  }

  function gate(title, text, loginBtn) {
    showView("gate");
    $("mg-gate-title").textContent = title;
    $("mg-gate-text").textContent = text;
    $("mg-gate-btn").hidden = !loginBtn;
  }

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
    if (state.view !== "chat" || !state.allowed) return;
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
    if (!e.clipboardData || !$("mg-modal").hidden) return;
    const files = [...e.clipboardData.items].filter(it => it.kind === "file" && /^image\//.test(it.type)).map(it => it.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addImages(files); }
  });
  let dragDepth = 0;
  const main = $("mg-main");
  main.addEventListener("dragenter", e => { if (state.view === "chat" && [...(e.dataTransfer?.types || [])].includes("Files")) { dragDepth++; $("mg-drop").hidden = false; } });
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
    const blocked = state.meter && !state.meter.canChat;
    $("mg-send").disabled = state.streaming || blocked || uploading || (!input.value.trim() && !state.pending.length);
  }
  input.addEventListener("input", () => { autosize(); updateSend(); });
  input.addEventListener("keydown", e => {
    // Enter envía; Shift+Enter (o el celular) hace salto de línea.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !matchMedia("(pointer: coarse)").matches) {
      e.preventDefault();
      if (!$("mg-send").disabled) $("mg-composer").requestSubmit();
    }
  });
  if (matchMedia("(pointer: coarse)").matches) $("mg-box-hint").textContent = "";

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
        const err = new Error(d.message || "No se pudo enviar. Intenta de nuevo.");
        err.code = d.code || "";
        throw err;
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
              $("mg-share").hidden = false;
            }
            schedule();
          } else if (ev.type === "text") {
            msg.text += ev.text; msg.typing = false; schedule();
          } else if (ev.type === "done") {
            msg.typing = false; msg.status = ev.status; msg.id = ev.messageId;
            if (ev.status === "error") msg.error = ev.message;
          }
        }
      }
      if (msg.typing) { msg.typing = false; }
    } catch (err) {
      msg.typing = false;
      if (err.name === "AbortError") msg.status = "stopped";
      else { msg.status = "error"; msg.error = err.message; msg.code = err.code || ""; }
    } finally {
      state.controller = null;
      setStreaming(false);
      if (frame) cancelAnimationFrame(frame);
      paint();
      loadConversations();
      refreshMeter();
    }
  });

  // ── Saldo: medidor de la barra lateral y avisos ──
  function barRow(label, used, limit, extra) {
    const p = pct(used, limit);
    return `<div class="mg-bar-row" title="${esc(extra || "")}"><span>${label}</span><div class="mg-bar"><i class="${p >= 85 ? "high" : p >= 60 ? "mid" : ""}" data-w="${p}"></i></div><span>${p}%</span></div>`;
  }

  function renderMeter(m) {
    state.meter = m;
    const el = $("mg-meter");
    let html = "", name = "";
    if (m && m.plan) {
      const p = m.plan;
      name = "Plan mensual";
      html += `<div class="mg-meter-head"><b>Plan mensual</b><span>vence ${dayLabel(p.endsAt)}</span></div>` +
        `<div class="mg-bars">` +
        barRow((state.store && state.store.windowHours || 3) + " horas", p.window.used, p.window.limit, p.window.resetsAt ? "Se renueva a las " + hhmm(p.window.resetsAt) : "Empieza con tu próximo mensaje") +
        barRow("Semana", p.week.used, p.week.limit, "Se renueva el " + dayTime(p.week.resetsAt)) +
        barRow("Mes", p.cycle.used, p.cycle.limit, "Se renueva el " + dayTime(p.cycle.resetsAt)) +
        `</div>`;
    }
    if (m && m.credits) {
      const c = m.credits;
      name = name ? name + " + créditos" : "Créditos";
      const speed = c.balance <= 0.003 ? `<div class="mg-meter-note warn">Sin créditos</div>`
        : c.hoursLeft !== null && c.hoursLeft < 72
        ? `<div class="mg-meter-note warn">⚡ A tu ritmo de hoy: ~${c.hoursLeft < 1 ? "menos de 1 h" : Math.round(c.hoursLeft) + " h"}</div>`
        : `<div class="mg-meter-note">≈ ${c.estMessages} mensajes</div>`;
      html += (html ? `<div class="mg-gap"></div>` : "") +
        `<div class="mg-meter-head"><b>Créditos</b><span>sin límite de tiempo</span></div><div class="mg-meter-big">${usd(c.balance)}</div>` + speed;
    }
    if (m && !m.plan && !m.credits && m.free) {
      name = "Acceso de prueba";
      html += `<div class="mg-meter-head"><b>Acceso de prueba</b><span></span></div><div class="mg-bars">${barRow("Mes", m.free.monthPct, 100)}</div>`;
    }
    el.innerHTML = html;
    applyWidths(el);
    el.hidden = !html;
    $("mg-plan-name").textContent = name || "Sin plan";
    renderBanner();
    updateSend();
  }

  let refreshTimer = null;
  function renderBanner() {
    const m = state.meter;
    const b = $("mg-banner");
    const foot = $("mg-foot");
    const FOOT = "Manguito Pro puede equivocarse. Revisa la información importante.";
    foot.textContent = FOOT; foot.classList.remove("warn");
    clearTimeout(refreshTimer);
    if (!m || state.view !== "chat") { b.hidden = true; return; }
    const canBuy = state.store && state.store.enabled;
    let text = "", cls = "", btn = "";
    if (!m.canChat && m.block) {
      text = m.block.message; cls = "block";
      if (canBuy && m.block.code !== "free_limit") btn = m.block.code === "no_access" ? "Ver planes" : "Recargar";
      refreshTimer = setTimeout(refreshMeter, 60e3); // se revisa solo cada minuto
    } else if (m.plan && m.plan.endsAt - Date.now() < 3 * 864e5) {
      text = `⏰ Tu plan vence el ${dayTime(m.plan.endsAt)}. Renuévalo con Yape para no quedarte sin Manguito.`;
      if (canBuy) btn = "Renovar";
    } else if (m.plan && m.source === "plan" && m.plan.window.resetsAt && pct(m.plan.window.used, m.plan.window.limit) >= 75) {
      text = `⚡ Vas rápido: usaste ${pct(m.plan.window.used, m.plan.window.limit)}% de estas ${state.store ? state.store.windowHours : 3} horas (se renueva a las ${hhmm(m.plan.window.resetsAt)}).`;
    } else if (m.plan && m.source === "plan" && pct(m.plan.week.used, m.plan.week.limit) >= 80) {
      text = `Te queda poco de esta semana (se renueva el ${dayTime(m.plan.week.resetsAt)}).`;
    } else if (m.credits && m.source === "credits" && m.credits.estMessages <= 20) {
      text = `Te quedan ≈ ${m.credits.estMessages} mensajes de créditos.`; if (canBuy) btn = "Recargar";
    } else if (m.free && m.source === "free" && typeof m.free.burstLeft === "number" && m.free.burstLeft <= 5) {
      foot.textContent = `☕ Te ${m.free.burstLeft === 1 ? "queda 1 mensaje" : `quedan ${m.free.burstLeft} mensajes`} antes de una pausa de 1 hora.`;
      foot.classList.add("warn");
    }
    b.hidden = !text;
    b.className = "mg-banner" + (cls ? " " + cls : "");
    b.innerHTML = text ? `<span>${esc(text)}</span>${btn ? `<button type="button" data-open-plans>${btn}</button>` : ""}` : "";
  }

  async function refreshMeter() {
    try { renderMeter(await api("/meter")); } catch { /* sin red */ }
  }

  $("mg-meter").addEventListener("click", openUsage);

  function usageLine(label, used, limit, note) {
    const p = pct(used, limit);
    return `<div class="mg-usage-line"><div><b>${label}</b><span>${p}% usado</span></div>` +
      `<div class="mg-bar"><i class="${p >= 85 ? "high" : p >= 60 ? "mid" : ""}" data-w="${p}"></i></div><small>${note}</small></div>`;
  }

  function openUsage() {
    closeSide();
    const m = state.meter;
    if (!m) return;
    let html = `<h2 id="mg-modal-title">Mi saldo</h2><p class="mg-muted">Así vas con tu Manguito Pro. Las respuestas difíciles (Opus) gastan más que las simples.</p>`;
    if (m.plan) {
      const p = m.plan, w = state.store ? state.store.windowHours : 3;
      html += `<div class="mg-usage-block"><h3>Plan mensual · vence ${dayTime(p.endsAt)}</h3>` +
        usageLine(`Cada ${w} horas`, p.window.used, p.window.limit, p.window.resetsAt ? "Se renueva a las " + hhmm(p.window.resetsAt) : `Empieza con tu próximo mensaje y dura ${w} horas.`) +
        usageLine("Esta semana", p.week.used, p.week.limit, "Se renueva el " + dayTime(p.week.resetsAt)) +
        usageLine("Este mes", p.cycle.used, p.cycle.limit, `${usd(Math.max(0, p.cycle.limit - p.cycle.used))} de ${usd(p.cycle.limit)} disponibles · se renueva el ${dayTime(p.cycle.resetsAt)}`) +
        `</div>`;
    }
    if (m.credits) {
      const c = m.credits;
      html += `<div class="mg-usage-block"><h3>Créditos</h3><div class="mg-meter-big">${usd(c.balance)}</div>` +
        `<p class="mg-muted mg-m0">≈ ${c.estMessages} mensajes más. En las últimas 24 h gastaste ${usd(c.spent24h)} (${c.messages24h} mensajes)` +
        (c.hoursLeft !== null ? `: a ese ritmo te duran ~${c.hoursLeft < 1 ? "menos de 1 hora" : Math.round(c.hoursLeft) + " horas"}.` : ".") +
        ` Los créditos no tienen límite de tiempo.</p></div>`;
    }
    if (m.free) html += `<div class="mg-usage-block"><h3>Acceso de prueba</h3>${usageLine("Este mes", m.free.monthPct, 100, "Se renueva el 1 del próximo mes.")}</div>`;
    if (!m.canChat && m.block) html += `<p class="mg-err">${esc(m.block.message)}</p>`;
    const canBuy = state.store && state.store.enabled;
    html += `<div class="mg-modal-actions">${canBuy ? `<button class="mg-btn-ghost" type="button" data-open-plans>Planes y recargas</button>` : ""}<button class="mg-btn-solid" type="button" data-close>Listo</button></div>`;
    const body = openModal(html);
    applyWidths(body);
    body.querySelector("[data-close]").addEventListener("click", closeModal);
    const op = body.querySelector("[data-open-plans]");
    if (op) op.addEventListener("click", () => { closeModal(); showPlans(true); });
  }

  // ── Planes y compra ──
  function renderPlans() {
    const s = state.store;
    const grid = $("mg-plan-grid");
    if (!s || !s.enabled) { grid.innerHTML = `<p class="mg-muted">Por ahora no hay planes a la venta. Vuelve pronto 🥭</p>`; return; }
    const buyLabel = state.authed ? null : "Inicia sesión para comprar";
    let html = "";
    // Pagó antes y no renovó: sin acceso, pero su historial sigue guardado.
    const lp = !state.allowed && state.lapsed;
    if (lp) {
      const when = lp.planEnd && lp.planEnd < Date.now() ? `Tu plan venció el ${dayLabel(lp.planEnd).replace(/\.$/, "")}.` : "Se acabó tu saldo.";
      html += `<div class="mg-lapsed">⏰ ${when} ${lp.conversations ? `Tus ${lp.conversations} conversación(es) siguen guardadas: ` : ""}renueva y continúas donde lo dejaste.</div>`;
    }
    if (s.monthly) {
      const m = s.monthly;
      html += `<div class="mg-plan featured"><span class="mg-plan-tag">Más elegido</span>
        <h3>Mensual</h3><p class="mg-plan-desc">Para usarlo todos los días sin sustos.</p>
        <div class="mg-price">${m.basePrice && m.basePrice > m.priceSoles ? `<s>${soles(m.basePrice)}</s> ` : ""}${soles(m.priceSoles)} <small>/ 30 días</small></div>
        <ul>
          <li>${usd(m.usd)} de uso al mes</li>
          <li>Uso restringido por horas para cuidar tus créditos</li>
          <li>Si llegas al límite, esperas un rato y sigues (o usas créditos)</li>
          <li>Modelos de Claude automáticos: usa el mejor en cada tarea</li>
          <li>Uso personal y privado: nadie más tiene acceso a tus chats</li>
        </ul>
        <button class="mg-btn-solid" type="button" data-buy="plan">${buyLabel || "Elegir plan mensual"}</button></div>`;
    }
    if (s.packs && s.packs.length) {
      html += `<div class="mg-plan"><h3>Créditos</h3><p class="mg-plan-desc">Paga solo lo que usas, sin límites de tiempo.</p>
        <div class="mg-packs">${s.packs.map((p, i) => `<label class="mg-pack"><span><input type="radio" name="mg-pack" value="${i}"${i === 0 ? " checked" : ""}> ${p.basePrice && p.basePrice > p.priceSoles ? `<s>${soles(p.basePrice)}</s> ` : ""}<b>${soles(p.priceSoles)}</b></span><span>${usd(p.usd)} de saldo</span></label>`).join("")}</div>
        <ul>
          <li>Úsalo cuando quieras: hoy, mañana o en un solo día</li>
          <li>Recarga cuando se acabe</li>
          <li>Ves cuánto te queda y a qué ritmo gastas</li>
          <li>Uso personal y privado: nadie más tiene acceso a tus chats</li>
        </ul>
        <button class="mg-btn-solid" type="button" data-buy="credits">${buyLabel || "Comprar créditos"}</button></div>`;
    }
    grid.innerHTML = html;
    const note = $("mg-plans-discount");
    if (note) { note.hidden = !(s.discount > 0); note.textContent = s.discount > 0 ? `🏪 Eres mayorista: tienes S/ ${s.discount} menos en cada plan.` : ""; }
  }

  function showPlans(withBack) {
    document.body.classList.toggle("mg-guest", !state.allowed);
    renderPlans();
    $("mg-plans-back").hidden = !(withBack && state.allowed);
    showView("plans");
    closeSide();
  }
  $("mg-plans-back").addEventListener("click", () => { showView("chat"); if (location.hash === "#planes") history.replaceState(null, "", location.pathname); });

  $("mg-plan-grid").addEventListener("click", e => {
    const b = e.target.closest("[data-buy]");
    if (!b) return;
    if (!state.authed) {
      try { sessionStorage.setItem("mg_return", "/manguito/#planes"); } catch { /* sin storage */ }
      location.assign("/#manguito");
      return;
    }
    const kind = b.dataset.buy;
    const pack = kind === "credits" ? Number((document.querySelector('input[name="mg-pack"]:checked') || {}).value || 0) : 0;
    startCheckout(kind, pack);
  });

  let pollTimer = null, countdownTimer = null;
  function stopPay() { clearInterval(pollTimer); pollTimer = null; clearInterval(countdownTimer); countdownTimer = null; }

  async function startCheckout(kind, pack) {
    stopPay();
    openModal(`<h2 id="mg-modal-title">Preparando tu pago…</h2><div class="mg-pay-wait"><span class="mg-spin"></span></div>`, stopPay);
    let order;
    try { order = await api("/buy", jsonBody("POST", { kind, pack })); }
    catch (err) {
      const body = openModal(`<h2 id="mg-modal-title">No se pudo crear el pago</h2><p class="mg-err">${esc(err.message)}</p>
        <div class="mg-modal-actions"><button class="mg-btn-solid" type="button" data-retry>Intentar de nuevo</button></div>`, stopPay);
      body.querySelector("[data-retry]").addEventListener("click", () => startCheckout(kind, pack));
      return;
    }
    let yape = null;
    try {
      const { methods } = await api("/api/store/payment-methods");
      yape = (methods || []).find(m => String(m.name).toLowerCase().includes("yape")) || null;
    } catch { /* sin QR, igual se puede pagar */ }
    const qr = yape && yape.imageUrl && /^\/[^/]/.test(yape.imageUrl) ? `<img class="mg-pay-qr" src="${esc(yape.imageUrl)}" alt="QR de Yape">` : "";
    const what = kind === "plan" ? "Plan mensual" : "Créditos";
    const body = openModal(`
      <h2 id="mg-modal-title">Paga con Yape · ${what}</h2>
      <p class="mg-muted">Yapea <b>exactamente</b> este monto (con los céntimos) y se activa solo:</p>
      <div class="mg-pay-amount"><b>S/ ${esc(order.amount)}</b><button class="mg-mini" type="button" data-copy-amount>Copiar</button></div>
      ${qr}
      ${yape && yape.description ? `<div class="mg-pay-info">${esc(yape.description)}</div>` : ""}
      <div class="mg-pay-wait"><span class="mg-spin"></span><span id="mg-pay-text">Esperando tu pago…</span></div>
      <p class="mg-muted mg-center mg-small">Este monto vale <b id="mg-pay-left">5:00</b> · <a href="/soporte">¿Problemas con el pago?</a></p>
      <div class="mg-modal-actions" id="mg-pay-again" hidden><button class="mg-btn-solid" type="button" data-again>Generar un nuevo monto</button></div>`, stopPay);
    body.querySelector("[data-copy-amount]").addEventListener("click", () => copyText(order.amount, "✓ Monto copiado"));
    body.querySelector("[data-again]").addEventListener("click", () => startCheckout(kind, pack));
    const started = Date.now();
    countdownTimer = setInterval(() => {
      const left = Math.max(0, PAY_WINDOW_MS - (Date.now() - started));
      const el = $("mg-pay-left");
      if (el) el.textContent = Math.floor(left / 60000) + ":" + String(Math.floor(left / 1000) % 60).padStart(2, "0");
      if (left <= 0) {
        clearInterval(countdownTimer); countdownTimer = null;
        const t = $("mg-pay-text"); if (t) t.textContent = "¿Ya yapeaste? Seguimos revisando…";
        const a = $("mg-pay-again"); if (a) a.hidden = false;
      }
    }, 1000);
    pollTimer = setInterval(async () => {
      if (Date.now() - started > POLL_MAX_MS) { stopPay(); return; }
      try {
        const st = await api("/buy/" + encodeURIComponent(order.orderName));
        if (st.paid) { stopPay(); onPaid(kind); }
      } catch { /* red momentánea */ }
    }, POLL_MS);
  }

  async function onPaid(kind) {
    const body = openModal(`<div class="mg-paid"><div class="big">🥭</div><h2 id="mg-modal-title">¡Pago confirmado!</h2>
      <p class="mg-muted">${kind === "plan" ? "Tu plan mensual ya está activo." : "Tus créditos ya están cargados."} ¡A conversar!</p>
      <button class="mg-btn-solid" type="button" data-go>Empezar</button></div>`);
    body.querySelector("[data-go]").addEventListener("click", closeModal);
    if (location.hash === "#planes") history.replaceState(null, "", location.pathname);
    await enterApp();
  }

  // ── Memoria («cerebro») ──
  async function openMemory() {
    const body = openModal(`<h2 id="mg-modal-title">🧠 Lo que recuerdo de ti</h2>
      <p class="mg-muted">Lo armo solo con tus conversaciones para ayudarte mejor. Nunca guardo contraseñas, PIN ni códigos.</p>
      <div class="mg-mem-text" id="mg-mem-text">Cargando…</div>
      <div class="mg-modal-actions"><button class="mg-btn-ghost" type="button" id="mg-mem-clear" hidden>Borrar memoria</button><button class="mg-btn-solid" type="button" data-close>Cerrar</button></div>`);
    body.querySelector("[data-close]").addEventListener("click", closeModal);
    try {
      const { memory } = await api("/memory");
      $("mg-mem-text").textContent = memory || "Todavía no recuerdo nada de ti. Mientras más conversemos, mejor te conoceré 🥭";
      $("mg-mem-clear").hidden = !memory;
    } catch (err) { $("mg-mem-text").textContent = err.message; }
    $("mg-mem-clear").addEventListener("click", async () => {
      if (!confirm("¿Borrar todo lo que Manguito recuerda de ti?")) return;
      try { await api("/memory", { method: "DELETE" }); $("mg-mem-text").textContent = "Listo, empecé de cero."; $("mg-mem-clear").hidden = true; }
      catch (err) { toast(err.message); }
    });
  }

  // ── Borrar todo el historial ──
  function openWipe() {
    const body = openModal(`<h2 id="mg-modal-title">🗑️ Borrar todo el historial</h2>
      <p class="mg-muted">Se borran <b>todas</b> tus conversaciones y sus imágenes. No se puede deshacer.</p>
      <label class="mg-check"><input type="checkbox" id="mg-wipe-mem"> También borrar lo que recuerdo de ti</label>
      <label class="mg-check"><input type="checkbox" id="mg-wipe-links"> También borrar mis links compartidos</label>
      <p class="mg-err" id="mg-wipe-err"></p>
      <div class="mg-modal-actions"><button class="mg-btn-ghost" type="button" data-close>Cancelar</button><button class="mg-btn-danger" type="button" data-go>Borrar todo</button></div>`);
    body.querySelector("[data-close]").addEventListener("click", closeModal);
    body.querySelector("[data-go]").addEventListener("click", async e => {
      e.target.disabled = true;
      try {
        await api("/conversations", jsonBody("DELETE", { memory: $("mg-wipe-mem").checked, shares: $("mg-wipe-links").checked }));
        closeModal();
        state.conversations = [];
        newConversation();
        toast("✓ Historial borrado");
      } catch (err) { $("mg-wipe-err").textContent = err.message; e.target.disabled = false; }
    });
  }

  // ── Compartir ──
  const shareUrl = token => location.origin + "/manguito/s/" + token;

  async function openShare(fromMsg) {
    if (!state.convId) { toast("Primero escribe algo para compartir."); return; }
    let data;
    try { data = await api("/conversations/" + state.convId); } catch (err) { toast(err.message); return; }
    const msgs = (data.messages || []).filter(m => (m.text || "").trim());
    if (!msgs.length) { toast("Esta conversación todavía está vacía."); return; }
    const preId = fromMsg && fromMsg.dataset.id ? Number(fromMsg.dataset.id) : null;
    const preText = fromMsg ? fromMsg._raw : null;
    const pre = preId || (preText ? (msgs.slice().reverse().find(m => m.text === preText) || {}).id : null);
    const body = openModal(`<h2 id="mg-modal-title">Compartir chat</h2>
      <p class="mg-muted">Se comparte una copia de cómo está ahora; lo que escribas después no aparece. Las imágenes no se comparten.</p>
      <label class="mg-field"><span>Título</span><input class="mg-input" id="mg-sh-title" maxlength="80" value="${esc(data.conversation.title || "Conversación")}"></label>
      <div class="mg-field"><span>¿Qué quieres compartir?</span><div class="mg-options">
        <label class="mg-option"><input type="radio" name="mg-sh-mode" value="all"${pre ? "" : " checked"}><span><b>Todo el chat</b><small>Tus preguntas y las respuestas.</small></span></label>
        <label class="mg-option"><input type="radio" name="mg-sh-mode" value="result"><span><b>Solo el resultado</b><small>Solo la última respuesta de Manguito.</small></span></label>
        <label class="mg-option"><input type="radio" name="mg-sh-mode" value="selected"${pre ? " checked" : ""}><span><b>Elegir mensajes</b><small>Marca lo que quieres mostrar.</small></span></label>
      </div>
      <div class="mg-pick-list" id="mg-sh-pick" ${pre ? "" : "hidden"}>${msgs.map(m => `<label class="mg-pick"><input type="checkbox" value="${m.id}"${m.id === pre ? " checked" : ""}><span><em>${m.role === "user" ? "Tú:" : "Manguito:"}</em>${esc(m.text.slice(0, 220))}</span></label>`).join("")}</div></div>
      <div class="mg-field"><span>¿Quién puede verlo?</span><div class="mg-options">
        <label class="mg-option"><input type="radio" name="mg-sh-vis" value="public" checked><span><b>Cualquiera con el link</b><small>Solo lectura. Para continuar el chat necesitan su cuenta.</small></span></label>
        <label class="mg-option"><input type="radio" name="mg-sh-vis" value="private"><span><b>Solo con contraseña</b><small>Tú eliges la contraseña y se la pasas a quien quieras.</small></span></label>
      </div></div>
      <label class="mg-field" id="mg-sh-pass-wrap" hidden><span>Contraseña (mínimo 4 caracteres)</span><input class="mg-input" id="mg-sh-pass" type="text" maxlength="64" autocomplete="off"></label>
      <p class="mg-err" id="mg-sh-err"></p>
      <div class="mg-modal-actions"><button class="mg-btn-ghost" type="button" data-close>Cancelar</button><button class="mg-btn-solid" type="button" data-go>Crear link</button></div>`);
    body.querySelector("[data-close]").addEventListener("click", closeModal);
    body.addEventListener("change", () => {
      $("mg-sh-pick").hidden = (body.querySelector('input[name="mg-sh-mode"]:checked') || {}).value !== "selected";
      $("mg-sh-pass-wrap").hidden = (body.querySelector('input[name="mg-sh-vis"]:checked') || {}).value !== "private";
    });
    body.querySelector("[data-go]").addEventListener("click", async e => {
      const mode = body.querySelector('input[name="mg-sh-mode"]:checked').value;
      const visibility = body.querySelector('input[name="mg-sh-vis"]:checked').value;
      const messageIds = [...body.querySelectorAll("#mg-sh-pick input:checked")].map(i => Number(i.value));
      e.target.disabled = true;
      try {
        const r = await api("/shares", jsonBody("POST", {
          conversationId: state.convId, mode, messageIds, visibility,
          password: $("mg-sh-pass").value, title: $("mg-sh-title").value,
        }));
        showShareDone(r.token, visibility === "private");
      } catch (err) { $("mg-sh-err").textContent = err.message; e.target.disabled = false; }
    });
  }
  $("mg-share").addEventListener("click", () => openShare(null));

  function showShareDone(token, locked) {
    const url = shareUrl(token);
    const body = openModal(`<h2 id="mg-modal-title">✓ Link listo</h2>
      <p class="mg-muted">${locked ? "Pásale el link <b>y la contraseña</b> a quien quieras." : "Cualquiera con este link puede leerlo."} Quien no tenga cuenta solo puede leer; para continuar la conversación necesita su cuenta de Manguito Pro.</p>
      <div class="mg-linkbox"><code>${esc(url)}</code><button class="mg-mini" type="button" data-copy-link>Copiar</button></div>
      <div class="mg-modal-actions"><button class="mg-btn-ghost" type="button" data-links>Mis links</button><a class="mg-btn-solid" href="${esc(url)}" target="_blank" rel="noopener">Abrir</a></div>`);
    body.querySelector("[data-copy-link]").addEventListener("click", () => copyText(url, "✓ Link copiado"));
    body.querySelector("[data-links]").addEventListener("click", openLinks);
    copyText(url, "✓ Link copiado");
  }

  async function openLinks() {
    const body = openModal(`<h2 id="mg-modal-title">🔗 Mis links compartidos</h2>
      <p class="mg-muted">Si borras un link, deja de funcionar al toque.</p><div class="mg-share-list" id="mg-links">Cargando…</div>`);
    const MODE = { all: "Todo el chat", result: "Solo el resultado", selected: "Mensajes elegidos" };
    const paint = list => {
      $("mg-links").innerHTML = list.length ? list.map(s => `<div class="mg-share-item"><div><b>${s.locked ? "🔒 " : ""}${esc(s.title)}</b>
        <small>${MODE[s.mode] || ""} · ${s.views} ${s.views === 1 ? "vista" : "vistas"} · ${dayLabel(sqlDate(s.createdAt))}</small></div>
        <button class="mg-mini" type="button" data-cp="${esc(s.token)}">Copiar</button>
        <a class="mg-mini" href="/manguito/s/${esc(s.token)}" target="_blank" rel="noopener">Abrir</a>
        <button class="mg-mini danger" type="button" data-rmlink="${esc(s.token)}" aria-label="Borrar">${IC.trash}</button></div>`).join("")
        : `<p class="mg-muted">Todavía no compartiste ningún chat. Usa «Compartir» arriba a la derecha.</p>`;
    };
    let list = [];
    try { list = (await api("/shares")).shares || []; paint(list); } catch (err) { $("mg-links").textContent = err.message; return; }
    body.addEventListener("click", async e => {
      const cp = e.target.closest("[data-cp]");
      if (cp) { copyText(shareUrl(cp.dataset.cp), "✓ Link copiado"); return; }
      const rm = e.target.closest("[data-rmlink]");
      if (!rm || !confirm("¿Borrar este link? Dejará de funcionar.")) return;
      try { await api("/shares/" + encodeURIComponent(rm.dataset.rmlink), { method: "DELETE" }); list = list.filter(s => s.token !== rm.dataset.rmlink); paint(list); }
      catch (err) { toast(err.message); }
    });
  }

  // ── Arranque ──
  async function enterApp() {
    let access;
    try { access = await api("/access"); } catch { return false; }
    state.authed = true;
    state.allowed = !!access.allowed;
    state.store = access.store || state.store;
    state.lapsed = access.lapsed || null;
    document.body.classList.toggle("mg-guest", !state.allowed);
    if (!state.allowed) { showPlans(false); return true; }
    if (!access.configured) { gate("Casi listo", "Manguito Pro todavía no está conectado. Vuelve en un rato.", false); return true; }
    renderMeter(access.meter);
    if (location.hash === "#planes") { showPlans(true); }
    else if (state.view !== "chat") showView("chat");
    return true;
  }

  async function init() {
    // Volver adonde estaba antes de iniciar sesión (link compartido o planes).
    try {
      const back = sessionStorage.getItem("mg_return");
      if (back) {
        sessionStorage.removeItem("mg_return");
        if (/^\/manguito\/s\/[A-Za-z0-9_-]{22}$/.test(back)) { location.replace(back); return; }
        if (back === "/manguito/#planes") history.replaceState(null, "", "/manguito/#planes");
      }
    } catch { /* sin storage */ }

    let access;
    try { access = await api("/access"); }
    catch (err) {
      if (err.status === 401 || err.status === 403) {
        state.authed = false;
        try { state.store = await api("/api/store/ai-public/info"); } catch { state.store = null; }
        if (state.store && state.store.enabled) { showPlans(false); return; }
        gate("Inicia sesión", "Para usar Manguito Pro, ingresa con tu celular y tu PIN de liordark.com.", true);
      } else gate("Sin conexión", "No pudimos cargar Manguito Pro. Revisa tu internet y recarga la página.", false);
      return;
    }
    state.authed = true;
    state.allowed = !!access.allowed;
    state.store = access.store || null;
    state.lapsed = access.lapsed || null;
    if (!state.allowed) {
      if (state.store && state.store.enabled) { showPlans(false); return; }
      gate("Prueba privada", "Manguito Pro está en prueba privada por ahora. ¡Muy pronto para todos! 🥭", false);
      return;
    }
    if (!access.configured) { gate("Casi listo", "Manguito Pro todavía no está conectado. Vuelve en un rato.", false); return; }
    showView("chat");
    renderMeter(access.meter);
    await loadConversations();
    let last = null;
    try { last = Number(localStorage.getItem("mg_conv")) || null; } catch { /* sin storage */ }
    const fromHash = /^#c=(\d+)$/.exec(location.hash);
    if (fromHash) { last = Number(fromHash[1]); history.replaceState(null, "", location.pathname); }
    if (last && state.conversations.some(c => c.id === last)) await openConversation(last);
    if (location.hash === "#planes") showPlans(true);
    updateSend();
    if (!matchMedia("(pointer: coarse)").matches && state.view === "chat") input.focus();
  }

  init();
})();
