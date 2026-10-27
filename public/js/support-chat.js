(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // PANEL ADMIN > CHAT — abierto a todos los clientes de liordark.com.
  // Lista de chats a la izquierda, conversación a la derecha, se puede
  // cambiar de uno a otro sin perder nada.
  // ─────────────────────────────────────────────────────────────

  // Sonido distinto de los otros avisos del panel (pagos/clientes nuevos,
  // ver app.js) — para reconocer de oído que es un mensaje de chat, sin
  // tener que mirar la pantalla. Mismo mute global ("ldp_muted").
  let chatAudioCtx = null;
  function playChatChime() {
    if (localStorage.getItem("ldp_muted") === "1") return;
    try {
      chatAudioCtx = chatAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const now = chatAudioCtx.currentTime;
      [520, 780, 1040].forEach((freq, i) => {
        const osc  = chatAudioCtx.createOscillator();
        const gain = chatAudioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + i * 0.07);
        gain.gain.exponentialRampToValueAtTime(0.15, now + i * 0.07 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.07 + 0.3);
        osc.connect(gain).connect(chatAudioCtx.destination);
        osc.start(now + i * 0.07);
        osc.stop(now + i * 0.07 + 0.35);
      });
    } catch { /* navegador sin soporte de audio — no crítico */ }
  }

  async function api(path, options = {}) {
    const res = await fetch("/api/support-chat" + path, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (res.status === 401) { location.reload(); throw new Error("No autenticado"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "Error de red");
    return data;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Mismo catálogo cerrado que public-store/js/app.js — el id es lo único
  // que viaja al server (ver isValidStickerId en support-chat.repository.ts).
  const CHAT_STICKERS = [
    { id: "mango_hi",    emoji: "🥭👋", anim: "wiggle" },
    { id: "mango_love",  emoji: "🥭❤️", anim: "pulse" },
    { id: "mango_lol",   emoji: "🥭😂", anim: "shake" },
    { id: "mango_thumb", emoji: "🥭👍", anim: "" },
    { id: "mango_party", emoji: "🥭🎉", anim: "bounce" },
    { id: "mango_sad",   emoji: "🥭😢", anim: "" },
    { id: "mango_sleep", emoji: "🥭💤", anim: "" },
    { id: "mango_fire",  emoji: "🥭🔥", anim: "flicker" },
  ];
  const CHAT_STICKER_MAP = Object.fromEntries(CHAT_STICKERS.map(s => [s.id, s]));

  function fmtPhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "").slice(-9);
    return digits.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3") || phone;
  }

  function fmtTime(sqliteUTC) {
    try {
      return new Date(sqliteUTC.replace(" ", "T") + "Z").toLocaleTimeString("es-PE", {
        timeZone: "America/Lima", hour: "2-digit", minute: "2-digit",
      });
    } catch { return ""; }
  }

  let cachedChats = [];
  let selectedChatId = null;
  let source = null;
  let typingTimer = null;
  let isTyping = false;
  let renderedIds = new Set();
  let listFilter = "pendiente"; // "pendiente" | "cerrado" | "todos"

  // ─── Lista de chats ─────────────────────────────────────────

  function updateBadge() {
    const total = cachedChats.reduce((sum, c) => sum + c.unreadForAdmin, 0);
    const badge = document.getElementById("chat-unread-badge");
    badge.textContent = String(total);
    badge.hidden = total === 0;
  }

  function renderChatList() {
    const el = document.getElementById("chat-admin-list");
    const visible = listFilter === "todos" ? cachedChats : cachedChats.filter(c => c.tag === listFilter);
    const empty = document.getElementById("chat-admin-list-empty");
    empty.hidden = visible.length > 0;
    empty.textContent = cachedChats.length === 0
      ? "No hay chats abiertos."
      : (listFilter === "cerrado" ? "No hay chats cerrados." : "No hay chats pendientes.");

    el.querySelectorAll(".chat-admin-list-item").forEach(n => n.remove());
    visible.forEach(c => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "chat-admin-list-item" + (c.id === selectedChatId ? " active" : "");
      item.innerHTML = `
        <div class="chat-admin-list-item-row">
          <b>${escapeHtml(fmtPhone(c.clientPhone))}</b>
          <span class="chat-admin-list-item-tag ${c.tag}">${c.tag === "cerrado" ? "Cerrado" : "Pendiente"}</span>
          ${c.unreadForAdmin > 0 ? `<span class="chat-admin-list-dot">${c.unreadForAdmin}</span>` : ""}
        </div>
        <div class="chat-admin-list-preview">${escapeHtml(c.lastMessage || "Sin mensajes todavía")}</div>
      `;
      item.addEventListener("click", () => openChat(c.id));
      el.appendChild(item);
    });
  }

  function setListFilter(filter) {
    listFilter = filter;
    ["pendiente", "cerrado", "todos"].forEach(f => {
      document.getElementById(`chat-filter-${f}`).classList.toggle("active", f === filter);
    });
    renderChatList();
  }

  async function loadChats() {
    try {
      const { chats } = await api("/");
      cachedChats = chats;
      renderChatList();
      updateBadge();
    } catch { /* se reintenta en el próximo evento */ }
  }

  // ─── Conversación abierta ───────────────────────────────────

  function fmtDateShort(iso) {
    if (!iso) return "";
    const [y, m, d] = String(iso).split("-");
    return d && m && y ? `${d}/${m}/${y}` : iso;
  }

  function bubbleHtml(m) {
    const who = m.sender === "admin" ? "from-admin" : "from-customer";
    let body;
    if (m.type === "account_request") {
      body = `<span class="chat-quick-tag">📋 Pedido de cuenta</span>${escapeHtml(m.text)}`;
    } else if (m.type === "account_reply") {
      let acc = {};
      try { acc = JSON.parse(m.text); } catch { /* texto raro — se ignora */ }
      body = `
        <div class="chat-account-card">
          <div class="chat-account-card-title">📋 ${escapeHtml(acc.platform || "")}</div>
          <div><b>Correo:</b> ${escapeHtml(acc.email || "")}</div>
          <div><b>Contraseña:</b> ${escapeHtml(acc.password || "")}</div>
          <div><b>Vence:</b> ${fmtDateShort(acc.expiresAt)}</div>
        </div>`;
    } else if (m.type === "text") {
      body = escapeHtml(m.text);
    } else if (m.type === "sticker") {
      const s = CHAT_STICKER_MAP[m.text];
      return `
        <div class="chat-admin-bubble-row ${who} chat-admin-bubble-row-sticker">
          <span class="chat-admin-sticker${s && s.anim ? " chat-admin-sticker-" + s.anim : ""}">${s ? s.emoji : "🥭"}</span>
        </div>`;
    } else if (m.mediaExpired) {
      body = `<span class="chat-admin-bubble-expired">${m.type === "image" ? "📷 Foto" : "🎥 Video"} (se autodestruyó)</span>`;
    } else if (m.type === "image") {
      body = `<img class="chat-admin-bubble-media chat-admin-bubble-media-zoomable" src="${escapeHtml(m.mediaUrl)}" alt="Foto">`;
    } else {
      body = `<video class="chat-admin-bubble-media" src="${escapeHtml(m.mediaUrl)}" controls></video>`;
    }
    return `
      <div class="chat-admin-bubble-row ${who}">
        <div class="chat-admin-bubble">${body}<span class="chat-admin-bubble-time">${fmtTime(m.createdAt)}</span></div>
      </div>`;
  }

  function scrollMessagesToBottom() {
    const el = document.getElementById("chat-admin-messages");
    el.scrollTop = el.scrollHeight;
  }

  function appendBubble(m) {
    if (renderedIds.has(m.id)) return; // ya se mostró optimista al mandarlo — evita duplicar al llegar por SSE
    renderedIds.add(m.id);
    const el = document.getElementById("chat-admin-messages");
    const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.insertAdjacentHTML("beforeend", bubbleHtml(m));
    if (wasAtBottom) scrollMessagesToBottom();
  }

  function showTyping(show) {
    document.getElementById("chat-admin-typing-row").hidden = !show;
    if (show) scrollMessagesToBottom();
  }

  function updateTagBtn(tag) {
    const btn = document.getElementById("chat-admin-tag-btn");
    btn.textContent = tag === "cerrado" ? "🏷️ Marcar pendiente" : "🏷️ Marcar cerrado";
  }

  async function openChat(chatId) {
    selectedChatId = chatId;
    renderChatList();
    document.getElementById("chat-admin-empty").hidden = true;
    document.getElementById("chat-admin-thread").hidden = false;
    document.getElementById("chat-admin-sticker-popover").hidden = true;
    showTyping(false);

    const messagesEl = document.getElementById("chat-admin-messages");
    messagesEl.innerHTML = `<div class="feed-empty">Cargando…</div>`;
    renderedIds = new Set();
    try {
      const { chat, messages } = await api(`/${chatId}/messages`);
      document.getElementById("chat-admin-thread-phone").textContent = fmtPhone(chat.clientPhone);
      updateTagBtn(chat.tag);
      messages.forEach(m => renderedIds.add(m.id));
      messagesEl.innerHTML = messages.length
        ? messages.map(bubbleHtml).join("")
        : `<div class="feed-empty">Sin mensajes todavía.</div>`;
      scrollMessagesToBottom();
      showTyping(chat.customerTyping);
      await loadChats(); // refresca el badge/preview (markSeen ya corrió en el server)
    } catch (err) {
      messagesEl.innerHTML = `<div class="feed-empty">${escapeHtml(err.message)}</div>`;
    }
  }

  function closeThreadView() {
    selectedChatId = null;
    document.getElementById("chat-admin-thread").hidden = true;
    document.getElementById("chat-admin-empty").hidden = false;
    renderChatList();
  }

  async function sendTyping(typing) {
    if (!selectedChatId || typing === isTyping) return;
    isTyping = typing;
    api(`/${selectedChatId}/typing`, { method: "POST", body: JSON.stringify({ typing }) }).catch(() => {});
  }

  async function sendText() {
    if (!selectedChatId) return;
    const input = document.getElementById("chat-admin-text-input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    clearTimeout(typingTimer);
    sendTyping(false);
    try {
      const { message } = await api(`/${selectedChatId}/messages`, { method: "POST", body: JSON.stringify({ text }) });
      appendBubble(message); // optimista — no espera a que vuelva por SSE
    } catch (err) {
      alert(err.message || "No se pudo mandar el mensaje.");
    }
  }

  // ─── Botones de respuesta rápida ────────────────────────────

  const GREETING_TEXT = "¡Hola! 👋 Soy del equipo de soporte de Liordark. ¿En qué podemos ayudarte hoy?";
  const ACCOUNT_REQUEST_TEXT = "Selecciona la cuenta con el problema 👇";
  // Mismo texto que la despedida automática al cerrar el chat (ver
  // CLOSE_FAREWELL_TEXT en support-chat.routes.ts) — acá va como botón
  // de respuesta rápida, para usarla sin tener que cerrar la conversación.
  const FAREWELL_TEXT =
    "🥭 Esperamos que haya sido de tu agrado la atención. Cualquier duda o pregunta, no dudes en hacérnosla — " +
    "estamos felices de poder ayudarte 💛😊";

  async function sendQuick(type, text) {
    if (!selectedChatId) return;
    try {
      const { message } = await api(`/${selectedChatId}/messages`, {
        method: "POST", body: JSON.stringify({ type, text }),
      });
      appendBubble(message);
    } catch (err) {
      alert(err.message || "No se pudo mandar el mensaje.");
    }
  }

  async function sendMedia(file) {
    if (!selectedChatId) return;
    const btn = document.getElementById("chat-admin-attach-btn");
    const original = btn.textContent;
    btn.textContent = "⏳";
    btn.disabled = true;
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/support-chat/${selectedChatId}/messages/media`, {
        method: "POST", credentials: "include", body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "No se pudo subir el archivo.");
      appendBubble(data.message);
    } catch (err) {
      alert(err.message || "No se pudo subir el archivo.");
    } finally {
      btn.textContent = original;
      btn.disabled = false;
    }
  }

  async function toggleSelectedChatTag() {
    if (!selectedChatId) return;
    const current = cachedChats.find(c => c.id === selectedChatId);
    const nextTag = current?.tag === "cerrado" ? "pendiente" : "cerrado";
    updateTagBtn(nextTag); // optimista
    try {
      await api(`/${selectedChatId}/tag`, { method: "POST", body: JSON.stringify({ tag: nextTag }) });
      await loadChats();
    } catch (err) {
      updateTagBtn(current?.tag || "pendiente"); // revierte si falló
      alert(err.message || "No se pudo cambiar la etiqueta.");
    }
  }

  async function sendSticker(stickerId) {
    if (!selectedChatId) return;
    toggleStickerPopover(false);
    try {
      const { message } = await api(`/${selectedChatId}/messages`, {
        method: "POST", body: JSON.stringify({ type: "sticker", stickerId }),
      });
      appendBubble(message);
    } catch (err) {
      alert(err.message || "No se pudo mandar el sticker.");
    }
  }

  function toggleStickerPopover(show) {
    const pop = document.getElementById("chat-admin-sticker-popover");
    if (show === undefined) show = pop.hidden;
    pop.hidden = !show;
    if (show && !pop.dataset.built) {
      pop.dataset.built = "1";
      pop.innerHTML = CHAT_STICKERS.map(s => `
        <button type="button" class="chat-admin-sticker-pick" data-sticker="${s.id}">${s.emoji}</button>
      `).join("");
    }
  }

  function openImgLightbox(src) {
    document.getElementById("img-lightbox-img").src = src;
    document.getElementById("img-lightbox").hidden = false;
  }
  function closeImgLightbox() {
    document.getElementById("img-lightbox").hidden = true;
    document.getElementById("img-lightbox-img").src = "";
  }

  async function closeSelectedChat() {
    if (!selectedChatId) return;
    if (!confirm("¿Cerrar este chat? Se borran todos los mensajes y archivos — no se puede deshacer.")) return;
    try {
      await api(`/${selectedChatId}/close`, { method: "POST" });
    } catch (err) {
      alert(err.message || "No se pudo cerrar el chat.");
    }
  }

  // ─── Eventos en vivo (SSE) — conectado desde init(), no depende de
  // qué vista esté mirando el admin (así el badge se actualiza siempre). ───

  function connectStream() {
    if (source) source.close();
    source = new EventSource("/api/support-chat/stream", { withCredentials: true });
    source.onmessage = (ev) => {
      let evt;
      try { evt = JSON.parse(ev.data); } catch { return; }

      if (evt.type === "message") {
        if (evt.message.sender === "customer") playChatChime();
        loadChats();
        if (evt.chatId === selectedChatId) {
          if (evt.message.sender === "customer") showTyping(false);
          appendBubble(evt.message);
          if (evt.message.sender === "customer") api(`/${selectedChatId}/messages`).catch(() => {}); // marca visto
        }
      } else if (evt.type === "typing") {
        if (evt.chatId === selectedChatId && evt.sender === "customer") showTyping(evt.typing);
      } else if (evt.type === "closed" || evt.type === "chat_created") {
        if (evt.type === "closed" && evt.chatId === selectedChatId) closeThreadView();
        loadChats();
      }
    };
  }

  // ─── Init ───────────────────────────────────────────────────

  let initialized = false;

  function init() {
    if (initialized) return;
    initialized = true;

    document.getElementById("chat-admin-close-btn").addEventListener("click", closeSelectedChat);
    document.getElementById("chat-admin-tag-btn").addEventListener("click", toggleSelectedChatTag);
    ["pendiente", "cerrado", "todos"].forEach(f => {
      document.getElementById(`chat-filter-${f}`).addEventListener("click", () => setListFilter(f));
    });
    document.getElementById("chat-admin-input-form").addEventListener("submit", (e) => {
      e.preventDefault();
      sendText();
    });
    document.getElementById("chat-admin-text-input").addEventListener("input", () => {
      sendTyping(true);
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => sendTyping(false), 2000);
    });
    document.getElementById("chat-admin-attach-btn").addEventListener("click", () => {
      document.getElementById("chat-admin-file-input").click();
    });
    document.getElementById("chat-admin-file-input").addEventListener("change", (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (file) sendMedia(file);
    });
    document.getElementById("chat-quick-greeting").addEventListener("click", () => sendQuick("text", GREETING_TEXT));
    document.getElementById("chat-quick-account").addEventListener("click", () => sendQuick("account_request", ACCOUNT_REQUEST_TEXT));
    document.getElementById("chat-quick-farewell").addEventListener("click", () => sendQuick("text", FAREWELL_TEXT));

    document.getElementById("chat-admin-sticker-btn").addEventListener("click", () => toggleStickerPopover());
    document.getElementById("chat-admin-sticker-popover").addEventListener("click", (e) => {
      const btn = e.target.closest(".chat-admin-sticker-pick");
      if (btn) sendSticker(btn.dataset.sticker);
    });
    document.getElementById("chat-admin-messages").addEventListener("click", (e) => {
      const img = e.target.closest(".chat-admin-bubble-media-zoomable");
      if (img) openImgLightbox(img.src);
    });
    document.getElementById("img-lightbox-close").addEventListener("click", closeImgLightbox);
    document.getElementById("img-lightbox").addEventListener("click", (e) => {
      if (e.target.id === "img-lightbox") closeImgLightbox();
    });

    loadChats();
    connectStream();
  }

  window.LiordarkSupportChat = { init, load: loadChats };
})();
