/* ═════════════════════════════════════════════════════════════════
   MANGO PRO — armazón del panel y ayudantes para las vistas
   ─────────────────────────────────────────────────────────────────
   • Banda mango: título y línea de arriba de cada vista (fecha + estado
     del bot en el celular), acción principal de la vista.
   • Celular: barra de pestañas, pantalla «Más» (secciones, sonido,
     ocultar montos, conexiones, cerrar sesión), selector de Pagos.
   • Refleja insignias y conexiones (los ids de siempre siguen en la
     barra lateral; acá solo se copian a donde se ven en el celular).
   API pública: window.MP (ver más abajo: MP.menu, MP.hints, MP.toast…).
   ═════════════════════════════════════════════════════════════════ */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const app = $("app");
  if (!app) return;

  const mqMobile = window.matchMedia("(max-width: 899px)");
  const mqReduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const MP = (window.MP = window.MP || {});
  MP.isMobile = () => mqMobile.matches;
  MP.reducedMotion = () => mqReduce.matches;

  // ─── Vistas ───
  const VIEW_SECTION = {
    resumen: "view-live", access: "view-access", codes: "view-codes",
    wholesalers: "view-wholesalers", "web-customers": "view-web-customers",
    course: "view-course", history: "view-history", renewals: "view-renewals",
    config: "view-config", soportes: "view-soportes",
  };
  const MORE_VIEWS = ["soportes", "wholesalers", "web-customers", "course", "config"];

  const DAYS_LONG = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
  const DAYS_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

  function longDate(d = new Date()) { return `${DAYS_LONG[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`; }
  function shortDate(d = new Date()) { return `${DAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`; }
  function greeting(d = new Date()) {
    const h = d.getHours();
    return h >= 5 && h < 12 ? "¡Buenos días" : h >= 12 && h < 19 ? "¡Buenas tardes" : "¡Buenas noches";
  }

  // Título y línea de arriba (PC) de cada vista. Las vistas pueden
  // cambiar la línea de arriba con MP.band.setEyebrow(vista, texto).
  const BAND = {
    resumen:         { title: () => (mqMobile.matches ? greeting() + "!" : greeting() + ", Liordark!"), eyebrow: () => longDate() },
    history:         { title: "Historial", eyebrow: "Pagos" },
    renewals:        { title: "Renovaciones", eyebrow: "Pagos" },
    access:          { title: "Accesos", eyebrow: "Cuentas y perfiles" },
    codes:           { title: "Códigos", eyebrow: "Todo lo que llega a los correos de tus cuentas" },
    wholesalers:     { title: "Mayoristas", eyebrow: "Distribuidores con saldo" },
    "web-customers": { title: "Clientes", eyebrow: "Tienda liordark.com" },
    course:          { title: "Curso", eyebrow: "Tus Primeros S/ 1,000" },
    config:          { title: "Configuración", eyebrow: "Ajustes del panel" },
    soportes:        { title: "Soportes", eyebrow: "Reportes de clientes y mayoristas" },
  };
  const customEyebrow = {};

  let current = currentViewFromDom();
  let moreOpen = false;

  function currentViewFromDom() {
    for (const [view, id] of Object.entries(VIEW_SECTION)) {
      const el = $(id);
      if (el && !el.hidden) return view;
    }
    return "resumen";
  }
  MP.currentView = () => current;

  // ─── Estado del bot (para la banda del celular) ───
  function botStatusText() {
    const dot = $("connector-dot-bot");
    const state = ($("connector-state-bot")?.textContent || "").trim();
    if (dot && dot.classList.contains("connector-dot--ok")) return "Bot conectado";
    if (!state) return "Conectando…";
    return "Bot " + state.charAt(0).toLowerCase() + state.slice(1);
  }

  // ─── Banda ───
  const titleEl = $("mp-title");
  const eyebrowEl = $("mp-eyebrow");
  function setBandText(eyebrow, title) {
    const changed = titleEl.textContent !== title;
    if (eyebrowEl.textContent !== eyebrow) eyebrowEl.textContent = eyebrow;
    if (changed) {
      titleEl.textContent = title;
      animateIn(titleEl, "mp-anim-title");
    }
  }
  function renderBand() {
    if (moreOpen) { setBandText("Gestión y ajustes", "Más"); return; }
    const cfg = BAND[current] || BAND.resumen;
    const title = typeof cfg.title === "function" ? cfg.title() : cfg.title;
    let eyebrow;
    if (mqMobile.matches) eyebrow = `${shortDate()} · ${botStatusText()}`;
    else eyebrow = customEyebrow[current] || (typeof cfg.eyebrow === "function" ? cfg.eyebrow() : cfg.eyebrow);
    setBandText(eyebrow, title);
  }
  MP.band = {
    setEyebrow(view, text) { customEyebrow[view] = text || ""; if (view === current) renderBand(); },
    refresh: renderBand,
  };

  // ─── Acción principal de cada vista, en la banda ───
  // Un botón con data-mp-primary dentro de una vista se muda a la banda
  // (en el celular queda flotando arriba de las pestañas). Si estaba
  // dentro de una sub-sección (ej. Configuración › Catálogo) solo se ve
  // mientras esa sub-sección esté abierta.
  const primarySlot = $("mp-band-primary");
  const primaries = [];
  function adoptPrimaries(root = document) {
    root.querySelectorAll(".view [data-mp-primary]").forEach((btn) => {
      if (btn.closest("#mp-band-primary")) return;
      const view = Object.keys(VIEW_SECTION).find((v) => btn.closest("#" + VIEW_SECTION[v]));
      if (!view) return;
      const origin = btn.parentElement.closest("[id]");
      const label = btn.getAttribute("data-mp-primary");
      if (label) btn.textContent = label;
      btn.classList.add("mp-primary-btn");
      primaries.push({ btn, view, origin: origin && origin.id !== VIEW_SECTION[view] ? origin : null });
      primarySlot.appendChild(btn);
    });
    syncPrimaries();
  }
  function syncPrimaries() {
    let any = false;
    for (const p of primaries) {
      const on = !moreOpen && p.view === current && (!p.origin || !isHiddenDeep(p.origin));
      p.btn.classList.toggle("mp-off", !on);
      if (on) any = true;
    }
    primarySlot.classList.toggle("mp-has-primary", any);
  }
  function isHiddenDeep(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) if (n.hidden) return true;
    return false;
  }

  // ─── Pantalla «Más» (celular) ───
  const moreEl = $("mp-more");
  const moreTab = $("mp-more-tab");
  function openMore() {
    if (moreOpen) return;
    moreOpen = true;
    moreEl.hidden = false;
    app.classList.add("mp-more-open");
    moreTab.setAttribute("aria-expanded", "true");
    renderBand();
    syncPrimaries();
    window.scrollTo(0, 0);
    animateIn(moreEl, "mp-anim-view");
  }
  function closeMore() {
    if (!moreOpen) return;
    moreOpen = false;
    moreEl.hidden = true;
    app.classList.remove("mp-more-open");
    moreTab.setAttribute("aria-expanded", "false");
    renderBand();
    syncPrimaries();
  }
  MP.more = { open: openMore, close: closeMore, isOpen: () => moreOpen };
  moreTab.addEventListener("click", () => {
    if (moreOpen) { closeMore(); animateIn($(VIEW_SECTION[current]), "mp-anim-view"); }
    else openMore();
  });

  // Interruptores de la pantalla «Más» → los botones de siempre
  const soundBtn = $("sound-toggle");
  const moneyBtn = $("money-toggle");
  const soundSwitch = $("mp-sound-switch");
  const moneySwitch = $("mp-money-switch");
  function syncSwitches() {
    soundSwitch.setAttribute("aria-checked", soundBtn.classList.contains("muted") ? "false" : "true");
    moneySwitch.setAttribute("aria-checked", moneyBtn.classList.contains("muted") ? "true" : "false");
  }
  soundSwitch.addEventListener("click", () => soundBtn.click());
  moneySwitch.addEventListener("click", () => moneyBtn.click());
  $("mp-more-logout").addEventListener("click", () => $("logout-btn").click());
  new MutationObserver(syncSwitches).observe(soundBtn, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(syncSwitches).observe(moneyBtn, { attributes: true, attributeFilter: ["class"] });

  // ─── Insignias (soportes + mayoristas) ───
  function badgeCount(id) {
    const el = $(id);
    if (!el || el.hidden) return 0;
    return parseInt(el.textContent, 10) || 0;
  }
  function setCount(el, n) {
    if (!el) return;
    el.textContent = n > 99 ? "99+" : String(n);
    el.hidden = n <= 0;
  }
  function syncBadges() {
    const sop = badgeCount("soportes-badge");
    const wh = badgeCount("wholesalers-pending-badge");
    setCount($("mp-more-count-soportes"), sop);
    setCount($("mp-more-count-wholesalers"), wh);
    const total = sop + wh;
    setCount($("mp-more-badge"), total);
    const badge = $("mp-more-badge");
    if (badge) badge.setAttribute("aria-label", `${total} avisos: ${sop} soportes y ${wh} mayoristas`);
    const subSop = $("mp-more-sub-soportes");
    if (subSop) subSop.textContent = sop ? `${sop} ${sop === 1 ? "reporte" : "reportes"} por atender` : "Reportes de clientes";
    const subWh = $("mp-more-sub-wholesalers");
    if (subWh) subWh.textContent = wh ? `${wh} ${wh === 1 ? "pedido esperando" : "pedidos esperando"}` : "Saldo, pedidos y clientes";
  }
  ["soportes-badge", "wholesalers-pending-badge"].forEach((id) => {
    const el = $(id);
    if (el) new MutationObserver(syncBadges).observe(el, { attributes: true, childList: true, characterData: true, subtree: true });
  });

  // ─── Conexiones (copia de la caja de estado de la barra lateral) ───
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function connRow(label, state, level) {
    return `<div class="mp-conn-row${level === "ok" ? "" : " is-" + level}"><span class="mp-dot" aria-hidden="true"></span><b>${esc(label)}</b><span>${esc(state)}</span></div>`;
  }
  function dotLevel(dot) {
    if (!dot) return "warn";
    if (dot.classList.contains("connector-dot--ok")) return "ok";
    return "warn";
  }
  function syncStatus() {
    const conn = $("conn-indicator");
    const live = conn && conn.classList.contains("conn-connected");
    const rows = [
      connRow("Panel", live ? "En vivo" : "Conectando…", live ? "ok" : "warn"),
      connRow("Bot", ($("connector-state-bot")?.textContent || "").trim() || "—", dotLevel($("connector-dot-bot"))),
      connRow("Cloudinary", ($("connector-state-cloudinary")?.textContent || "").trim() || "—", dotLevel($("connector-dot-cloudinary"))),
    ];
    const out = Array.from(document.querySelectorAll("#stock-alert-list .dock-stock-name")).map((n) => n.textContent.trim());
    out.forEach((name) => rows.push(connRow(name, "Sin stock", "bad")));
    const target = $("mp-more-conn");
    if (target) target.innerHTML = rows.join("");
    const pills = $("mp-dock-pills");
    if (pills) {
      pills.innerHTML = [
        `<span class="mp-pill ${dotLevel($("connector-dot-bot"))}"><span class="mp-dot" aria-hidden="true"></span><b>Bot</b> ${esc(($("connector-state-bot")?.textContent || "").trim())}</span>`,
        `<span class="mp-pill ${dotLevel($("connector-dot-cloudinary"))}"><span class="mp-dot" aria-hidden="true"></span><b>Cloudinary</b> ${esc(($("connector-state-cloudinary")?.textContent || "").trim())}</span>`,
        ...out.map((n) => `<span class="mp-pill bad"><span class="mp-dot" aria-hidden="true"></span><b>${esc(n)}</b></span>`),
      ].join("");
    }
    if (mqMobile.matches && !moreOpen) renderBand();
  }
  const statusBox = $("mp-status");
  if (statusBox) new MutationObserver(syncStatus).observe(statusBox, { attributes: true, childList: true, characterData: true, subtree: true });

  // ─── Cambio de vista (lo avisa app.js con «mp:view») ───
  document.addEventListener("mp:view", (e) => {
    const view = e.detail && e.detail.view;
    if (!view) return;
    const changed = view !== current;
    current = view;
    app.dataset.mpView = view;
    if (moreOpen) closeMore();
    renderBand();
    syncPrimaries();
    if (changed) animateIn($(VIEW_SECTION[view]), "mp-anim-view");
  });

  // Secciones que se muestran/ocultan dentro de una vista (sub-pestañas):
  // la acción principal de la banda depende de cuál está abierta.
  new MutationObserver(() => syncPrimaries()).observe(document.querySelector("main.content"), {
    attributes: true, attributeFilter: ["hidden"], subtree: true,
  });

  // Al pasar de celular a PC (o al revés) la banda cambia de texto.
  const onMedia = () => {
    if (!mqMobile.matches && moreOpen) closeMore();
    renderBand();
  };
  if (mqMobile.addEventListener) mqMobile.addEventListener("change", onMedia);
  else if (mqMobile.addListener) mqMobile.addListener(onMedia);

  // La fecha cambia a medianoche y el saludo con la hora.
  setInterval(renderBand, 60_000);

  // ─── Movimiento: entrada suave (transform/opacity, 150–250 ms) ───
  function animateIn(el, cls) {
    if (!el || mqReduce.matches) return;
    el.classList.remove(cls);
    void el.offsetWidth; // reinicia la animación
    el.classList.add(cls);
    el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
  }
  MP.animateIn = animateIn;

  // ─── Arranque ───
  app.dataset.mpView = current;
  adoptPrimaries();
  syncSwitches();
  syncBadges();
  syncStatus();
  renderBand();
})();
