(function () {
  "use strict";

  const API_BASE      = "/api/wholesaler";
  const SUPPORT_PHONE = "51963081436"; // wa.me — mismo número que liordark.com (ver public-store/js/app.js)

  // ─────────────────────────────────────────────────────────────
  // HELPERS — fetch con cookie de sesión de mayorista, escape, plata,
  // fechas y WhatsApp. Mismos patrones que public-store/js/app.js y
  // public/js/access.js, adaptados a este panel.
  // ─────────────────────────────────────────────────────────────

  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(API_BASE + path, {
      method: opts.method || "GET",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* respuesta vacía */ }
    if (!res.ok) {
      const err = new Error(data.message || "Ocurrió un error. Intenta de nuevo.");
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function setFormError(id, message) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!message) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = message;
    el.hidden = false;
  }

  function money(cents) {
    return "S/ " + (Number(cents || 0) / 100).toFixed(2);
  }

  // Celulares de Perú son siempre 9 dígitos — sin el prefijo "51" WhatsApp
  // no abre el chat correcto (mismo criterio que access.js/app.js del admin).
  function waLink(phone, text) {
    let digits = String(phone || "").replace(/\D/g, "");
    if (digits.length === 9) digits = "51" + digits;
    return "https://api.whatsapp.com/send?phone=" + digits + "&text=" + encodeURIComponent(text);
  }

  function limaTodayISO() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
  }

  function daysBetween(fromISO, toISO) {
    const [fy, fm, fd] = fromISO.split("-").map(Number);
    const [ty, tm, td] = toISO.split("-").map(Number);
    const a = Date.UTC(fy, fm - 1, fd);
    const b = Date.UTC(ty, tm - 1, td);
    return Math.round((b - a) / 86_400_000);
  }

  function daysLeftFor(expiresAt) {
    if (!expiresAt) return null;
    return daysBetween(limaTodayISO(), expiresAt);
  }

  function fmtDate(ymd) {
    if (!ymd) return "—";
    const [y, m, d] = ymd.split("-");
    return `${d}/${m}/${y}`;
  }

  function fmtDateTime(iso) {
    if (!iso) return "—";
    try {
      return new Intl.DateTimeFormat("es-PE", {
        timeZone: "America/Lima", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
      }).format(new Date(iso));
    } catch { return String(iso); }
  }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  // <img data-fallback="..."> que reemplaza por un chip de texto si la
  // imagen no carga — un solo listener en captura (document) en vez de
  // onerror inline, para no pelear con el escapado de comillas anidadas.
  function wireGlobalImgFallback() {
    document.addEventListener("error", (e) => {
      const img = e.target;
      if (!img || img.tagName !== "IMG" || !img.dataset || !img.dataset.fallback) return;
      const span = document.createElement("span");
      span.className = "catalog-card-fallback";
      span.textContent = img.dataset.fallback;
      img.replaceWith(span);
    }, true);
  }

  function mediaHtml(imageUrl, fallbackText) {
    if (!imageUrl) return `<span class="catalog-card-fallback">${escapeHtml(fallbackText)}</span>`;
    return `<img src="${escapeHtml(imageUrl)}" alt="" loading="lazy" data-fallback="${escapeHtml(fallbackText)}">`;
  }

  // Redibujar SOLO si algo cambió: así una recarga de datos iguales no
  // hace parpadear la lista ni cierra un desplegable abierto.
  function setHtmlIfChanged(el, html) {
    if (!el || el.__html === html) return false;
    el.innerHTML = html;
    el.__html = html;
    return true;
  }

  // Lista por claves (una tarjeta por plataforma, una fila por ítem): cada
  // hijo se rehace solo si su HTML cambió; los demás quedan intactos.
  function patchKeyed(container, items) {
    container.__html = null; // ya no vale el atajo de setHtmlIfChanged
    const existing = new Map();
    for (const child of Array.from(container.childNodes)) {
      if (child.nodeType === 1 && child.dataset.key !== undefined && !existing.has(child.dataset.key)) existing.set(child.dataset.key, child);
      else child.remove(); // «Cargando…», un error viejo, etc.
    }
    let prev = null;
    for (const { key, html } of items) {
      let node = existing.get(key);
      existing.delete(key);
      if (!node || node.__html !== html) {
        const tpl = document.createElement("template");
        tpl.innerHTML = html.trim();
        const fresh = tpl.content.firstElementChild;
        fresh.dataset.key = key;
        fresh.__html = html;
        if (node) node.replaceWith(fresh);
        node = fresh;
      }
      const at = prev ? prev.nextElementSibling : container.firstElementChild;
      if (at !== node) container.insertBefore(node, at);
      prev = node;
    }
    existing.forEach(n => n.remove());
  }

  function keyedChild(container, key) {
    return Array.from(container.children).find(c => c.dataset.key === key) || null;
  }

  // ─────────────────────────────────────────────────────────────
  // ÍCONOS (SVG de trazo, color = currentColor; estilo en .ic del css)
  // ─────────────────────────────────────────────────────────────

  const ICON_PATHS = {
    home:    '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    users:   '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.2A6.5 6.5 0 0 1 21.5 20"/>',
    cart:    '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.6 12.4a1 1 0 0 0 1 .8h9.7a1 1 0 0 0 1-.8L21 7H6"/>',
    box:     '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
    card:    '<rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M2.5 10h19"/><path d="M6.5 15h3"/>',
    speaker: '<path d="M3 10v4a1 1 0 0 0 1 1h3l5 4V5L7 9H4a1 1 0 0 0-1 1z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6a8 8 0 0 1 0 12"/>',
    chat:    '<path d="M21 12a8.5 8.5 0 0 1-12.4 7.6L3 21l1.4-5.4A8.5 8.5 0 1 1 21 12z"/>',
    more:    '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
    plus:    '<path d="M12 5v14M5 12h14"/>',
    key:     '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2"/><path d="M16 7l3 3"/>',
    send:    '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
    trash:   '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    check:   '<path d="m5 12 5 5 9-10"/>',
    moon:    '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    sun:     '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    copy:    '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    mail:    '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    shield:  '<path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z"/>',
    user:    '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    ban:     '<circle cx="12" cy="12" r="9"/><path d="M5.7 5.7l12.6 12.6"/>',
    undo:    '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    alert:   '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    arrowUp: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
    arrowDn: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  };

  function icon(name) {
    return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
  }

  // Chip con las iniciales y el color de cada plataforma (NF rojo, D+ azul…).
  const PLATFORM_STYLES = [
    [/netflix/i, "NF", "nf"], [/disney/i, "D+", "dp"], [/hbo|^max$/i, "HBO", "hbo"],
    [/prime|amazon/i, "PV", "pv"], [/crunchy/i, "CR", "cr"], [/spotify/i, "SP", "sp"],
    [/youtube/i, "YT", "yt"], [/canva/i, "CA", "ca"], [/gemini/i, "GE", "ge"],
    [/chatgpt|openai|gpt/i, "AI", "ai"], [/paramount/i, "P+", "pp"], [/vix/i, "VX", "vx"],
    [/apple/i, "TV", "tv"], [/star/i, "S+", "st"],
  ];

  function platformChip(platform, size) {
    const p = String(platform || "");
    const hit = PLATFORM_STYLES.find(([re]) => re.test(p));
    const mono = hit ? hit[1] : (p.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?");
    return `<span class="plat${hit ? " plat-" + hit[2] : ""}${size ? " plat-" + size : ""}" aria-hidden="true">${escapeHtml(mono)}</span>`;
  }

  const PLATFORM_NAMES = {
    NETFLIX: "Netflix", DISNEY: "Disney+", "DISNEY+": "Disney+", HBO: "HBO Max", "HBO MAX": "HBO Max", MAX: "Max",
    "PRIME VIDEO": "Prime Video", PRIME: "Prime Video", AMAZON: "Prime Video", CRUNCHYROLL: "Crunchyroll",
    SPOTIFY: "Spotify", YOUTUBE: "YouTube", CANVA: "Canva Pro", GEMINI: "Gemini", CHATGPT: "ChatGPT",
    PARAMOUNT: "Paramount+", VIX: "ViX",
  };

  // Nombre bonito: el título del catálogo si existe; si no, uno conocido o
  // "Title Case" (el valor crudo sigue yendo en los mensajes de WhatsApp).
  function platformName(platform) {
    const item = catalogItem(platform);
    if (item && item.title) return item.title;
    const raw = String(platform || "").trim();
    return PLATFORM_NAMES[raw.toUpperCase()] || raw.toLowerCase().replace(/(^|\s)\S/g, s => s.toUpperCase());
  }

  // "35.00" → "35" · "12.50" → "12.50"
  function shortPrice(price) {
    const n = Number(price);
    if (!Number.isFinite(n)) return String(price ?? "");
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  }

  function expiryTone(days) {
    if (days === null || days === undefined) return "none";
    if (days < 0) return "over";
    if (days <= 5) return "soon";
    return "ok";
  }

  function expiryStatusText(expiresAt, days) {
    if (!expiresAt) return "Sin fecha de vencimiento";
    const d = fmtDate(expiresAt).slice(0, 5);
    if (days < 0) return `Venció hace ${Math.abs(days)} día${days === -1 ? "" : "s"} · ${d}`;
    if (days === 0) return `Vence hoy · ${d}`;
    if (days === 1) return `Vence mañana · ${d}`;
    if (days <= 5) return `Vence en ${days} días · ${d}`;
    return `Activa · vence el ${d} (${days} días)`;
  }

  function whenText(days) {
    if (days === null || days === undefined) return "sin fecha";
    if (days < 0) return `venció hace ${Math.abs(days)}d`;
    if (days === 0) return "vence hoy";
    if (days === 1) return "mañana";
    return `en ${days} días`;
  }

  function toast(text) {
    const el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  // ─────────────────────────────────────────────────────────────
  // GATE — login (sin registro: el admin crea las cuentas)
  // ─────────────────────────────────────────────────────────────

  function showAuth() {
    document.getElementById("view-auth").hidden = false;
    document.getElementById("view-app").hidden = true;
  }

  function showApp() {
    document.getElementById("view-auth").hidden = true;
    document.getElementById("view-app").hidden = false;
  }

  function initLoginForm() {
    document.getElementById("login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      setFormError("login-error", "");
      const phone    = document.getElementById("login-phone").value.trim();
      const password = document.getElementById("login-password").value;
      try {
        await api("/auth/login", { method: "POST", body: { phone, password } });
        await onAuthenticated();
      } catch (err) {
        // Sin cuenta regresiva que deje el botón apagado: el servidor decide.
        // Así, si soporte le quita el bloqueo, entra al instante.
        setFormError("login-error", err.message);
      }
    });

    document.getElementById("app-logout-btn").addEventListener("click", logout);
    document.getElementById("mas-logout-btn").addEventListener("click", logout);

    // Ojo de la contraseña: mostrar / ocultar.
    const eye = document.getElementById("login-eye");
    eye.addEventListener("click", () => {
      const input = document.getElementById("login-password");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      eye.setAttribute("aria-label", show ? "Ocultar contraseña" : "Mostrar contraseña");
      eye.title = eye.getAttribute("aria-label");
    });

    document.getElementById("auth-support-link").href = "https://wa.me/" + SUPPORT_PHONE
      + "?text=" + encodeURIComponent("Hola! Quiero ser mayorista de Manguitope.");
  }

  async function logout() {
    try { await api("/auth/logout", { method: "POST" }); } catch { /* no crítico */ }
    cartItems = [];
    cachedClients = [];
    cachedCatalog = [];
    stopNotifPolling();
    showAuth();
  }

  async function onAuthenticated() {
    showApp();
    await Promise.all([refreshBalance(), refreshUnseenBadge()]);
    startNotifPolling();
    switchPage("inicio");
  }

  // ─────────────────────────────────────────────────────────────
  // NOTIFICACIONES — campanita: cuenta lista, compra añadida a su
  // registro, o un cliente suyo por vencer. Mismo mecanismo que la
  // campanita de liordark.com (polling cada 20s + marcar leído al abrir).
  // ─────────────────────────────────────────────────────────────

  const NOTIF_POLL_MS = 10_000;
  let notifPollTimer = null;

  function timeAgo(sqliteDateUTC) {
    const ms = Date.now() - new Date(sqliteDateUTC.replace(" ", "T") + "Z").getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return "ahora";
    if (min < 60) return min + " min";
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + " h";
    return Math.floor(hr / 24) + " d";
  }

  function renderNotifications(list) {
    const el = document.getElementById("notif-list");
    if (!list || list.length === 0) {
      setHtmlIfChanged(el, '<div class="notif-empty">No tienes notificaciones todavía.</div>');
      return;
    }
    // Se pide cada 10 s: solo se redibuja si algo cambió.
    setHtmlIfChanged(el, list.map(n => `
      <div class="notif-item${n.readAt ? "" : " notif-item-unread"}">
        <div class="notif-item-msg">${escapeHtml(n.message)}</div>
        <div class="notif-item-time">${timeAgo(n.createdAt)}</div>
      </div>
    `).join(""));
  }

  async function loadNotifications() {
    try {
      const { notifications, unreadCount } = await api("/notifications");
      renderNotifications(notifications);
      document.getElementById("notif-dot").hidden = !unreadCount;
    } catch { /* no crítico */ }
  }

  async function openNotifPanel() {
    document.getElementById("notif-panel").hidden = false;
    await loadNotifications();
    try {
      await api("/notifications/read", { method: "POST" });
      document.getElementById("notif-dot").hidden = true;
    } catch { /* no crítico */ }
  }

  function closeNotifPanel() {
    document.getElementById("notif-panel").hidden = true;
  }

  function initNotifications() {
    document.getElementById("notif-bell-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      document.getElementById("notif-panel").hidden ? openNotifPanel() : closeNotifPanel();
    });
    document.addEventListener("click", (e) => {
      const wrap = document.querySelector(".notif-wrap");
      if (wrap && !wrap.contains(e.target)) closeNotifPanel();
    });
  }

  function startNotifPolling() {
    loadNotifications();
    stopNotifPolling();
    notifPollTimer = setInterval(loadNotifications, NOTIF_POLL_MS);
  }

  function stopNotifPolling() {
    if (notifPollTimer) { clearInterval(notifPollTimer); notifPollTimer = null; }
  }

  // ─────────────────────────────────────────────────────────────
  // SHELL — header con saldo + nav (sidebar en desktop, tabs abajo en
  // mobile). Un solo arreglo de páginas genera ambas navegaciones.
  // ─────────────────────────────────────────────────────────────

  // Menú lateral (PC, ≥900px) — lista completa, hay espacio de sobra.
  const SIDEBAR_PAGES = [
    { id: "inicio",        label: "Inicio",        icon: "home" },
    { id: "clientes",      label: "Clientes",      icon: "users" },
    { id: "comprar",       label: "Comprar",       icon: "cart" },
    { id: "cuentas",       label: "Cuentas",       icon: "box", badge: true },
    { id: "creditos",      label: "Créditos",      icon: "card" },
    { id: "recordatorios", label: "Recordatorios", icon: "speaker" },
    { id: "soporte",       label: "Soporte",       icon: "chat" },
  ];

  // Barra inferior (celular) — Créditos/Recordatorios/Soporte se agrupan en
  // "Más" (page-mas) para no amontonar íconos en una pantalla angosta.
  const TAB_PAGES = [
    { id: "inicio",   label: "Inicio",   icon: "home" },
    { id: "clientes", label: "Clientes", icon: "users" },
    { id: "comprar",  label: "Comprar",  icon: "cart" },
    { id: "cuentas",  label: "Cuentas",  icon: "box", badge: true },
    { id: "mas",      label: "Más",      icon: "more" },
  ];

  // Páginas que en mobile viven dentro de "Más" — su tab activo visualmente
  // sigue siendo "Más" (no hay botón propio en la tab bar para ellas).
  const PAGES_UNDER_MAS = ["creditos", "recordatorios", "soporte"];
  function mobileTabFor(view) {
    return PAGES_UNDER_MAS.includes(view) ? "mas" : view;
  }

  function renderNav() {
    const tabBar      = document.getElementById("tab-bar");
    const sidebarNav  = document.getElementById("sidebar-nav");

    tabBar.innerHTML = TAB_PAGES.map(p => `
      <button class="tab-btn" data-page="${p.id}" type="button">
        ${icon(p.icon)}
        <span>${escapeHtml(p.label)}</span>
        ${p.badge ? `<span class="tab-badge" id="badge-${p.id}-tab" hidden>0</span>` : ""}
      </button>
    `).join("");

    sidebarNav.innerHTML = SIDEBAR_PAGES.map(p => `
      <button class="sidebar-btn" data-page="${p.id}" type="button">
        ${icon(p.icon)}
        <span>${escapeHtml(p.label)}</span>
        ${p.badge ? `<span class="sidebar-badge" id="badge-${p.id}-sidebar" hidden>0</span>` : ""}
      </button>
    `).join("");

    // Delegado al documento (no solo a los botones de nav) — así los
    // accesos rápidos de Inicio y las filas de "Más" (data-page) navegan
    // igual que la tab bar/sidebar, sin wiring aparte por cada uno.
    // Solo botones/enlaces: #view-app también lleva data-page (la banda
    // mango de Inicio, ver style.css) y con un closest("[data-page]")
    // cualquier toque en la página la recargaba entera — las tarjetas
    // parpadeaban y el desplegable de meses de Canva se cerraba solo.
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-page], a[data-page]");
      if (btn) switchPage(btn.dataset.page);
      // Cierra los menús «⋯» abiertos al tocar fuera de ellos.
      document.querySelectorAll("details.more-menu[open]").forEach(d => {
        if (!d.contains(e.target)) d.open = false;
      });
    });
  }

  function updateBadge(n) {
    ["badge-cuentas-tab", "badge-cuentas-sidebar"].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = String(n);
      el.hidden = !n || n <= 0;
    });
  }

  async function refreshUnseenBadge() {
    try {
      const { unseenCount } = await api("/accounts");
      updateBadge(unseenCount || 0);
    } catch { /* no crítico */ }
  }

  function switchPage(view) {
    const tabView = mobileTabFor(view);
    document.querySelectorAll(".tab-btn[data-page]").forEach(b => {
      const on = b.dataset.page === tabView;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    document.querySelectorAll(".sidebar-btn[data-page]").forEach(b => {
      const on = b.dataset.page === view;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    document.querySelectorAll(".page").forEach(sec => { sec.hidden = sec.id !== "page-" + view; });
    // La banda mango se alarga solo en Inicio (la tarjeta de saldo se monta encima).
    document.getElementById("view-app").dataset.page = view;
    closeNotifPanel();
    document.getElementById("app-main").scrollTo(0, 0);
    window.scrollTo(0, 0);

    if (view === "inicio")             loadInicio();
    else if (view === "clientes")      loadClients();
    else if (view === "comprar")       loadComprar();
    else if (view === "cuentas")       loadCuentas();
    else if (view === "creditos")      loadCreditos();
    else if (view === "recordatorios") loadReminders();
    else if (view === "soporte")       loadSoporte();
  }

  let currentBalanceCents = 0;
  let currentWholesalerPhone = "";

  // Mismo criterio que normalizePeruPhone del backend — celulares de Perú
  // son 9 dígitos, así que comparamos siempre con el "51" puesto adelante.
  function normalizedPhone(raw) {
    const digits = String(raw || "").replace(/\D/g, "");
    return digits.length === 9 ? "51" + digits : digits;
  }

  // "Es para el propio mayorista" (ver panel admin > Mayoristas > Asignar
  // cuenta) deja el mismo celular del mayorista como clientPhone — esta
  // cuenta no es de un cliente suyo, es para su propio uso.
  function isOwnAccount(clientPhone) {
    return !!currentWholesalerPhone && normalizedPhone(clientPhone) === normalizedPhone(currentWholesalerPhone);
  }

  async function refreshBalance() {
    try {
      const { balanceCents, displayName, phone } = await api("/balance");
      currentBalanceCents = balanceCents;
      currentWholesalerPhone = phone || currentWholesalerPhone;
      document.getElementById("header-name").textContent = displayName || phone || "Mayorista";
      document.getElementById("header-balance").textContent = money(balanceCents);
      const creditsBalanceEl = document.getElementById("credits-balance-value");
      if (creditsBalanceEl) creditsBalanceEl.textContent = money(balanceCents);
      const homeBalanceEl = document.getElementById("home-balance-value");
      if (homeBalanceEl) homeBalanceEl.textContent = money(balanceCents);
    } catch { /* se deja lo último mostrado */ }
  }

  // ─────────────────────────────────────────────────────────────
  // CATÁLOGO COMPARTIDO — mismo fetch lo usan Clientes (precio de
  // renovación), Comprar (grilla) y el form de cuenta completa.
  // ─────────────────────────────────────────────────────────────

  let cachedCatalog = [];

  async function fetchCatalog() {
    try {
      const { catalog } = await api("/catalog");
      cachedCatalog = catalog || [];
    } catch {
      // Red momentánea: se queda el último catálogo (vaciarlo hacía
      // desaparecer las tarjetas y el carrito por un instante).
    }
    return cachedCatalog;
  }

  function catalogItem(platform) {
    return cachedCatalog.find(c => c.platform === platform) || null;
  }

  // ─────────────────────────────────────────────────────────────
  // CLIENTES — sub-clientes del mayorista con perfil asignado.
  // ─────────────────────────────────────────────────────────────

  // Marca del mayorista: sin marcar · «No renueva». La renovación PAGADA
  // solo sale de «Renovar» (ya no se puede poner a mano).
  const PAID_MESSAGE  = "✅ Esta renovación ya está pagada — se activa apenas confirmemos la cuenta con el proveedor.";

  // Renovación pagada y esperando confirmación del proveedor (cuentas con perfiles).
  function isRenewalPaid(c) {
    return (c.renewalStatus || "") === "yes" && !!(c.renew && c.renew.pending);
  }

  let cachedClients = [];
  let clientsFilter = "all";
  let clientsQuery  = "";

  // Trae clientes + catálogo (para los nombres). Lo usan Clientes y Soporte.
  async function fetchClients() {
    const [, { clients, manualOverrides }] = await Promise.all([fetchCatalog(), api("/clients")]);
    // Reemplazos manuales de Soporte (garantía sin cuenta real en Accesos)
    // — id negativo para no chocar nunca con un id real de perfil.
    const overrides = (manualOverrides || []).map(o => ({
      id: -o.id, isOverride: true, profileName: o.profileName, clientPhone: o.clientPhone,
      renewalStatus: "", platform: o.platform, expiresAt: o.expiresAt, email: o.email, password: o.password,
    }));
    cachedClients = [...(clients || []), ...overrides];
    return cachedClients;
  }

  async function loadClients() {
    const listEl  = document.getElementById("clients-list");
    const emptyEl = document.getElementById("clients-empty");
    if (!cachedClients.length) listEl.innerHTML = `<p class="muted small">Cargando…</p>`;
    emptyEl.hidden = true;
    try {
      await fetchClients();
      renderClients();
    } catch (err) {
      listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function isFullAccountClient(c) {
    return !c.isOverride && (c.accountHasProfiles === false || (c.renew && c.renew.kind === "cuenta_completa"));
  }

  function clientMatchesFilter(c) {
    if (clientsFilter === "soon") {
      const days = daysLeftFor(c.expiresAt);
      if (days === null || days > 5) return false;
    } else if (clientsFilter === "full") {
      if (!isFullAccountClient(c)) return false;
    } else if (clientsFilter === "profile") {
      if (c.isOverride || isFullAccountClient(c)) return false;
    }
    if (!clientsQuery) return true;
    const hay = [c.clientPhone, c.email, c.platform, platformName(c.platform), c.profileName].join(" ").toLowerCase();
    return clientsQuery.split(/\s+/).every(w => hay.includes(w));
  }

  function clientCardHtml(c) {
    const days   = daysLeftFor(c.expiresAt);
    const tone   = expiryTone(days);
    const status = c.renewalStatus || "";
    const phoneLine = escapeHtml(c.clientPhone) + (c.profileName ? " · " + escapeHtml(c.profileName) : "");

    // "Es para el propio mayorista" (asignada desde el panel admin) — no
    // es un cliente real, así que se marca para no confundirla con uno.
    const tags = [];
    if (c.isOverride) tags.push(`<span class="tag tag-blue">${icon("shield")}Garantía de soporte</span>`);
    if (isFullAccountClient(c)) tags.push(`<span class="tag tag-mango">Cuenta completa</span>`);
    if (isOwnAccount(c.clientPhone)) tags.push(`<span class="tag tag-leaf">${icon("user")}Tu cuenta</span>`);
    if (status === "no") tags.push(`<span class="tag tag-coral">${icon("ban")}No renueva</span>`);

    const head = (menuHtml) => `
        <div class="client-card-head">
          ${platformChip(c.platform)}
          <div class="client-card-id">
            <div class="client-platform">${escapeHtml(platformName(c.platform))}</div>
            <div class="client-phone">${phoneLine}</div>
          </div>
          ${menuHtml}
        </div>
        ${tags.length ? `<div class="client-tags">${tags.join("")}</div>` : ""}
        <div class="client-status tone-${tone}">${escapeHtml(expiryStatusText(c.expiresAt, days))}</div>
        ${c.email ? `<div class="client-email">${icon("mail")}${escapeHtml(c.email)}</div>` : ""}`;

    if (c.isOverride) {
      return `
        <article class="client-card" data-profile-id="${c.id}">
          ${head("")}
          <div class="client-card-actions">
            <button class="btn-ghost btn-sm" data-act="send" data-profile-id="${c.id}" type="button">${icon("send")}Enviar cuenta</button>
          </div>
        </article>`;
    }

    const paid = isRenewalPaid(c);
    const markerItem = paid ? "" : status === "no"
      ? `<button type="button" data-act="marker" data-profile-id="${c.id}">${icon("undo")}Quitar «No renueva»</button>`
      : `<button type="button" data-act="marker" data-profile-id="${c.id}">${icon("ban")}Marcar que no renueva</button>`;
    const menu = `
          <details class="more-menu">
            <summary aria-label="Más acciones" title="Más acciones">${icon("more")}</summary>
            <div class="more-menu-list">
              ${markerItem}
              <button type="button" class="danger" data-act="delete" data-profile-id="${c.id}">${icon("trash")}Eliminar cliente</button>
            </div>
          </details>`;

    const renewBtnHtml = paid
      ? `<button class="btn-primary btn-sm act-renew" data-act="renew" data-profile-id="${c.id}" type="button" disabled>${icon("check")}Pagada</button>`
      : `<button class="btn-primary btn-sm act-renew" data-act="renew" data-profile-id="${c.id}" type="button">Renovar${c.renew ? ` S/ ${escapeHtml(shortPrice(c.renew.price))}` : ""}</button>`;
    const codesBtnHtml = c.codes && c.codes.enabled
      ? `<button class="btn-mango btn-sm" data-act="codes" data-profile-id="${c.id}" type="button" title="Ver el código que llega al correo de esta cuenta" aria-label="Códigos">${icon("key")}<span class="codes-left">${c.codes.open ? "Abierta" : `${c.codes.remaining}/${c.codes.limit}`}</span></button>`
      : "";

    return `
      <article class="client-card" data-profile-id="${c.id}">
        ${head(menu)}
        ${paid ? `<div class="client-paid">${icon("check")}Renovación pagada · se activa al confirmar con el proveedor</div>` : ""}
        <div class="client-card-actions">
          ${renewBtnHtml}
          ${codesBtnHtml}
          <button class="btn-ghost btn-sm" data-act="send" data-profile-id="${c.id}" type="button" title="Enviar los datos por WhatsApp">${icon("send")}Enviar</button>
        </div>
      </article>`;
  }

  function renderClients() {
    const listEl  = document.getElementById("clients-list");
    const emptyEl = document.getElementById("clients-empty");
    const countEl = document.getElementById("clients-count");
    countEl.textContent = String(cachedClients.length);
    countEl.hidden = cachedClients.length === 0;
    const soonCount = cachedClients.filter(c => { const d = daysLeftFor(c.expiresAt); return d !== null && d <= 5; }).length;
    const soonChip = document.querySelector('#clients-filters [data-filter="soon"]');
    if (soonChip) soonChip.textContent = soonCount ? `Por vencer · ${soonCount}` : "Por vencer";

    if (cachedClients.length === 0) {
      listEl.innerHTML = "";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    // Si el menú «⋯» de una tarjeta estaba abierto, sigue abierto tras repintar.
    const openMenu = listEl.querySelector("details.more-menu[open]");
    const openId = openMenu ? openMenu.closest("[data-profile-id]").dataset.profileId : null;
    const visible = cachedClients.filter(clientMatchesFilter);
    listEl.innerHTML = visible.length
      ? visible.map(clientCardHtml).join("")
      : `<p class="empty-state">Ningún cliente coincide con la búsqueda.</p>`;
    if (openId) {
      const again = listEl.querySelector(`[data-profile-id="${openId}"] details.more-menu`);
      if (again) again.open = true;
    }
  }

  async function handleRenewalMarker(client) {
    if (isRenewalPaid(client)) { alert(PAID_MESSAGE); return; }
    const next = (client.renewalStatus || "") === "no" ? "" : "no";
    try {
      const { profile } = await api(`/clients/${client.id}/renewal-marker`, { method: "POST", body: { status: next } });
      client.renewalStatus = profile.renewalStatus;
      renderClients();
      toast(next === "no" ? "Marcado: no renueva" : "Marca quitada");
    } catch (err) {
      alert(err.message);
    }
  }

  // El precio sale SIEMPRE del servidor (el mismo cálculo que el cobro):
  // cuenta completa → precio de cuenta completa; perfil → precio de perfil.
  let renewInFlight = false;
  async function handleRenew(client, btn) {
    if (renewInFlight) return;
    if (client.renewBlocked && !client.renew) { alert(client.renewBlocked); return; }
    if (isRenewalPaid(client)) { alert(PAID_MESSAGE); return; }

    renewInFlight = true;
    const originalHtml = btn ? btn.innerHTML : "";
    if (btn) { btn.disabled = true; btn.textContent = "Calculando…"; }
    try {
      const quote = await api(`/clients/${client.id}/renew-quote`);
      if (quote.alreadyPaid) { alert(PAID_MESSAGE); return; }

      const what = quote.kind === "cuenta_completa" ? "la CUENTA COMPLETA de" : quote.kind === "perfil" ? "el perfil de" : "la cuenta de";
      const after = quote.pending
        ? "La renovación se activa cuando confirmemos la cuenta con el proveedor."
        : "Se suman 30 días a la cuenta.";
      if (!confirm(`¿Renovar ${what} "${client.platform}" (${client.clientPhone})?\nSe descontará S/ ${quote.price} de tu saldo.\n${after}`)) return;

      if (btn) btn.textContent = "Renovando…";
      const { account, pending, message } = await api(`/clients/${client.id}/renew`, {
        method: "POST", body: { expectedPriceCents: quote.priceCents },
      });
      // Cuenta con perfiles: el pago queda registrado y los días se suman
      // cuando confirmamos la cuenta con el proveedor (ver "Renovados").
      if (pending) {
        client.renewalStatus = "yes";
        client.renew = client.renew || { kind: quote.kind, label: quote.label, price: quote.price, priceCents: quote.priceCents, pending: true };
        alert(message || "✅ Pago recibido. La renovación se activa apenas confirmemos con el proveedor.");
      } else {
        if (account) client.expiresAt = account.expiresAt;
        alert(`✅ Renovada. Nueva fecha: ${fmtDate(client.expiresAt)}.`);
      }
      renderClients();
      await refreshBalance();
    } catch (err) {
      alert(err.message);
    } finally {
      renewInFlight = false;
      if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = originalHtml; }
    }
  }

  function handleSendClientAccount(client) {
    // CANVA/GEMINI no tienen contraseña (se activan a mano con el correo).
    const credLine = client.password
      ? `Correo: ${client.email || "—"}\nContraseña: ${client.password}`
      : `Correo (pendiente de activar): ${client.email || "—"}`;
    const profileLine = client.profileName ? `\nPerfil: ${client.profileName}` : "";
    const msg = `Hola! 👋 Te paso los datos de tu cuenta de *${client.platform}*:\n\n${credLine}${profileLine}\n\nCualquier duda me escribes por acá. 🙌`;
    window.open(waLink(client.clientPhone, msg), "_blank");
  }

  async function handleDeleteClient(client) {
    if (!confirm(`¿Eliminar a ${client.clientPhone} (${client.platform})? Se libera el perfil y no se puede deshacer.`)) return;
    try {
      await api(`/clients/${client.id}`, { method: "DELETE" });
      cachedClients = cachedClients.filter(c => c.id !== client.id);
      renderClients();
    } catch (err) {
      alert(err.message);
    }
  }

  function initClientsPage() {
    document.getElementById("clients-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const client = cachedClients.find(c => c.id === Number(btn.dataset.profileId));
      if (!client) return;
      const menu = btn.closest("details.more-menu");
      if (menu) menu.open = false;
      const act = btn.dataset.act;
      if (act === "marker") handleRenewalMarker(client);
      else if (act === "renew") handleRenew(client, btn);
      else if (act === "codes") openCodes(client, btn);
      else if (act === "send") handleSendClientAccount(client);
      else if (act === "delete") handleDeleteClient(client);
    });

    document.getElementById("clients-search").addEventListener("input", (e) => {
      clientsQuery = e.target.value.trim().toLowerCase();
      renderClients();
    });
    document.getElementById("clients-filters").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-filter]");
      if (!chip) return;
      clientsFilter = chip.dataset.filter;
      document.querySelectorAll("#clients-filters .filter-chip").forEach(b => {
        b.classList.toggle("active", b === chip);
        b.setAttribute("aria-pressed", b === chip ? "true" : "false");
      });
      renderClients();
    });
  }

  // ─────────────────────────────────────────────────────────────
  // CÓDIGOS — el mayorista ve el código que llega al correo de su cuenta.
  // Se abre una consulta (el servidor busca solo, por turnos con el
  // proveedor) y acá se lee su estado cada 5 s, igual que la página de
  // códigos del cliente. Límite diario: cuenta completa 10, perfil 3; una
  // consulta abierta se reutiliza sin gastar otra.
  // ─────────────────────────────────────────────────────────────

  const CODES_POLL_MS = 5000;
  const CODES_MANUAL_GAP_MS = 8000;
  let codesState = null;

  function codesApi(token, path, body) {
    return fetch("/api/code-link/" + encodeURIComponent(token) + path, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));
  }

  function codesShow(id) {
    ["codes-s-loading", "codes-s-waiting", "codes-s-found", "codes-s-advisor", "codes-s-closed"]
      .forEach(s => { document.getElementById(s).hidden = s !== id; });
  }

  function codesToast(text) { toast(text); }

  function codesStopTimers() {
    if (!codesState) return;
    clearInterval(codesState.tickId);
    clearTimeout(codesState.totpTimer);
    clearInterval(codesState.totpTick);
  }

  function codesShowClosed(state) {
    if (!codesState) return;
    codesStopTimers();
    codesState.closed = true;
    const timer = document.getElementById("codes-timer");
    timer.className = "codes-timer off";
    timer.textContent = state === "expired" ? "Vencida" : "Cerrada";
    const expired = state === "expired";
    document.getElementById("codes-closed-icon").textContent = expired ? "⏱" : "✓";
    document.getElementById("codes-closed-title").textContent = expired ? "Esta consulta ya venció" : "¡Listo!";
    document.getElementById("codes-closed-text").textContent = expired
      ? "Si todavía necesitas el código, vuelve a tocar «Códigos» (abre una consulta nueva)."
      : "La consulta se cerró. Si necesitas otro código, vuelve a tocar «Códigos».";
    if (codesState.client && codesState.client.codes) codesState.client.codes.open = false;
    document.getElementById("codes-quota").textContent =
      `Te quedan ${codesState.remaining} de ${codesState.limit} consultas hoy para esta cuenta.`;
    codesShow("codes-s-closed");
  }

  function codesPaintButtons() {
    const st = codesState;
    if (!st) return;
    const busy = st.checking || st.serverChecking || Date.now() < st.manualUntil;
    const now = document.getElementById("codes-now");
    now.disabled = busy;
    now.textContent = busy ? "Buscando…" : "Buscar ahora";
    const again = document.getElementById("codes-again");
    again.disabled = st.checking || Date.now() < st.manualUntil;
    again.textContent = again.disabled ? "Buscando…" : "¿No sirvió? Buscar otro";
  }

  function codesTick() {
    const st = codesState;
    if (!st || st.closed) return;
    if (st.expiresAt) {
      const left = Math.max(0, Math.floor((st.expiresAt - (Date.now() + st.skew)) / 1000));
      document.getElementById("codes-timer").textContent = "Vence en " + Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
      if (left <= 0) { codesShowClosed("expired"); return; }
    }
    codesPaintButtons();
    if (!st.checking && Date.now() >= st.nextPollAt && !document.getElementById("codes-s-waiting").hidden) codesCheck();
  }

  function codesApplyInfo(d) {
    const st = codesState;
    if (d.serverNow) st.skew = new Date(d.serverNow).getTime() - Date.now();
    if (d.expiresAt) st.expiresAt = new Date(d.expiresAt).getTime();
  }

  // 2FA (ChatGPT): el código cambia cada 30 s.
  function codesShowTotp(data) {
    const st = codesState;
    clearTimeout(st.totpTimer);
    clearInterval(st.totpTick);
    document.getElementById("codes-found-label").textContent = "TU CÓDIGO DE VERIFICACIÓN (2FA)";
    document.getElementById("codes-value").textContent = data.value;
    document.getElementById("codes-box").classList.toggle("long", String(data.value).length > 6);
    document.getElementById("codes-box").hidden = false;
    document.getElementById("codes-copy").hidden = false;
    document.getElementById("codes-link").hidden = true;
    document.getElementById("codes-approval").hidden = true;
    document.getElementById("codes-mail-toggle").hidden = true;
    document.getElementById("codes-mail").hidden = true;
    document.getElementById("codes-again").hidden = true;
    st.lastValue = data.value;
    let left = Math.max(1, Number(data.secondsRemaining) || 30);
    const meta = document.getElementById("codes-found-meta");
    const bar = document.getElementById("codes-totp-bar");
    bar.hidden = false;
    const paint = () => {
      meta.textContent = "Cambia en " + left + " s";
      bar.firstElementChild.style.width = (left / 30 * 100) + "%";
      bar.classList.toggle("low", left <= 5);
    };
    paint();
    st.totpTick = setInterval(() => { left = Math.max(0, left - 1); paint(); }, 1000);
    st.totpTimer = setTimeout(() => codesCheck(), left * 1000 + 600);
    codesShow("codes-s-found");
  }

  async function codesCheck(flags) {
    const st = codesState;
    if (!st || st.closed || st.checking) return;
    const token = st.token;
    const manual = !!flags;
    st.checking = true;
    codesPaintButtons();
    try {
      const { status, data } = await codesApi(token, "/check", flags);
      if (codesState !== st || st.closed) return;
      codesApplyInfo(data);
      if (status === 410) { codesShowClosed(data.state); return; }
      if (status !== 200) { codesToast(data.message || "No se pudo consultar. Intenta de nuevo."); return; }
      if (data.status === "totp") {
        codesShowTotp(data);
      } else if (data.status === "found") {
        const isLink = data.kind === "link";
        document.getElementById("codes-found-label").textContent = isLink ? "LLEGÓ EL LINK DE INICIO DE SESIÓN" : "LLEGÓ EL CÓDIGO";
        document.getElementById("codes-found-meta").textContent = data.receivedAtLima ? "Llegó a las " + data.receivedAtLima : "";
        document.getElementById("codes-value").textContent = isLink ? "" : data.value;
        document.getElementById("codes-box").classList.toggle("long", !isLink && String(data.value).length > 6);
        document.getElementById("codes-box").hidden = isLink;
        document.getElementById("codes-copy").hidden = false;
        document.getElementById("codes-copy").textContent = isLink ? "Copiar link" : "Copiar";
        document.getElementById("codes-totp-bar").hidden = true;
        document.getElementById("codes-again").hidden = false;
        const a = document.getElementById("codes-link");
        a.hidden = !isLink;
        if (isLink) a.href = data.value;
        // Netflix «Aprueba la nueva solicitud de inicio de sesión» (TV).
        const ap = isLink && data.approval ? data.approval : null;
        document.getElementById("codes-approval").hidden = !ap;
        if (ap) {
          a.hidden = true;
          document.getElementById("codes-found-label").textContent = "SOLICITUD DE INICIO DE SESIÓN";
          document.getElementById("codes-approval-device").textContent = ap.device || "Nuevo dispositivo";
          document.getElementById("codes-approve").href = ap.approveUrl;
          const deny = document.getElementById("codes-deny");
          deny.hidden = !ap.denyUrl;
          if (ap.denyUrl) deny.href = ap.denyUrl;
          document.getElementById("codes-copy").textContent = "Copiar link de Aprobar";
        }
        const frame = document.getElementById("codes-mail");
        document.getElementById("codes-mail-toggle").hidden = !data.html;
        if (data.html && frame.srcdoc !== data.html) frame.srcdoc = data.html;
        if (data.value !== st.lastValue && st.lastValue && !manual) codesToast("Llegó un código nuevo");
        st.lastValue = data.value;
        codesShow("codes-s-found");
      } else if (data.status === "advisor") {
        codesShow("codes-s-advisor");
      } else {
        st.serverChecking = !!data.checking;
        const note = document.getElementById("codes-note");
        note.textContent = data.note || "";
        note.hidden = !data.note;
        codesShow("codes-s-waiting");
      }
    } catch {
      codesToast("Sin conexión. Intenta de nuevo.");
    } finally {
      st.checking = false;
      st.nextPollAt = Date.now() + CODES_POLL_MS;
      codesPaintButtons();
    }
  }

  function codesQuotaText(remaining, limit) {
    return `Consultas de hoy para esta cuenta: te quedan ${remaining} de ${limit}. Mientras esta siga abierta, volver a entrar no gasta otra.`;
  }

  async function openCodes(client, btn) {
    if (btn) btn.disabled = true;
    let opened;
    try {
      opened = await api(`/clients/${client.id}/codes/open`, { method: "POST" });
    } catch (err) {
      // Límite del día agotado: ofrece pedir que se lo restablezcan.
      if (err.status === 429) {
        if (confirm(err.message + "\n\n¿Quieres pedir ahora que te restablezcamos el límite de esta cuenta?")) {
          switchPage("soporte");
          openSupportForm("codes", client.id);
        }
      } else {
        alert(err.message);
      }
      return;
    } finally {
      if (btn) btn.disabled = false;
    }
    if (client.codes) {
      client.codes.open = true;
      client.codes.remaining = opened.remaining;
      if (!opened.reused) client.codes.used = (client.codes.used || 0) + 1;
    }

    codesStopTimers();
    codesState = {
      token: opened.token, client, expiresAt: null, skew: 0, tickId: null, totpTimer: null, totpTick: null,
      lastValue: "", checking: false, serverChecking: false, manualUntil: 0, nextPollAt: 0, closed: false,
      remaining: opened.remaining, limit: opened.limit,
    };
    document.getElementById("codes-plat").innerHTML = platformChip(opened.platform || client.platform, "sm");
    document.getElementById("codes-platform").textContent = platformName(opened.platform || client.platform);
    document.getElementById("codes-sub").textContent =
      (opened.email || client.email || "") + (opened.profileName ? " · Perfil: " + opened.profileName : "");
    document.getElementById("codes-waiting-title").textContent = /netflix/i.test(opened.platform || client.platform)
      ? "Esperando el código o link de inicio de sesión…" : "Esperando el código…";
    document.getElementById("codes-timer").className = "codes-timer";
    document.getElementById("codes-timer").textContent = "";
    document.getElementById("codes-mail").hidden = true;
    document.getElementById("codes-mail-toggle").textContent = "Ver correo completo";
    document.getElementById("codes-note").hidden = true;
    document.getElementById("codes-quota").textContent = codesQuotaText(opened.remaining, opened.limit);
    codesShow("codes-s-loading");
    document.getElementById("codes-modal").hidden = false;

    codesState.tickId = setInterval(codesTick, 1000);
    await codesCheck();
  }

  function closeCodesModal() {
    codesStopTimers();
    codesState = null;
    document.getElementById("codes-modal").hidden = true;
    if (document.querySelector(".page:not([hidden])#page-clientes")) renderClients();
  }

  function initCodesModal() {
    document.getElementById("codes-close").addEventListener("click", closeCodesModal);
    document.getElementById("codes-closed-btn").addEventListener("click", closeCodesModal);
    document.getElementById("codes-now").addEventListener("click", () => {
      if (!codesState) return;
      codesState.manualUntil = Date.now() + CODES_MANUAL_GAP_MS;
      codesCheck({ now: 1 });
    });
    document.getElementById("codes-again").addEventListener("click", () => {
      if (!codesState) return;
      codesState.manualUntil = Date.now() + CODES_MANUAL_GAP_MS;
      codesState.lastValue = "";
      document.getElementById("codes-note").hidden = true;
      codesShow("codes-s-waiting");
      codesCheck({ again: 1 });
    });
    document.getElementById("codes-copy").addEventListener("click", async () => {
      const value = codesState ? codesState.lastValue : "";
      if (!value) return;
      try { await navigator.clipboard.writeText(value); codesToast("Copiado"); } catch { codesToast(value); }
    });
    document.getElementById("codes-mail-toggle").addEventListener("click", (e) => {
      const frame = document.getElementById("codes-mail");
      frame.hidden = !frame.hidden;
      e.currentTarget.textContent = frame.hidden ? "Ver correo completo" : "Ocultar correo";
    });
    document.getElementById("codes-done").addEventListener("click", async () => {
      if (!codesState) return;
      await codesApi(codesState.token, "/close").catch(() => {});
      codesShowClosed("closed");
    });
  }

  // ─────────────────────────────────────────────────────────────
  // CUENTAS — perfiles ya asignados + pedidos de cuenta completa.
  // ─────────────────────────────────────────────────────────────

  let cachedFullOrders = [];

  const ORDER_STATUS_LABEL = { queued: "En cola", prepared: "Preparada", delivered: "Entregada", cancelled: "Cancelada" };

  async function loadCuentas() {
    try { await api("/accounts/mark-seen", { method: "POST" }); } catch { /* no crítico */ }
    updateBadge(0);

    const profilesList = document.getElementById("cuentas-profiles-list");
    const ordersList    = document.getElementById("cuentas-orders-list");
    profilesList.innerHTML = `<p class="muted small">Cargando…</p>`;
    ordersList.innerHTML = "";

    try {
      const [, { profiles, fullAccountOrders }] = await Promise.all([fetchCatalog(), api("/accounts")]);
      renderCuentasProfiles(profiles || []);
      cachedFullOrders = fullAccountOrders || [];
      renderCuentasOrders();
    } catch (err) {
      profilesList.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function cuentaProfileCardHtml(p) {
    const days = daysLeftFor(p.expiresAt);
    return `
      <article class="client-card">
        <div class="client-card-head">
          ${platformChip(p.platform)}
          <div class="client-card-id">
            <div class="client-platform">${escapeHtml(platformName(p.platform))}</div>
            <div class="client-phone">${escapeHtml(p.clientPhone)}${p.profileName ? " · " + escapeHtml(p.profileName) : ""}</div>
          </div>
        </div>
        ${isOwnAccount(p.clientPhone) ? `<div class="client-tags"><span class="tag tag-leaf">${icon("user")}Tu cuenta</span></div>` : ""}
        <div class="client-status tone-${expiryTone(days)}">${escapeHtml(expiryStatusText(p.expiresAt, days))}</div>
        ${p.email ? `<div class="client-email">${icon("mail")}${escapeHtml(p.email)}</div>` : ""}
        <div class="client-card-actions">
          <button class="btn-ghost btn-sm" data-act="send" data-phone="${escapeHtml(p.clientPhone)}" data-platform="${escapeHtml(p.platform)}" data-email="${escapeHtml(p.email || "")}" data-password="${escapeHtml(p.password || "")}" type="button">${icon("send")}Enviar cuenta</button>
        </div>
      </article>`;
  }

  function renderCuentasProfiles(profiles) {
    const listEl  = document.getElementById("cuentas-profiles-list");
    const emptyEl = document.getElementById("cuentas-profiles-empty");
    if (profiles.length === 0) {
      listEl.innerHTML = "";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    listEl.innerHTML = profiles.map(cuentaProfileCardHtml).join("");
  }

  function orderCardHtml(o) {
    const statusLabel = ORDER_STATUS_LABEL[o.status] || o.status;
    let credsHtml = "";
    let actionsHtml = "";
    if (o.status === "delivered" && o.deliveredAccountEmail) {
      credsHtml = `
        <div class="order-creds">
          <div><b>Correo:</b> ${escapeHtml(o.deliveredAccountEmail)}</div>
          <div><b>Contraseña:</b> ${escapeHtml(o.deliveredAccountPassword)}</div>
        </div>`;
      actionsHtml = `
        <div class="client-card-actions">
          <button class="btn-ghost btn-sm" data-act="send-order" data-id="${o.id}" type="button">${icon("send")}Enviar al cliente</button>
        </div>`;
    }
    const metaLine = o.status === "delivered"
      ? `Entregado: ${escapeHtml(fmtDateTime(o.deliveredAt))}`
      : `Antes de: ${escapeHtml(fmtDateTime(o.dueBy))}`;
    return `
      <article class="order-card">
        <div class="order-card-head">
          ${platformChip(o.platform)}
          <div class="order-platform">${escapeHtml(platformName(o.platform))} ×${o.quantity}
            <div class="order-meta">Cliente: ${escapeHtml(o.endClientPhone)} · ${money(o.totalCents)}</div>
          </div>
          <span class="status-chip status-${escapeHtml(o.status)}">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="order-meta">${metaLine}</div>
        ${credsHtml}
        ${actionsHtml}
      </article>`;
  }

  function renderCuentasOrders() {
    const listEl  = document.getElementById("cuentas-orders-list");
    const emptyEl = document.getElementById("cuentas-orders-empty");
    if (cachedFullOrders.length === 0) {
      listEl.innerHTML = "";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    listEl.innerHTML = cachedFullOrders.map(orderCardHtml).join("");
  }

  function initCuentasPage() {
    document.getElementById("cuentas-profiles-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act='send']");
      if (!btn) return;
      const credLine = btn.dataset.password
        ? `Correo: ${btn.dataset.email || "—"}\nContraseña: ${btn.dataset.password}`
        : `Correo (pendiente de activar): ${btn.dataset.email || "—"}`;
      const msg = `Hola! 👋 Te paso los datos de tu cuenta de *${btn.dataset.platform}*:\n\n${credLine}\n\nCualquier duda me escribes por acá. 🙌`;
      window.open(waLink(btn.dataset.phone, msg), "_blank");
    });

    document.getElementById("cuentas-orders-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act='send-order']");
      if (!btn) return;
      const order = cachedFullOrders.find(o => o.id === Number(btn.dataset.id));
      if (!order) return;
      const msg = `Hola! 🎉 Tu cuenta completa de *${order.platform}* ya está lista:\n\nCorreo: ${order.deliveredAccountEmail}\nContraseña: ${order.deliveredAccountPassword}\n\n¡Gracias por tu compra! 🙌`;
      window.open(waLink(order.endClientPhone, msg), "_blank");
    });
  }

  // ─────────────────────────────────────────────────────────────
  // INICIO — saldo + stats + próximos vencimientos + accesos rápidos.
  // Reemplaza a la vieja pantalla "Resumen" (ahora es la pantalla de
  // aterrizaje tras el login, ver onAuthenticated).
  // ─────────────────────────────────────────────────────────────

  const HOME_EXPIRING_DAYS = 5;
  const HOME_EXPIRING_MAX  = 5;

  function homeAlertRowHtml(c) {
    const days = daysLeftFor(c.expiresAt);
    const full = c.renew && c.renew.kind === "cuenta_completa";
    const price = c.renew ? ` S/ ${escapeHtml(shortPrice(c.renew.price))}` : "";
    return `
      <div class="alert-row" data-profile-id="${c.profileId}">
        ${platformChip(c.platform, "sm")}
        <div class="alert-row-main">
          <div class="alert-row-plat">${escapeHtml(platformName(c.platform))}${full ? " · completa" : ""}</div>
          <div class="alert-row-sub${days !== null && days <= 1 ? " soon" : ""}">${escapeHtml(c.clientPhone)} · ${escapeHtml(whenText(days))}</div>
        </div>
        <button class="pill-btn" data-act="home-renew" data-profile-id="${c.profileId}" type="button">Renovar${price}</button>
      </div>`;
  }

  let cachedHomeExpiring = [];

  async function loadInicio() {
    const statActive   = document.getElementById("home-stat-active");
    const statExpiring = document.getElementById("home-stat-expiring");
    const statTotal    = document.getElementById("home-stat-total");
    const alertsList    = document.getElementById("home-alerts-list");
    const alertsEmpty   = document.getElementById("home-alerts-empty");

    await Promise.all([refreshBalance(), fetchCatalog()]);

    try {
      const { activeCount, expiringCount, totalClients } = await api("/summary");
      statActive.textContent   = activeCount;
      statExpiring.textContent = expiringCount;
      statTotal.textContent    = totalClients;
    } catch {
      statActive.textContent = statExpiring.textContent = statTotal.textContent = "—";
    }

    try {
      const { clients } = await api(`/renewals/expiring?days=${HOME_EXPIRING_DAYS}`);
      cachedHomeExpiring = (clients || []).slice(0, HOME_EXPIRING_MAX);
      if (cachedHomeExpiring.length === 0) {
        alertsList.innerHTML = "";
        alertsEmpty.hidden = false;
      } else {
        alertsEmpty.hidden = true;
        alertsList.innerHTML = cachedHomeExpiring.map(homeAlertRowHtml).join("");
      }
    } catch {
      cachedHomeExpiring = [];
      alertsList.innerHTML = "";
      alertsEmpty.hidden = false;
    }
  }

  function initInicioPage() {
    document.getElementById("home-alerts-list").addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-act='home-renew']");
      if (!btn) return;
      const c = cachedHomeExpiring.find(x => x.profileId === Number(btn.dataset.profileId));
      if (!c) return;
      await handleRenew({
        id: c.profileId, platform: c.platform, clientPhone: c.clientPhone, expiresAt: c.expiresAt,
        renew: c.renew, renewBlocked: c.renewBlocked,
      }, btn);
      loadInicio();
    });
  }

  // ─────────────────────────────────────────────────────────────
  // CRÉDITOS — saldo, historial y recarga por Yape.
  // ─────────────────────────────────────────────────────────────

  const LEDGER_TYPE_LABEL = {
    topup_yape:             "Recarga Yape",
    gift_course:            "Regalo curso",
    topup_manual_admin:     "Recarga manual (admin)",
    debit_manual_admin:     "Ajuste del admin",
    purchase_profile:       "Compra de perfil",
    purchase_full_account:  "Compra de cuenta completa",
    renewal:                "Renovación",
    wipe_inactive:          "Saldo retirado por inactividad",
  };

  function ledgerRowHtml(entry) {
    const positive = entry.amountCents >= 0;
    const label = LEDGER_TYPE_LABEL[entry.type] || entry.type;
    return `
      <div class="ledger-row">
        <span class="ledger-ic${positive ? "" : " neg"}">${icon(positive ? "plus" : "arrowUp")}</span>
        <div class="ledger-row-left">
          <div class="ledger-type">${escapeHtml(label)}</div>
          <div class="ledger-meta">${escapeHtml(fmtDateTime(entry.createdAt))} · Saldo: ${money(entry.balanceAfterCents)}</div>
        </div>
        <div class="ledger-amount ${positive ? "ledger-amount-pos" : "ledger-amount-neg"}">${positive ? "+" : ""}${money(entry.amountCents)}</div>
      </div>`;
  }

  async function loadCreditos() {
    await refreshBalance();
    const listEl = document.getElementById("ledger-list");
    listEl.innerHTML = `<p class="muted small">Cargando…</p>`;
    try {
      const { entries } = await api("/ledger");
      listEl.innerHTML = (entries && entries.length)
        ? entries.map(ledgerRowHtml).join("")
        : `<p class="empty-state">Todavía no hay movimientos en tu cuenta.</p>`;
    } catch (err) {
      listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  // ── Recarga Yape — el crédito llega async cuando el bot detecta el
  // pago; acá solo se muestra el monto exacto a pagar + el QR si el panel
  // admin lo tiene configurado (si no, se degrada a solo texto/monto). ──

  let cachedYapeQr   = null;
  let cachedYapeText = "";

  async function ensureYapeInfo() {
    if (cachedYapeQr !== null) return;
    try {
      const { methods } = await api("/payment-methods");
      const yape = (methods || []).find(m => (m.name || "").toLowerCase().includes("yape"));
      cachedYapeQr   = yape && yape.imageUrl ? yape.imageUrl : "";
      cachedYapeText = yape ? yape.description : "";
    } catch {
      // Sin endpoint de métodos de pago propio del mayorista todavía —
      // se degrada con gracia: sin QR, solo el monto + instrucciones genéricas.
      cachedYapeQr = "";
    }
  }

  function showCheckoutState(state) {
    ["loading", "ready", "error"].forEach(s => {
      document.getElementById("checkout-" + s).hidden = s !== state;
    });
  }

  async function startTopup(amount) {
    document.getElementById("checkout-modal").hidden = false;
    showCheckoutState("loading");
    try {
      const order = await api("/topup", { method: "POST", body: { amount } });
      await ensureYapeInfo();

      document.getElementById("checkout-amount").textContent = "S/ " + order.amount;
      document.getElementById("checkout-amount-copy").dataset.copy = order.amount;

      const qrImg = document.getElementById("checkout-qr");
      if (cachedYapeQr) { qrImg.src = cachedYapeQr; qrImg.hidden = false; } else { qrImg.hidden = true; }

      document.getElementById("checkout-instructions").textContent = cachedYapeText
        || "Yapea el monto exacto de arriba. En cuanto se detecte tu pago, el saldo se acredita solo — vuelve a esta pantalla en un minuto para verlo reflejado.";

      document.getElementById("checkout-support-link").href = "https://wa.me/" + SUPPORT_PHONE
        + "?text=" + encodeURIComponent(`Hola, soy mayorista y tengo dudas con mi recarga de S/ ${order.amount} por Yape.`);

      showCheckoutState("ready");
    } catch (err) {
      document.getElementById("checkout-error-text").textContent = err.message;
      showCheckoutState("error");
    }
  }

  function closeCheckout() {
    document.getElementById("checkout-modal").hidden = true;
    refreshBalance();
  }

  async function handleYapeCopyClick(e) {
    const btn = e.target.closest(".yape-copy-btn");
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      const original = btn.innerHTML;
      btn.innerHTML = icon("check");
      setTimeout(() => { btn.innerHTML = original; }, 1200);
    } catch {
      alert("No se pudo copiar. Copia manualmente: " + btn.dataset.copy);
    }
  }

  function initCreditosPage() {
    document.querySelectorAll(".topup-btn").forEach(btn => {
      btn.addEventListener("click", () => startTopup(Number(btn.dataset.amount)));
    });
    document.getElementById("credits-refresh-btn").addEventListener("click", refreshBalance);
    document.getElementById("checkout-close").addEventListener("click", closeCheckout);
    document.getElementById("checkout-retry").addEventListener("click", closeCheckout);
    document.getElementById("checkout-done-btn").addEventListener("click", closeCheckout);
    document.getElementById("checkout-amount-copy").addEventListener("click", handleYapeCopyClick);
  }

  // ─────────────────────────────────────────────────────────────
  // COMPRAR — grilla de catálogo mayorista + carrito sin descuentos
  // (el precio mayorista YA es el precio final) + pedido de cuenta
  // completa a medida.
  // ─────────────────────────────────────────────────────────────

  let cartItems = []; // [{ platform, qty }]
  let lastPurchaseAccounts = [];
  let lastPurchaseClientPhone = "";

  // GEMINI: precio según el plan elegido (1, 3, 6 o 12 meses).
  function itemUnitPrice(i) {
    const p = catalogItem(i.platform);
    if (!p) return 0;
    if (Array.isArray(p.plans) && p.plans.length) {
      const plan = p.plans.find(pl => pl.months === i.months) || p.plans[0];
      return Number(plan.price);
    }
    return Number(p.wholesalePrice);
  }

  function cartQtyFor(platform) {
    const item = cartItems.find(i => i.platform === platform);
    return item ? item.qty : 0;
  }

  function catalogCardHtml(p) {
    const qty = cartQtyFor(p.platform);
    const img = mediaHtml(p.imageUrl, (p.platform || "").slice(0, 3).toUpperCase());
    // CANVA/GEMINI se activan a mano con el correo del cliente — una
    // unidad a la vez (cada una es un correo distinto), nunca "disponibles".
    const maxQty = p.requiresEmail ? 1 : p.freeStock;
    const stockText = p.requiresEmail ? "Activación por correo" : `${p.freeStock} disponible${p.freeStock === 1 ? "" : "s"}`;
    const stepper = qty > 0
      ? `<div class="catalog-qty-stepper">
           <button class="qty-btn" data-act="dec" data-platform="${escapeHtml(p.platform)}" type="button" aria-label="Quitar uno">−</button>
           <span class="qty-value">${qty}</span>
           <button class="qty-btn" data-act="inc" data-platform="${escapeHtml(p.platform)}" type="button" aria-label="Agregar uno" ${qty >= maxQty ? "disabled" : ""}>+</button>
         </div>`
      : `<button class="catalog-add-btn" data-act="inc" data-platform="${escapeHtml(p.platform)}" type="button" aria-label="Agregar al carrito">${icon("plus")}</button>`;
    return `
      <div class="catalog-card">
        <div class="catalog-card-img">${img}</div>
        <div class="catalog-card-body">
          <div class="catalog-card-title">${escapeHtml(p.title)}</div>
          <div class="catalog-card-price">${Array.isArray(p.plans) && p.plans.length ? "Desde " : ""}S/ ${escapeHtml(p.wholesalePrice)}</div>
          <div class="catalog-card-stock">${stockText}</div>
        </div>
        ${stepper}
      </div>`;
  }

  // Cada tarjeta se rehace solo si cambió (precio, stock o cantidad en el
  // carrito) — las demás quedan quietas: nada de parpadeo.
  function renderComprarGrid() {
    const grid  = document.getElementById("catalog-grid");
    const empty = document.getElementById("catalog-empty");
    empty.hidden = cachedCatalog.length > 0;
    patchKeyed(grid, cachedCatalog.map(p => ({ key: p.platform, html: catalogCardHtml(p) })));
    renderCart();
  }

  function cartTotalCents() {
    return cartItems.reduce((sum, i) => sum + Math.round(itemUnitPrice(i) * 100) * i.qty, 0);
  }

  function itemPlans(i) {
    const p = catalogItem(i.platform);
    return p && Array.isArray(p.plans) && p.plans.length ? p.plans : null;
  }

  // El plan elegido siempre es uno que existe (si el catálogo cambió, el primero).
  function syncCartPlans() {
    cartItems.forEach(i => {
      const plans = itemPlans(i);
      if (!plans) { delete i.months; return; }
      if (!plans.some(pl => pl.months === i.months)) i.months = plans[0].months;
    });
  }

  function planLabelFor(i) {
    const plans = itemPlans(i);
    const plan = plans && plans.find(pl => pl.months === i.months);
    return plan ? plan.label : "";
  }

  // La fila no lleva el plan elegido ni el precio: así cambiar de plan no
  // rehace el desplegable (se actualizan aparte, abajo).
  function cartRowHtml(i) {
    const p = catalogItem(i.platform);
    const title = p ? p.title : i.platform;
    const plans = itemPlans(i);
    const planSelect = plans
      ? `<select class="cart-plan-select" data-platform="${escapeHtml(i.platform)}" aria-label="Duración">
           ${plans.map(pl => `<option value="${pl.months}">${escapeHtml(pl.label)} · S/ ${escapeHtml(pl.price)}</option>`).join("")}
         </select>`
      : "";
    return `<div class="cart-row"><span>${escapeHtml(title)} ×${i.qty}${planSelect}</span><span class="cart-row-price"></span></div>`;
  }

  function renderCart() {
    const card   = document.getElementById("cart-card");
    const list   = document.getElementById("cart-list");
    const totalEl = document.getElementById("cart-total-value");
    const buyBtn  = document.getElementById("cart-buy-btn");

    if (cartItems.length === 0) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    syncCartPlans();
    patchKeyed(list, cartItems.map(i => ({ key: i.platform, html: cartRowHtml(i) })));
    cartItems.forEach(i => {
      const row = keyedChild(list, i.platform);
      if (!row) return;
      const sel = row.querySelector(".cart-plan-select");
      if (sel && i.months && sel.value !== String(i.months)) sel.value = String(i.months);
      const priceText = "S/ " + (itemUnitPrice(i) * i.qty).toFixed(2);
      const priceEl = row.querySelector(".cart-row-price");
      if (priceEl.textContent !== priceText) priceEl.textContent = priceText;
    });
    const totalText = money(cartTotalCents());
    if (totalEl.textContent !== totalText) totalEl.textContent = totalText;
    buyBtn.disabled = false;
  }

  function renderFullOrderPlatformOptions() {
    const select = document.getElementById("full-order-platform");
    if (!select) return;
    const previous = select.value;
    // Solo plataformas con precio de cuenta completa configurado (>0) —
    // sin esto se veían opciones "S/ 0" que el admin nunca llegó a precificar.
    const options = cachedCatalog.filter(p => Number(p.wholesaleFullPrice) > 0);
    const changed = setHtmlIfChanged(select, options.length
      ? options.map(p => `<option value="${escapeHtml(p.platform)}">${escapeHtml(p.title)} — S/ ${escapeHtml(p.wholesaleFullPrice)}</option>`).join("")
      : `<option value="">Sin plataformas disponibles</option>`);
    if (changed && previous && options.some(p => p.platform === previous)) select.value = previous;
  }

  async function loadComprar() {
    const grid = document.getElementById("catalog-grid");
    // «Cargando…» solo la primera vez: después se deja lo que ya se ve
    // y se actualiza en su sitio cuando llegan los datos.
    if (!grid.querySelector(".catalog-card")) grid.innerHTML = `<p class="muted small">Cargando…</p>`;
    try {
      await fetchCatalog();
      renderComprarGrid();
      renderFullOrderPlatformOptions();
    } catch (err) {
      if (!grid.querySelector(".catalog-card")) grid.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function purchaseAccountCardHtml(a, idx) {
    // CANVA/GEMINI no generan contraseña — se activan a mano con el
    // correo, así que ese renglón no aplica (y el mensaje de WhatsApp
    // tampoco debe ofrecer una contraseña vacía).
    return `
      <div class="success-account-card">
        <div class="success-account-head">
          ${platformChip(a.platform, "sm")}
          <span class="success-account-platform">${escapeHtml(platformName(a.platform))}</span>
        </div>
        <div class="success-account-row"><b>Correo:</b> ${escapeHtml(a.email)}</div>
        ${a.planLabel ? `<div class="success-account-row"><b>Plan:</b> ${escapeHtml(a.planLabel)}${a.expiresAt ? " · vence " + escapeHtml(a.expiresAt) : ""}</div>` : ""}
        ${a.password ? `<div class="success-account-row"><b>Contraseña:</b> ${escapeHtml(a.password)}</div>` : `<div class="muted small">Se activa a mano en ese correo — te avisamos cuando esté lista.</div>`}
        ${a.profileName ? `<div class="success-account-row"><b>Perfil:</b> ${escapeHtml(a.profileName)}</div>` : ""}
        <div class="success-account-actions">
          <button class="btn-wa btn-xs" data-act="send" data-idx="${idx}" type="button">${icon("send")}Enviar</button>
          <button class="btn-ghost btn-xs" data-act="copy" data-idx="${idx}" type="button">${icon("copy")}Copiar</button>
        </div>
      </div>`;
  }

  function showPurchaseSuccess(accounts, clientPhone) {
    lastPurchaseAccounts = accounts || [];
    lastPurchaseClientPhone = clientPhone;
    document.getElementById("purchase-success-list").innerHTML = lastPurchaseAccounts.map(purchaseAccountCardHtml).join("");
    document.getElementById("purchase-success-modal").hidden = false;
  }

  function initComprarPage() {
    document.getElementById("catalog-grid").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act][data-platform]");
      if (!btn) return;
      const platform = btn.dataset.platform;
      const product = catalogItem(platform);
      if (!product) return;
      let item = cartItems.find(i => i.platform === platform);
      const maxQty = product.requiresEmail ? 1 : product.freeStock;
      if (btn.dataset.act === "inc") {
        // Solo se agrega al carrito si de verdad hay stock para sumar —
        // antes se creaba el item en 0 igual, y quedaba un "×0" fantasma.
        if ((item?.qty ?? 0) < maxQty) {
          if (!item) {
            item = { platform, qty: 0 };
            if (Array.isArray(product.plans) && product.plans.length) item.months = product.plans[0].months;
            cartItems.push(item);
          }
          item.qty++;
        }
      } else if (btn.dataset.act === "dec" && item) {
        item.qty--;
        if (item.qty <= 0) cartItems = cartItems.filter(i => i !== item);
      }
      renderComprarGrid();
    });

    document.getElementById("cart-list").addEventListener("change", (e) => {
      const sel = e.target.closest(".cart-plan-select");
      if (!sel) return;
      const item = cartItems.find(i => i.platform === sel.dataset.platform);
      if (item) item.months = Number(sel.value);
      renderCart();
    });

    document.getElementById("cart-buy-btn").addEventListener("click", () => {
      if (cartItems.length === 0) return;
      document.getElementById("cart-checkout-phone").value = "";
      setFormError("cart-checkout-error", "");

      // CANVA/GEMINI/YOUTUBE piden el correo del cliente final — un input
      // por cada una que esté en el carrito (siempre qty=1 para estas).
      // YOUTUBE además pide la contraseña (se activa sobre la cuenta
      // propia del cliente, no una invitación).
      syncCartPlans();
      const emailItems = cartItems.filter(i => catalogItem(i.platform)?.requiresEmail);
      document.getElementById("cart-checkout-emails").innerHTML = emailItems.map(i => {
        const title = catalogItem(i.platform)?.title || i.platform;
        const planLabel = planLabelFor(i); // el plan que se va a cobrar, a la vista
        const needsPassword = !!catalogItem(i.platform)?.requiresPassword;
        return `
          <label class="label" for="cart-email-${escapeHtml(i.platform)}">Correo para activar ${escapeHtml(title)}${planLabel ? ` (${escapeHtml(planLabel)})` : ""}</label>
          <input type="email" class="input cart-checkout-email-input" id="cart-email-${escapeHtml(i.platform)}" data-platform="${escapeHtml(i.platform)}"
            placeholder="cliente@correo.com">
          ${needsPassword ? `
            <label class="label" for="cart-password-${escapeHtml(i.platform)}">Contraseña de esa cuenta</label>
            <input type="password" class="input cart-checkout-password-input" id="cart-password-${escapeHtml(i.platform)}" data-platform="${escapeHtml(i.platform)}"
              placeholder="Contraseña">
          ` : ""}
        `;
      }).join("");

      document.getElementById("cart-checkout-modal").hidden = false;
    });

    document.getElementById("cart-checkout-close").addEventListener("click", () => {
      document.getElementById("cart-checkout-modal").hidden = true;
    });

    document.getElementById("cart-checkout-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      setFormError("cart-checkout-error", "");
      const rawPhone = document.getElementById("cart-checkout-phone").value.trim();
      const clientPhone = rawPhone.replace(/\D/g, "");
      if (clientPhone.length < 9) { setFormError("cart-checkout-error", "Celular del cliente inválido."); return; }

      const emails = {};
      for (const input of document.querySelectorAll(".cart-checkout-email-input")) {
        const email = input.value.trim();
        if (!isValidEmail(email)) {
          setFormError("cart-checkout-error", "Escribe un correo válido para cada plataforma de activación manual.");
          return;
        }
        emails[input.dataset.platform] = email;
      }

      const passwords = {};
      for (const input of document.querySelectorAll(".cart-checkout-password-input")) {
        const password = input.value;
        if (!password.trim()) {
          setFormError("cart-checkout-error", "Escribe la contraseña de la cuenta a activar.");
          return;
        }
        passwords[input.dataset.platform] = password;
      }

      // Los meses van tal cual el desplegable del carrito (el servidor
      // recalcula el precio con ese mismo plan).
      syncCartPlans();
      const platforms = [];
      const months = {};
      cartItems.forEach(i => {
        for (let n = 0; n < i.qty; n++) platforms.push(i.platform);
        if (itemPlans(i) && i.months) months[i.platform] = i.months;
      });

      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const result = await api("/purchase", { method: "POST", body: { platforms, clientPhone, emails, passwords, months } });
        document.getElementById("cart-checkout-modal").hidden = true;
        cartItems = [];
        showPurchaseSuccess(result.accounts, clientPhone);
        await Promise.all([fetchCatalog(), refreshBalance()]);
        renderComprarGrid();
        renderFullOrderPlatformOptions();
      } catch (err) {
        setFormError("cart-checkout-error", err.message);
      } finally {
        submitBtn.disabled = false;
      }
    });

    document.getElementById("purchase-success-list").addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const account = lastPurchaseAccounts[Number(btn.dataset.idx)];
      if (!account) return;
      if (btn.dataset.act === "send") {
        const credLine = account.password ? `Correo: ${account.email}\nContraseña: ${account.password}` : `Correo (pendiente de activar): ${account.email}`;
        const profileLine = account.profileName ? `\nPerfil: ${account.profileName}` : "";
        const msg = `Hola! 👋 Te paso los datos de tu cuenta de *${account.platform}*:\n\n${credLine}${profileLine}\n\n¡Gracias por tu compra! 🙌`;
        window.open(waLink(lastPurchaseClientPhone, msg), "_blank");
      } else if (btn.dataset.act === "copy") {
        try {
          const credLine = account.password ? `Correo: ${account.email}\nContraseña: ${account.password}` : `Correo (pendiente de activar): ${account.email}`;
          const profileLine = account.profileName ? `\nPerfil: ${account.profileName}` : "";
          await navigator.clipboard.writeText(`${account.platform}\n${credLine}${profileLine}`);
          const original = btn.innerHTML;
          btn.innerHTML = icon("check") + "Copiado";
          setTimeout(() => { btn.innerHTML = original; }, 1500);
        } catch {
          alert("No se pudo copiar. Copia los datos manualmente.");
        }
      }
    });

    document.getElementById("purchase-success-close").addEventListener("click", () => {
      document.getElementById("purchase-success-modal").hidden = true;
    });
    document.getElementById("purchase-success-close-x").addEventListener("click", () => {
      document.getElementById("purchase-success-modal").hidden = true;
    });

    document.getElementById("full-order-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      setFormError("full-order-error", "");
      const platform = document.getElementById("full-order-platform").value;
      const quantity = Math.max(1, Number(document.getElementById("full-order-quantity").value) || 1);
      const rawPhone = document.getElementById("full-order-phone").value.trim();
      const clientPhone = rawPhone.replace(/\D/g, "");

      if (!platform) { setFormError("full-order-error", "Elige una plataforma."); return; }
      if (clientPhone.length < 9) { setFormError("full-order-error", "Celular del cliente inválido."); return; }

      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const { order } = await api("/full-account-orders", { method: "POST", body: { platform, quantity, clientPhone } });
        e.target.reset();
        document.getElementById("full-order-quantity").value = 1;
        renderFullOrderPlatformOptions();
        await refreshBalance();
        setFormError("full-order-error", "");
        alert(`Pedido registrado — te la entregamos antes de ${fmtDateTime(order.dueBy)} (máx. 5 horas).`);
      } catch (err) {
        setFormError("full-order-error", err.message);
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // RECORDATORIOS — tanda manual de WhatsApp a los PROPIOS sub-clientes.
  // Mismo mecanismo que public/js/app.js::prepareReminderBatch (ventanas
  // pre-abiertas sincrónicamente para esquivar el bloqueador de pop-ups,
  // asignadas una por una con un cooldown entre cada una).
  // ─────────────────────────────────────────────────────────────

  const REMINDERS_BATCH_SIZE  = 5;
  const REMINDERS_COOLDOWN_MS = 3000;
  let cachedExpiringClients   = [];

  function isValidReminderPhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    return digits.length >= 9 && digits.length <= 12;
  }

  function formatReminderPrice(price) {
    const num = parseFloat(price);
    if (!Number.isFinite(num)) return "";
    return Number.isInteger(num) ? String(num) : num.toFixed(2);
  }

  function reminderMessage(client) {
    const tag   = (client.platformTag || client.platform || "").trim();
    const price = formatReminderPrice(client.price);
    const accountLine = tag ? ` de *${tag}*` : "";
    const priceLine   = price ? ` Son S/ ${price}.` : "";
    const dateLine    = client.expiresAt ? ` (vence el ${fmtDate(client.expiresAt)})` : "";
    return `Hola! 👋 Tu cuenta${accountLine} está por vencer pronto${dateLine}.${priceLine}\n\n` +
      "Si quieres renovarla, contáctanos por acá y lo coordinamos.\n\n" +
      "¡Gracias por tu confianza! 🙌";
  }

  function renderRemindersSummary() {
    const valid       = cachedExpiringClients.filter(c => isValidReminderPhone(c.clientPhone));
    const pending     = valid.filter(c => !c.reminderSentAt);
    const sent        = valid.length - pending.length;
    const batchesLeft = Math.ceil(pending.length / REMINDERS_BATCH_SIZE);
    const el = document.getElementById("reminders-summary");
    if (valid.length === 0) {
      el.textContent = "No hay clientes por vencer hoy.";
      return;
    }
    el.textContent = `${pending.length} pendientes de recordatorio · ${batchesLeft} tanda${batchesLeft === 1 ? "" : "s"} de ${REMINDERS_BATCH_SIZE} por mandar · ${sent} ya recordados`;
  }

  function renderRemindersList() {
    const listEl = document.getElementById("reminders-list");
    if (cachedExpiringClients.length === 0) {
      listEl.innerHTML = `<p class="empty-state">No hay clientes por vencer hoy.</p>`;
      return;
    }
    listEl.innerHTML = cachedExpiringClients.map(c => `
      <div class="reminder-row ${c.reminderSentAt ? "reminder-row-sent" : ""}">
        <span><span class="reminder-tag">${escapeHtml(c.platformTag || c.platform)}</span> · ${escapeHtml(c.clientPhone)}</span>
        ${c.reminderSentAt ? `<span class="reminder-sent-chip">✓ Recordado</span>` : `<span class="muted small">Vence: ${escapeHtml(fmtDate(c.expiresAt))}</span>`}
      </div>
    `).join("");
  }

  async function loadReminders() {
    const summaryEl = document.getElementById("reminders-summary");
    try {
      const { clients } = await api("/renewals/expiring?days=0");
      cachedExpiringClients = clients || [];
    } catch (err) {
      cachedExpiringClients = [];
      summaryEl.textContent = err.message;
      renderRemindersList();
      return;
    }
    renderRemindersSummary();
    renderRemindersList();
  }

  async function prepareReminderBatch(btn) {
    const pending = cachedExpiringClients.filter(c => !c.reminderSentAt && isValidReminderPhone(c.clientPhone));
    if (pending.length === 0) {
      alert("No quedan clientes pendientes de recordatorio por hoy.");
      return;
    }
    const batch = pending.slice(0, REMINDERS_BATCH_SIZE);

    // Mismo truco que el envío masivo del panel admin: las ventanas se
    // abren TODAS durante el clic real (si no, el navegador las bloquea
    // como pop-up no solicitado) y recién después se les asigna el link,
    // una por una con una pequeña pausa entre cada una.
    const windows = batch.map(() => window.open("", "_blank"));
    const somethingBlocked = windows.some(w => !w);

    const original = btn.textContent;
    btn.disabled = true;

    for (let i = 0; i < batch.length; i++) {
      const link = waLink(batch[i].clientPhone, reminderMessage(batch[i]));
      if (windows[i]) windows[i].location = link;
      try {
        await api(`/renewals/${batch[i].profileId}/mark-reminded`, { method: "POST" });
        batch[i].reminderSentAt = new Date().toISOString(); // optimista
      } catch { /* no crítico */ }
      btn.textContent = `Preparando ${i + 1}/${batch.length}…`;
      if (i < batch.length - 1) await sleep(REMINDERS_COOLDOWN_MS);
    }

    btn.disabled = false;
    btn.textContent = original;

    if (somethingBlocked) {
      alert("El navegador bloqueó una o más ventanas. Permite las ventanas emergentes para este sitio e inténtalo de nuevo.");
    }
    renderRemindersSummary();
    renderRemindersList();
  }

  function initRemindersPage() {
    document.getElementById("reminders-prepare-btn").addEventListener("click", (e) => prepareReminderBatch(e.currentTarget));
  }

  // ─────────────────────────────────────────────────────────────
  // SOPORTE — restablecer el límite de códigos de una cuenta, reportar un
  // problema con la cuenta de un cliente, o escribir por WhatsApp. Los
  // reportes llegan al panel (Soportes) y la respuesta vuelve por la
  // campanita; acá se ve el estado de cada uno («Mis reportes»).
  // ─────────────────────────────────────────────────────────────

  let supportReasons = [];
  let supportKind    = "account";
  let cachedTickets  = [];

  const SUPPORT_COPY = {
    codes: {
      icon: "key", tone: "tone-mango", title: "Restablecer límite de códigos", submit: "Pedir restablecer",
      sub: "Elige la cuenta que se quedó sin consultas hoy. Te avisamos por la campanita apenas esté lista.",
    },
    account: {
      icon: "alert", tone: "tone-coral", title: "Problema con una cuenta", submit: "Enviar reporte",
      sub: "Elige la cuenta de tu cliente y cuéntanos qué pasa. Te avisamos por la campanita.",
    },
  };

  // "2026-11-11 15:04:05" (UTC de SQLite) → ISO, para mostrarlo en hora de Lima.
  function sqliteToIso(value) {
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(value || "")) ? value.replace(" ", "T") + "Z" : value;
  }

  function ticketCardHtml(t) {
    const isCodes = t.kind === "codes";
    const st = t.status === "attended" ? "st-attended" : t.status === "seen" ? "st-seen" : "st-pending";
    const canForward = !!t.detail && !isCodes;
    return `
      <article class="ticket-card">
        <div class="ticket-head">
          ${platformChip(t.platform, "sm")}
          <div class="ticket-id">
            <div class="ticket-title">${isCodes ? "Límite de códigos" : escapeHtml(platformName(t.platform))}</div>
            <div class="ticket-sub">${isCodes ? escapeHtml(platformName(t.platform)) + " · " : ""}${escapeHtml(t.clientPhone)} · ${escapeHtml(fmtDateTime(sqliteToIso(t.createdAt)))}</div>
          </div>
          <span class="status-chip ${st}">${escapeHtml(t.statusLabel)}</span>
        </div>
        ${isCodes ? "" : `<div class="ticket-problem">${escapeHtml(t.problem)}</div>`}
        ${t.detail ? `<div class="ticket-detail">${escapeHtml(t.detail)}</div>` : ""}
        ${canForward ? `<button class="btn-wa btn-sm" data-act="ticket-send" data-id="${t.id}" type="button">${icon("send")}Enviar a mi cliente</button>` : ""}
      </article>`;
  }

  function renderTickets() {
    const listEl  = document.getElementById("support-tickets");
    const emptyEl = document.getElementById("support-tickets-empty");
    emptyEl.hidden = cachedTickets.length > 0;
    listEl.innerHTML = cachedTickets.map(ticketCardHtml).join("");
  }

  async function loadSoporte() {
    const listEl = document.getElementById("support-tickets");
    if (!cachedTickets.length) listEl.innerHTML = `<p class="muted small">Cargando…</p>`;
    try {
      const [{ tickets, reasons }] = await Promise.all([api("/support/tickets"), cachedCatalog.length ? null : fetchCatalog()]);
      supportReasons = reasons || supportReasons;
      cachedTickets = tickets || [];
      renderTickets();
    } catch (err) {
      listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function selectedSupportReason() {
    const checked = document.querySelector('input[name="support-reason"]:checked');
    return checked ? checked.value : "";
  }

  function renderSupportReasons() {
    document.getElementById("support-reasons").innerHTML = supportReasons.map((r, i) => `
      <label class="reason-chip"><input type="radio" name="support-reason" value="${escapeHtml(r)}"${i === 0 ? " checked" : ""}><span>${escapeHtml(r)}</span></label>
    `).join("");
    updateSupportDetailHint();
  }

  // «Otro» necesita que cuenten qué pasa; los demás motivos, opcional.
  function updateSupportDetailHint() {
    const other = supportKind === "account" && selectedSupportReason() === "Otro";
    document.querySelector('label[for="support-detail"]').innerHTML = other ? "Cuéntanos qué pasa" : 'Detalle <span class="muted">(opcional)</span>';
    document.getElementById("support-detail").required = other;
  }

  function fillSupportAccounts(preselectId) {
    const select = document.getElementById("support-account");
    const note   = document.getElementById("support-account-note");
    const submit = document.getElementById("support-submit");
    const options = cachedClients
      .filter(c => !c.isOverride && (supportKind !== "codes" || (c.codes && c.codes.enabled)))
      .map(c => ({
        c,
        // Códigos: solo se puede pedir si ya usó todas las consultas de hoy.
        disabled: supportKind === "codes" && c.codes.remaining > 0,
        label: `${platformName(c.platform)} · ${c.clientPhone}${c.profileName ? " · " + c.profileName : ""}`,
      }));
    if (supportKind === "codes") options.sort((a, b) => Number(a.disabled) - Number(b.disabled));
    const usable = options.filter(o => !o.disabled);

    note.hidden = true;
    if (!options.length) {
      select.innerHTML = `<option value="">${supportKind === "codes" ? "Ninguna de tus cuentas tiene códigos en el panel" : "Todavía no tienes clientes"}</option>`;
      select.disabled = true;
      submit.disabled = true;
      return;
    }
    select.innerHTML = `<option value="">Elige una cuenta…</option>` + options.map(o =>
      `<option value="${o.c.id}"${o.disabled ? " disabled" : ""}>${escapeHtml(o.label)}${o.disabled ? ` (te quedan ${o.c.codes.remaining} hoy)` : ""}</option>`
    ).join("");
    select.disabled = false;
    if (preselectId && usable.some(o => o.c.id === preselectId)) select.value = String(preselectId);
    else if (usable.length === 1) select.value = String(usable[0].c.id);
    if (!usable.length) {
      note.textContent = "Todas tus cuentas todavía tienen consultas disponibles hoy.";
      note.hidden = false;
    }
    submit.disabled = !usable.length;
  }

  async function openSupportForm(kind, preselectId) {
    supportKind = kind === "codes" ? "codes" : "account";
    const copy = SUPPORT_COPY[supportKind];
    const iconEl = document.getElementById("support-modal-icon");
    iconEl.className = "modal-icon " + copy.tone;
    iconEl.innerHTML = icon(copy.icon);
    document.getElementById("support-modal-title").textContent = copy.title;
    document.getElementById("support-modal-sub").textContent = copy.sub;
    document.getElementById("support-submit").textContent = copy.submit;
    document.getElementById("support-reason-wrap").hidden = supportKind === "codes";
    document.getElementById("support-detail-wrap").hidden = supportKind === "codes";
    document.getElementById("support-detail").value = "";
    document.getElementById("support-detail").required = false;
    document.getElementById("support-account-note").hidden = true;
    setFormError("support-error", "");
    const select = document.getElementById("support-account");
    select.innerHTML = `<option value="">Cargando tus cuentas…</option>`;
    select.disabled = true;
    document.getElementById("support-submit").disabled = true;
    document.getElementById("support-modal").hidden = false;

    try {
      // Siempre fresco: las consultas de códigos que quedan cambian durante el día.
      await fetchClients();
      if (!supportReasons.length) {
        const r = await api("/support/tickets");
        supportReasons = r.reasons || [];
        cachedTickets = r.tickets || [];
      }
    } catch (err) {
      select.innerHTML = "";
      setFormError("support-error", err.message);
      return;
    }
    renderSupportReasons();
    fillSupportAccounts(preselectId ? Number(preselectId) : null);
  }

  function closeSupportForm() {
    document.getElementById("support-modal").hidden = true;
  }

  function initSoportePage() {
    document.getElementById("support-wa-link").href = "https://wa.me/" + SUPPORT_PHONE
      + "?text=" + encodeURIComponent("Hola! Soy mayorista y necesito ayuda.");

    document.querySelectorAll("[data-support]").forEach(btn => {
      btn.addEventListener("click", () => openSupportForm(btn.dataset.support));
    });
    document.getElementById("support-refresh").addEventListener("click", loadSoporte);
    document.getElementById("support-close").addEventListener("click", closeSupportForm);
    document.getElementById("support-cancel").addEventListener("click", closeSupportForm);
    document.getElementById("support-reasons").addEventListener("change", updateSupportDetailHint);

    document.getElementById("support-tickets").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act='ticket-send']");
      if (!btn) return;
      const t = cachedTickets.find(x => x.id === Number(btn.dataset.id));
      if (t && t.detail) window.open(waLink(t.clientPhone, t.detail), "_blank");
    });

    document.getElementById("support-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      setFormError("support-error", "");
      const profileId = Number(document.getElementById("support-account").value);
      if (!profileId) { setFormError("support-error", "Elige una cuenta."); return; }
      const reason = supportKind === "account" ? selectedSupportReason() : "";
      const detail = supportKind === "account" ? document.getElementById("support-detail").value.trim() : "";
      if (supportKind === "account" && reason === "Otro" && !detail) {
        setFormError("support-error", "Cuéntanos qué pasa con la cuenta.");
        return;
      }
      const btn = document.getElementById("support-submit");
      btn.disabled = true;
      try {
        await api("/support/tickets", { method: "POST", body: { profileId, kind: supportKind, reason, detail } });
        closeSupportForm();
        toast(supportKind === "codes" ? "Pedido enviado — te avisamos al restablecerlo" : "Reporte enviado — te avisamos por la campanita");
        loadSoporte();
      } catch (err) {
        setFormError("support-error", err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // TEMA — claro/oscuro, manual (🌙 en el header). El <script> en el
  // <head> de index.html ya aplicó el tema guardado antes de pintar,
  // acá solo se sincroniza el ícono del botón y se guarda el cambio.
  // ─────────────────────────────────────────────────────────────

  const THEME_KEY = "mw-theme";

  function applyThemeIcon() {
    const isDark = document.documentElement.dataset.theme === "dark";
    const btn = document.getElementById("theme-toggle-btn");
    btn.innerHTML = icon(isDark ? "sun" : "moon");
    btn.title = isDark ? "Modo claro" : "Modo oscuro";
    btn.setAttribute("aria-label", btn.title);
    document.getElementById("mas-theme-btn").setAttribute("aria-pressed", isDark ? "true" : "false");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = isDark ? "#3A2A0E" : "#FFC93C";
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "" : "dark";
    if (next) document.documentElement.dataset.theme = next;
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem(THEME_KEY, next || "light"); } catch { /* sin storage disponible */ }
    applyThemeIcon();
  }

  function initThemeToggle() {
    applyThemeIcon();
    document.getElementById("theme-toggle-btn").addEventListener("click", toggleTheme);
    document.getElementById("mas-theme-btn").addEventListener("click", toggleTheme);
  }

  // ─────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────

  async function init() {
    wireGlobalImgFallback();
    renderNav();
    initThemeToggle();
    initLoginForm();
    initInicioPage();
    initClientsPage();
    initCodesModal();
    initCuentasPage();
    initCreditosPage();
    initComprarPage();
    initRemindersPage();
    initSoportePage();
    initNotifications();

    try {
      const me = await api("/auth/me");
      if (me.authenticated) { await onAuthenticated(); return; }
    } catch { /* sin sesión — muestra el login */ }
    showAuth();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
