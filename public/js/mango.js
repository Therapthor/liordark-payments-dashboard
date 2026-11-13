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
    syncBandHints();
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

  // ─── Cambios en el DOM: lo que las vistas pintan después ───
  // Cada «refresher» es idempotente; se corren juntos una vez por cuadro.
  const refreshers = [];
  let refreshQueued = false;
  function scheduleRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      for (const fn of refreshers) {
        try { fn(); } catch (err) { console.error("[mango]", err); }
      }
    });
  }
  MP.onRefresh = (fn) => { refreshers.push(fn); scheduleRefresh(); };
  MP.refresh = scheduleRefresh;
  new MutationObserver(scheduleRefresh).observe(document.body, { childList: true, subtree: true });

  // ─── Tablas: etiqueta de columna para verlas como tarjetas en el celular ───
  function labelTables() {
    document.querySelectorAll("table.history-table, table.access-table").forEach((table) => {
      const heads = Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent.trim());
      if (!heads.length) return;
      table.querySelectorAll("tbody tr").forEach((tr) => {
        let col = 0;
        for (const td of tr.children) {
          const label = heads[col];
          if (label && td.colSpan === 1 && td.getAttribute("data-label") !== label) td.setAttribute("data-label", label);
          col += td.colSpan || 1;
        }
      });
    });
  }
  MP.onRefresh(labelTables);

  // ═══════════════════════════════════════════════════════════════
  // MENÚ «⋯» — MP.menu(botón, [{ label, icon, onClick, danger, disabled }])
  // Desplegable junto al botón en PC; hoja desde abajo en el celular.
  // ═══════════════════════════════════════════════════════════════
  let menuState = null; // { el, anchor, backdrop }

  function iconNode(icon) {
    const span = document.createElement("span");
    span.className = "mp-menu-ico";
    span.setAttribute("aria-hidden", "true");
    if (icon) {
      if (/^\s*<svg[\s>]/i.test(icon)) span.innerHTML = icon; // íconos del propio código
      else span.textContent = icon;
    }
    return span;
  }
  function buildMenuItems(container, items) {
    for (const it of items) {
      if (!it) continue;
      if (it.separator) {
        const sep = document.createElement("div");
        sep.className = "mp-menu-sep";
        sep.setAttribute("role", "separator");
        container.appendChild(sep);
        continue;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mp-menu-item" + (it.danger ? " is-danger" : "");
      b.setAttribute("role", "menuitem");
      b.disabled = !!it.disabled;
      const label = document.createElement("span");
      label.className = "mp-menu-label";
      label.textContent = it.label || "";
      b.append(iconNode(it.icon), label);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMenu(false);
        if (typeof it.onClick === "function") it.onClick(e);
      });
      container.appendChild(b);
    }
  }
  function menuItemsOf(el) { return Array.from(el.querySelectorAll(".mp-menu-item:not(:disabled)")); }

  function openMenu(anchor, items, opts = {}) {
    closeMenu(false);
    const list = (items || []).filter(Boolean);
    if (!list.length) return { close: () => {} };
    const mobile = mqMobile.matches;
    const el = document.createElement("div");
    el.className = mobile ? "mp-sheet mp-menu-sheet" : "mp-menu";
    el.setAttribute("role", "menu");
    if (opts.title) el.setAttribute("aria-label", opts.title);
    let backdrop = null;
    if (mobile) {
      backdrop = document.createElement("div");
      backdrop.className = "mp-sheet-backdrop";
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeMenu(true); });
      const grab = document.createElement("span");
      grab.className = "mp-sheet-grab";
      grab.setAttribute("aria-hidden", "true");
      el.appendChild(grab);
      if (opts.title) {
        const t = document.createElement("p");
        t.className = "mp-sheet-title";
        t.textContent = opts.title;
        el.appendChild(t);
      }
      const box = document.createElement("div");
      box.className = "mp-sheet-list";
      buildMenuItems(box, list);
      el.appendChild(box);
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "mp-sheet-cancel";
      cancel.textContent = "Cancelar";
      cancel.addEventListener("click", () => closeMenu(true));
      el.appendChild(cancel);
      backdrop.appendChild(el);
      document.body.appendChild(backdrop);
      enableSheetDrag(el, grab, () => closeMenu(true));
    } else {
      buildMenuItems(el, list);
      document.body.appendChild(el);
      placeNear(anchor, el, { align: "end", gap: 6 });
    }
    if (anchor) {
      anchor.setAttribute("aria-expanded", "true");
      anchor.setAttribute("aria-haspopup", "menu");
    }
    menuState = { el, anchor, backdrop };
    animateIn(el, mobile ? "mp-anim-sheet" : "mp-anim-pop");
    const first = menuItemsOf(el)[0];
    if (first) first.focus({ preventScroll: true });
    return { close: () => closeMenu(false) };
  }
  function closeMenu(returnFocus) {
    if (!menuState) return;
    const { el, anchor, backdrop } = menuState;
    menuState = null;
    (backdrop || el).remove();
    if (anchor) {
      anchor.setAttribute("aria-expanded", "false");
      if (returnFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
    }
  }
  MP.menu = openMenu;
  MP.closeMenu = () => closeMenu(false);

  // Coloca un elemento flotante junto a otro, sin salirse de la pantalla.
  function placeNear(anchor, el, { align = "start", gap = 8 } = {}) {
    const r = anchor ? anchor.getBoundingClientRect() : { left: 16, right: 16, top: 16, bottom: 16, width: 0 };
    el.style.position = "fixed";
    el.style.visibility = "hidden";
    el.style.left = "0px";
    el.style.top = "0px";
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = align === "end" ? r.right - w : align === "center" ? r.left + r.width / 2 - w / 2 : r.left;
    left = Math.max(12, Math.min(left, vw - w - 12));
    let top = r.bottom + gap;
    let above = false;
    if (top + h > vh - 12 && r.top - gap - h > 12) { top = r.top - gap - h; above = true; }
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(Math.max(12, top)) + "px";
    el.style.setProperty("--mp-arrow-x", Math.round(r.left + r.width / 2 - left) + "px");
    el.classList.toggle("is-above", above);
    el.style.visibility = "";
  }

  // Teclado dentro del menú: flechas, Inicio/Fin, Esc, Tab
  document.addEventListener("keydown", (e) => {
    if (!menuState) return;
    const items = menuItemsOf(menuState.el);
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); (items[i + 1] || items[0])?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); (items[i - 1] || items[items.length - 1])?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === "Tab") closeMenu(false);
  });
  document.addEventListener("click", (e) => {
    if (menuState && !menuState.backdrop && !menuState.el.contains(e.target) && !(menuState.anchor && menuState.anchor.contains(e.target))) closeMenu(false);
  }, true);
  window.addEventListener("resize", () => { closeMenu(false); closePopover(); });
  window.addEventListener("scroll", () => { if (menuState && !menuState.backdrop) closeMenu(false); closePopover(); }, { passive: true, capture: true });

  // ─── Hojas (menú del celular y modales): arrastrar el asa hacia abajo cierra ───
  function enableSheetDrag(sheet, handle, onClose) {
    let startY = 0, dy = 0, startT = 0, dragging = false;
    handle.addEventListener("touchstart", (e) => {
      if (sheet.scrollTop > 0) return;
      dragging = true;
      startY = e.touches[0].clientY;
      startT = Date.now();
      dy = 0;
      sheet.style.transition = "none";
    }, { passive: true });
    handle.addEventListener("touchmove", (e) => {
      if (!dragging) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      const fast = dy > 40 && Date.now() - startT < 250;
      sheet.style.transition = `transform ${mqReduce.matches ? 1 : 200}ms var(--mp-ease)`;
      if (dy > 110 || fast) {
        sheet.style.transform = "translateY(100%)";
        setTimeout(() => { sheet.style.transform = ""; sheet.style.transition = ""; onClose(); }, mqReduce.matches ? 0 : 190);
      } else {
        sheet.style.transform = "";
        setTimeout(() => { sheet.style.transition = ""; }, 220);
      }
    };
    handle.addEventListener("touchend", end);
    handle.addEventListener("touchcancel", end);
  }

  // Modales: en el celular son hojas con asa (la dibuja el CSS). La franja
  // de arriba de la tarjeta sirve para arrastrar; Esc cierra el de arriba.
  function topModal() { return Array.from(document.querySelectorAll(".modal-backdrop:not([hidden])")).pop() || null; }
  function setupModalSheets() {
    document.querySelectorAll(".modal-backdrop > .modal-card").forEach((card) => {
      if (card.querySelector(":scope > .mp-sheet-handle")) return;
      const handle = document.createElement("span");
      handle.className = "mp-sheet-handle";
      handle.setAttribute("aria-hidden", "true");
      card.prepend(handle);
      enableSheetDrag(card, handle, () => { const bd = card.parentElement; if (bd && !bd.hidden) bd.click(); });
    });
  }
  MP.onRefresh(setupModalSheets);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (menuState) { e.preventDefault(); closeMenu(true); return; }
    if (popState) { e.preventDefault(); closePopover(true); return; }
    const bd = topModal();
    if (bd) { e.preventDefault(); bd.click(); } // mismo efecto que tocar el fondo
  });

  // ═══════════════════════════════════════════════════════════════
  // «MENOS TEXTO» — cada párrafo .panel-hint / .cx-hint pasa a un botón «i»
  // junto al título de su sección; el texto sigue en la página para los
  // lectores de pantalla (oculto a la vista) y se abre en un globo.
  // No se tocan los avisos de estado: los que tienen id (o contienen
  // datos con id), los que terminan en «:» (presentan un campo) ni los
  // mensajes que reemplazan una lista (error / vacío).
  // ═══════════════════════════════════════════════════════════════
  const HINT_SEL = "p.panel-hint, p.cx-hint";
  const HEAD_SEL = "h1, h2, h3, h4";
  const HEADERISH = ".panel-header, .modal-head, header, .cx-head, .support-attend-head, .mp-toolbar-head";
  const BOUNDARY = ".view, .modal-card, [role='tabpanel'], .mp-more, dialog";
  const hintBtnOf = new Map(); // ancla → botón
  const hintSources = new Set();
  let hintSeq = 0;

  function isConvertibleHint(p) {
    if (p.hidden || p.hasAttribute("data-mp-keep") || p.closest("[data-mp-keep]")) return false;
    if (p.id || p.querySelector("[id]")) return false;
    const text = p.textContent.trim();
    if (!text || /:\s*$/.test(text)) return false;
    const parent = p.parentElement;
    if (!parent || (parent.id && parent.children.length === 1 && !parent.matches(".panel, .view, section"))) return false;
    return true;
  }
  function headingOf(el) {
    if (el.matches(HEAD_SEL)) return el;
    if (el.matches(HEADERISH)) return el.querySelector(HEAD_SEL);
    return null;
  }
  function viewOf(el) {
    return Object.keys(VIEW_SECTION).find((v) => el.closest("#" + VIEW_SECTION[v])) || null;
  }
  function findHintAnchor(p) {
    let node = p;
    while (node && node !== document.body) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.classList.contains("mp-hint-src")) continue;
        const h = headingOf(sib);
        if (h) {
          // Título repetido (el de la banda ya lo dice) → el «i» va en la banda
          if (h.classList.contains("mp-dup-title")) return { band: viewOf(h) };
          return { el: h };
        }
      }
      const parent = node.parentElement;
      if (!parent || parent.matches(BOUNDARY)) {
        if (parent && parent.matches(".view")) return { band: viewOf(parent) };
        return null;
      }
      node = parent;
    }
    return null;
  }
  function makeInfoBtn(label) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mp-info-btn";
    b.setAttribute("aria-label", label ? `Qué es «${label}»` : "Más información");
    b.setAttribute("aria-expanded", "false");
    b.innerHTML = '<span aria-hidden="true">i</span>';
    b._mpHints = [];
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); togglePopover(b); });
    return b;
  }
  function attachHint(p) {
    const anchor = findHintAnchor(p);
    let key, btn;
    if (anchor && anchor.el) {
      key = anchor.el;
      btn = hintBtnOf.get(key);
      if (!btn || !btn.isConnected || btn.parentElement !== key) {
        btn = makeInfoBtn(key.textContent.trim().replace(/\s+/g, " ").slice(0, 60));
        key.appendChild(btn);
        hintBtnOf.set(key, btn);
      }
    } else if (anchor && anchor.band) {
      key = "band:" + anchor.band;
      btn = hintBtnOf.get(key);
      if (!btn || !btn.isConnected) {
        btn = makeInfoBtn(BAND[anchor.band] ? (typeof BAND[anchor.band].title === "string" ? BAND[anchor.band].title : "") : "");
        btn.classList.add("mp-band-info");
        btn.dataset.mpFor = anchor.band;
        titleEl.parentElement.appendChild(btn);
        hintBtnOf.set(key, btn);
      }
    } else {
      // Sin título cerca: «i Cómo funciona» en el mismo lugar
      btn = p.previousElementSibling && p.previousElementSibling.classList.contains("mp-info-inline") ? p.previousElementSibling : null;
      if (!btn) {
        btn = makeInfoBtn("");
        btn.classList.add("mp-info-inline");
        btn.insertAdjacentHTML("beforeend", "<b>Cómo funciona</b>");
        p.before(btn);
      }
    }
    if (!p.id) p.id = "mp-hint-" + ++hintSeq;
    p.classList.add("mp-hint-src");
    if (!btn._mpHints.includes(p)) btn._mpHints.push(p);
    const ids = btn._mpHints.filter((x) => x.isConnected).map((x) => x.id);
    btn.setAttribute("aria-describedby", ids.join(" "));
    p._mpBtn = btn;
  }
  function refreshHints() {
    document.querySelectorAll(HINT_SEL).forEach((p) => {
      if (hintSources.has(p)) {
        if (!p._mpBtn || !p._mpBtn.isConnected) attachHint(p);
        return;
      }
      if (!isConvertibleHint(p)) return;
      hintSources.add(p);
      attachHint(p);
    });
    for (const p of hintSources) if (!p.isConnected) hintSources.delete(p);
    syncBandHints();
  }
  function syncBandHints() {
    document.querySelectorAll(".mp-band-info").forEach((b) => { b.hidden = moreOpen || b.dataset.mpFor !== current; });
  }
  MP.hints = { refresh: () => { refreshHints(); } };

  // Títulos de vista repetidos con la banda («Mayoristas», «🛟 Soportes»…)
  const norm = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  function markDuplicateTitles() {
    for (const [view, id] of Object.entries(VIEW_SECTION)) {
      const sec = $(id);
      if (!sec) continue;
      const cfg = BAND[view];
      const bandTitle = norm(typeof cfg.title === "string" ? cfg.title : "");
      if (!bandTitle) continue;
      sec.querySelectorAll(":scope > .panel-header.standalone:first-child > h2, :scope .cx-head .cx-title").forEach((h) => {
        const t = norm(h.textContent);
        if (t === bandTitle || t.startsWith(bandTitle + " ")) {
          h.classList.add("mp-dup-title");
          const head = h.parentElement;
          const others = Array.from(head.children).filter((c) => c !== h && !c.hidden && !c.classList.contains("mp-dup-title"));
          head.classList.toggle("mp-empty-head", others.length === 0);
        }
      });
    }
  }

  // Globo del «i»
  let popState = null; // { el, btn }
  function togglePopover(btn) {
    if (popState && popState.btn === btn) { closePopover(false); return; }
    closePopover(false);
    const el = document.createElement("div");
    el.className = "mp-pop";
    el.id = "mp-pop";
    el.setAttribute("role", "tooltip");
    for (const p of btn._mpHints) {
      if (!p.isConnected) continue;
      const para = document.createElement("p");
      for (const n of p.childNodes) para.appendChild(n.cloneNode(true));
      el.appendChild(para);
    }
    if (!el.childNodes.length) return;
    document.body.appendChild(el);
    placeNear(btn, el, { align: "center", gap: 10 });
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-controls", "mp-pop");
    popState = { el, btn };
    animateIn(el, "mp-anim-pop");
  }
  function closePopover(returnFocus) {
    if (!popState) return;
    const { el, btn } = popState;
    popState = null;
    el.remove();
    btn.setAttribute("aria-expanded", "false");
    btn.removeAttribute("aria-controls");
    if (returnFocus && btn.isConnected) btn.focus({ preventScroll: true });
  }
  document.addEventListener("click", (e) => {
    if (popState && !popState.el.contains(e.target) && !popState.btn.contains(e.target)) closePopover(false);
  }, true);

  // ═══════════════════════════════════════════════════════════════
  // ACCIONES EN «⋯»
  // • Barra de herramientas: <button class="mp-dots" data-mp-proxy="id1,id2">
  //   abre un menú con los botones de siempre (ocultos, con su lógica).
  // • Filas y tarjetas: MP.collapse.register(selector, opciones) deja a la
  //   vista 1 principal + 2 secundarias y pasa el resto al «⋯». Lo que
  //   borra o libera (Eliminar, Liberar, Banear…) va siempre al menú, en rojo.
  // ═══════════════════════════════════════════════════════════════
  const DANGER_RE = /(^|[^a-záéíóúñ])(eliminar|borrar|liberar|banear|desactivar|deshabilitar|dar de baja|resetear contraseña)/i;
  function isDanger(el) {
    if (el.matches(".btn-danger, .access-delete-account, .client-release-profile, .row-delete-btn, [data-mp-danger]")) return true;
    const act = el.dataset.act || "";
    if (/^(delete|release|ban|remove|unassign)/i.test(act)) return true;
    return DANGER_RE.test(`${el.textContent} ${el.title || ""} ${el.getAttribute("aria-label") || ""}`);
  }
  function splitLabel(raw) {
    const text = String(raw || "").replace(/\s+/g, " ").trim();
    const m = text.match(/^([^\p{L}\p{N}]+?)\s+(.+)$/u);
    if (m && m[1].length <= 4) return { icon: m[1], label: m[2] };
    return { icon: "", label: text };
  }
  function proxyItem(el) {
    if (!el || !el.isConnected) return null;
    if (el.hidden || el.style.display === "none") return null;
    const raw = el.getAttribute("data-mp-label") || el.textContent.trim() || el.title || el.getAttribute("aria-label") || "";
    let { icon, label } = splitLabel(raw);
    if (!label && el.title) label = el.title;
    if (el.title && label.length <= 2) label = el.title; // botones solo-emoji: el título dice qué hacen
    return { icon, label, danger: isDanger(el), disabled: el.disabled, onClick: () => el.click() };
  }
  MP.proxyItem = proxyItem;

  document.addEventListener("click", (e) => {
    const dots = e.target.closest("[data-mp-proxy]");
    if (!dots) return;
    e.preventDefault();
    e.stopPropagation();
    if (menuState && menuState.anchor === dots) { closeMenu(false); return; }
    const items = dots.dataset.mpProxy.split(",").map((id) => proxyItem($(id.trim())));
    sortDangerLast(items);
    openMenu(dots, items, { title: dots.getAttribute("data-mp-title") || "" });
  });
  // Atajo: un botón con data-mp-click="id" hace lo mismo que ese botón
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-mp-click]");
    if (!t) return;
    const target = $(t.dataset.mpClick);
    if (target) { e.preventDefault(); target.click(); }
  });
  function sortDangerLast(items) {
    items.sort((a, b) => (a && b ? (a.danger === b.danger ? 0 : a.danger ? 1 : -1) : 0));
    const firstDanger = items.findIndex((x) => x && x.danger);
    if (firstDanger > 0) items.splice(firstDanger, 0, { separator: true });
  }

  const DOTS_SVG = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>';
  MP.dotsSvg = DOTS_SVG;
  const collapseRules = [];
  function isActionEl(el) {
    return el.matches("button, a.btn-primary, a.btn-secondary, a.btn-danger, a.row-action, a[role='button']")
      && !el.classList.contains("mp-dots") && !el.classList.contains("mp-info-btn");
  }
  function collapseBox(box, opts) {
    const all = Array.from(box.children).filter(isActionEl);
    const sig = all.map((b) => (b.hidden ? "h" : "v") + b.textContent.trim()).join("|");
    if (box._mpSig === sig && box.querySelector(":scope > .mp-dots")) return;
    box._mpSig = sig;
    box.querySelectorAll(":scope > .mp-dots").forEach((d) => d.remove());
    all.forEach((b) => b.classList.remove("mp-in-menu", "mp-act-primary"));
    const visible = all.filter((b) => !b.hidden && b.style.display !== "none");
    const keepN = opts.keep ?? 2;
    let primaryKept = false, kept = 0;
    const toMenu = [];
    // Las preferidas ocupan primero los lugares visibles; el orden en
    // pantalla sigue siendo el de siempre.
    const prefer = opts.prefer || [];
    const rank = (b) => { const i = prefer.findIndex((sel) => b.matches(sel)); return i === -1 ? prefer.length : i; };
    const ranked = visible.map((b, i) => ({ b, i })).sort((x, y) => rank(x.b) - rank(y.b) || x.i - y.i).map((x) => x.b);
    for (const b of ranked) {
      if (isDanger(b) && opts.danger !== "keep") { toMenu.push(b); continue; }
      const isPrimary = b.matches(".btn-primary, .activation-done-btn, [data-mp-main]");
      if (isPrimary && !primaryKept && opts.primary !== false) { primaryKept = true; b.classList.add("mp-act-primary"); continue; }
      if (kept < keepN) { kept++; continue; }
      toMenu.push(b);
    }
    if (!toMenu.length) return;
    toMenu.forEach((b) => b.classList.add("mp-in-menu"));
    const dots = document.createElement("button");
    dots.type = "button";
    dots.className = "mp-dots" + (opts.small ? " mp-dots-sm" : "");
    dots.setAttribute("aria-label", "Más acciones");
    dots.setAttribute("aria-haspopup", "menu");
    dots.setAttribute("aria-expanded", "false");
    dots.innerHTML = DOTS_SVG;
    dots.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (menuState && menuState.anchor === dots) { closeMenu(false); return; }
      const items = Array.from(box.querySelectorAll(":scope > .mp-in-menu")).map(proxyItem);
      sortDangerLast(items);
      openMenu(dots, items, { title: opts.title ? opts.title(box) : "" });
    });
    box.appendChild(dots);
  }
  function refreshCollapse() {
    for (const rule of collapseRules) document.querySelectorAll(rule.selector).forEach((box) => collapseBox(box, rule.opts));
  }
  MP.collapse = {
    register(selector, opts = {}) { collapseRules.push({ selector, opts }); scheduleRefresh(); },
    refresh: refreshCollapse,
  };

  MP.onRefresh(() => { markDuplicateTitles(); refreshHints(); refreshCollapse(); });
  document.addEventListener("mp:view", () => { closeMenu(false); closePopover(false); syncBandHints(); });

  // ─── Aviso corto (toast) para las vistas ───
  let toastTimer = null;
  MP.toast = (text, ms = 2600) => {
    let el = document.querySelector(".mp-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "mp-toast";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  };

  // ─── Arranque ───
  app.dataset.mpView = current;
  adoptPrimaries();
  syncSwitches();
  syncBadges();
  syncStatus();
  renderBand();
})();
