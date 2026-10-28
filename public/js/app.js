(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────

  function fmtMoney(n) {
    const num = Number(n) || 0;
    return "S/ " + num.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ─────────────────────────────────────────────────────────────
  // OJITO — ocultar/mostrar montos (persiste entre sesiones)
  // ─────────────────────────────────────────────────────────────

  const MONEY_MASK = "***";
  let moneyHidden = localStorage.getItem("ldp_money_hidden") === "1";

  /** Reemplaza el número de un texto tipo "S/ 1,234.56" por ***, dejando el prefijo. */
  function maskMoneyText(rawText) {
    return String(rawText).replace(/[\d.,]+/g, MONEY_MASK);
  }

  /** Escribe un valor de dinero en un elemento existente, guardando el real para poder revelarlo. */
  function setMoneyText(el, rawText) {
    el.dataset.raw = rawText;
    el.textContent = moneyHidden ? maskMoneyText(rawText) : rawText;
  }

  /** HTML de un valor de dinero para usar dentro de innerHTML/templates. */
  function moneyValueHtml(rawText) {
    const shown = moneyHidden ? maskMoneyText(rawText) : rawText;
    return `<span class="money-value" data-raw="${escapeHtml(rawText)}">${escapeHtml(shown)}</span>`;
  }

  function refreshMoneyVisibility() {
    document.querySelectorAll("[data-raw]").forEach(el => {
      el.textContent = moneyHidden ? maskMoneyText(el.dataset.raw) : el.dataset.raw;
    });
    if (chart) chart.update(); // los ticks del eje Y también deben ocultarse/mostrarse
  }

  function initMoneyToggle() {
    const btn = document.getElementById("money-toggle");
    updateMoneyToggleBtn(btn);
    btn.addEventListener("click", () => {
      moneyHidden = !moneyHidden;
      localStorage.setItem("ldp_money_hidden", moneyHidden ? "1" : "0");
      refreshMoneyVisibility();
      updateMoneyToggleBtn(btn);
    });
  }
  function updateMoneyToggleBtn(btn) {
    btn.textContent = moneyHidden ? "🙈" : "👁";
    btn.title = moneyHidden ? "Mostrar montos" : "Ocultar montos";
    btn.classList.toggle("muted", moneyHidden);
  }

  function fmtDateLong(ymd) {
    const [y, m, d] = ymd.split("-");
    return `${d}/${m}/${y}`;
  }

  function fmtMonthName(yyyyMM) {
    const [y, m] = yyyyMM.split("-");
    const meses = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
    return meses[Number(m) - 1] + " " + y;
  }

  function pluralPagos(count) {
    return count + (count === 1 ? " pago" : " pagos");
  }

  // SQLite guarda "YYYY-MM-DD HH:MM:SS" en UTC pero sin decirlo — si se
  // parsea tal cual, el navegador lo toma como hora LOCAL suya, no UTC, y
  // todo sale corrido (en Perú, 5 horas adelantado). Se fuerza el sufijo
  // "Z" solo cuando el string no trae ya su propia zona horaria.
  function toUtcISOString(s) {
    if (typeof s !== "string") return s;
    if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) return s;
    return s.replace(" ", "T") + "Z";
  }

  function fmtTime(iso) {
    try {
      return new Date(toUtcISOString(iso)).toLocaleTimeString("es-PE", {
        timeZone: "America/Lima", hour: "2-digit", minute: "2-digit",
      });
    } catch { return ""; }
  }

  function todayLima() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
  }

  async function api(path, options = {}) {
    const res = await fetch("/api" + path, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (res.status === 401) {
      showLogin();
      throw new Error("No autenticado");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "Error de red");
    return data;
  }

  // ─────────────────────────────────────────────────────────────
  // SONIDO — beep generado en el navegador, sin archivo de audio
  // ─────────────────────────────────────────────────────────────

  let audioCtx = null;
  function playChime() {
    if (localStorage.getItem("ldp_muted") === "1") return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const now = audioCtx.currentTime;
      [880, 1320].forEach((freq, i) => {
        const osc  = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + i * 0.09);
        gain.gain.exponentialRampToValueAtTime(0.18, now + i * 0.09 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.35);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(now + i * 0.09);
        osc.stop(now + i * 0.09 + 0.4);
      });
    } catch { /* navegador sin soporte de audio — no crítico */ }
  }

  // Aviso de "nuevo cliente registrado en liordark.com" — distinto del
  // beep de pagos (onda triangular, 3 notas en vez de 2, más largo).
  function playCustomerChime() {
    if (localStorage.getItem("ldp_muted") === "1") return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const now = audioCtx.currentTime;
      [660, 880, 1100].forEach((freq, i) => {
        const osc  = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "triangle";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + i * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.16, now + i * 0.12 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.4);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(now + i * 0.12);
        osc.stop(now + i * 0.12 + 0.45);
      });
    } catch { /* navegador sin soporte de audio — no crítico */ }
  }

  // Aviso de "pedido cayó a revisión manual" — necesita atención porque
  // el cliente ya pagó pero no se detectó solo. Onda cuadrada, alarmante
  // a propósito (distinto de los otros dos, que son "buenas noticias").
  function playReviewAlertChime() {
    if (localStorage.getItem("ldp_muted") === "1") return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const now = audioCtx.currentTime;
      [0, 0.22].forEach((offset) => {
        const osc  = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "square";
        osc.frequency.value = 740;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.09, now + offset + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.16);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.18);
      });
    } catch { /* navegador sin soporte de audio — no crítico */ }
  }

  function initSoundToggle() {
    const btn = document.getElementById("sound-toggle");
    const muted = localStorage.getItem("ldp_muted") === "1";
    updateSoundBtn(btn, muted);
    btn.addEventListener("click", () => {
      const nowMuted = localStorage.getItem("ldp_muted") === "1";
      localStorage.setItem("ldp_muted", nowMuted ? "0" : "1");
      updateSoundBtn(btn, !nowMuted);
      if (nowMuted) playChime(); // feedback al reactivar
    });
  }
  function updateSoundBtn(btn, muted) {
    btn.textContent = muted ? "🔕" : "🔔";
    btn.classList.toggle("muted", muted);
    btn.title = muted ? "Sonido desactivado — clic para activar" : "Sonido activado — clic para silenciar";
  }

  // ─────────────────────────────────────────────────────────────
  // AUTH
  // ─────────────────────────────────────────────────────────────

  function showLogin() {
    document.getElementById("login-screen").hidden = false;
    document.getElementById("app").hidden = true;
  }
  function showApp() {
    document.getElementById("login-screen").hidden = true;
    document.getElementById("app").hidden = false;
  }

  async function checkAuth() {
    try {
      const { authenticated } = await api("/auth/me");
      if (authenticated) { showApp(); boot(); }
      else showLogin();
    } catch {
      showLogin();
    }
  }

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = document.getElementById("login-password").value;
    const errorEl = document.getElementById("login-error");
    errorEl.hidden = true;
    try {
      await api("/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      showApp();
      boot();
    } catch {
      errorEl.hidden = false;
    }
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    location.reload();
  });

  // ─────────────────────────────────────────────────────────────
  // TABS
  // ─────────────────────────────────────────────────────────────

  // "Pagos" es un desplegable con tres sub-vistas (En vivo / Historial /
  // Renovaciones); "Accesos" es un botón directo aparte.
  const ADMIN_VIEW_KEY = "ldp_admin_view";
  const VALID_VIEWS = ["resumen", "access", "wholesalers", "web-customers", "history", "renewals", "config", "support-chat"];

  function switchView(view) {
    try { localStorage.setItem(ADMIN_VIEW_KEY, view); } catch { /* localStorage bloqueado — no crítico */ }

    document.getElementById("view-live").hidden          = view !== "resumen";
    document.getElementById("view-access").hidden        = view !== "access";
    document.getElementById("view-wholesalers").hidden   = view !== "wholesalers";
    document.getElementById("view-web-customers").hidden = view !== "web-customers";
    document.getElementById("view-history").hidden       = view !== "history";
    document.getElementById("view-renewals").hidden      = view !== "renewals";
    document.getElementById("view-config").hidden        = view !== "config";
    document.getElementById("view-support-chat").hidden  = view !== "support-chat";

    const isPagos = view === "history" || view === "renewals";
    document.getElementById("pagos-toggle").classList.toggle("active", isPagos);
    document.querySelectorAll(".tab-dropdown-item").forEach(item => {
      item.classList.toggle("active", item.dataset.view === view);
    });
    document.querySelectorAll('.tab-btn[data-view]:not(.tab-dropdown-toggle)').forEach(btn => {
      btn.classList.toggle("active", btn.dataset.view === view);
    });

    if (view === "history") { loadHistory(); loadChart(); }
    if (view === "renewals") {
      loadReminderRuns();
      loadRenewalNotifications();
      loadSmsDays();
      if (window.LiordarkAccess) {
        window.LiordarkAccess.loadProviderRenewals();
        window.LiordarkAccess.loadPasswordChangePending();
      }
    }
    if (view === "access" && window.LiordarkAccess) window.LiordarkAccess.load();
    if (view === "wholesalers" && window.LiordarkWholesalers) window.LiordarkWholesalers.load();
    if (view === "web-customers" && window.LiordarkWebCustomers) window.LiordarkWebCustomers.load();
    if (view === "support-chat" && window.LiordarkSupportChat) window.LiordarkSupportChat.load();
    if (view === "config") {
      let savedSection = "catalog";
      try {
        const stored = localStorage.getItem(ADMIN_CONFIG_SECTION_KEY);
        if (stored && VALID_CONFIG_SECTIONS.includes(stored)) savedSection = stored;
      } catch { /* localStorage bloqueado */ }
      switchConfigSection(savedSection);
    }
  }

  // "Configuración" tiene su propio sub-menú (Catálogo / Métodos de pago /
  // Proveedores) — se maneja aparte del menú principal de arriba.
  const ADMIN_CONFIG_SECTION_KEY = "ldp_admin_config_section";
  const VALID_CONFIG_SECTIONS = ["catalog", "payment-methods", "providers"];

  function switchConfigSection(section) {
    try { localStorage.setItem(ADMIN_CONFIG_SECTION_KEY, section); } catch { /* localStorage bloqueado */ }

    document.getElementById("config-section-catalog").hidden         = section !== "catalog";
    document.getElementById("config-section-payment-methods").hidden = section !== "payment-methods";
    document.getElementById("config-section-providers").hidden       = section !== "providers";
    document.querySelectorAll(".config-subnav-item").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.configSection === section);
    });

    if (section === "catalog" && window.LiordarkCatalog) window.LiordarkCatalog.load();
    if (section === "payment-methods" && window.LiordarkSettings) window.LiordarkSettings.loadMethods();
    if (section === "providers" && window.LiordarkSettings) window.LiordarkSettings.loadProviders();
  }

  function initConfigSubnav() {
    document.querySelectorAll(".config-subnav-item").forEach(btn => {
      btn.addEventListener("click", () => switchConfigSection(btn.dataset.configSection));
    });
  }

  function initTabs() {
    const dropdown = document.getElementById("pagos-dropdown");
    const menu     = document.getElementById("pagos-menu");

    document.getElementById("pagos-toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });

    document.querySelectorAll(".tab-dropdown-item").forEach(btn => {
      btn.addEventListener("click", () => {
        menu.hidden = true;
        switchView(btn.dataset.view);
      });
    });

    document.querySelectorAll('.tab-btn[data-view]:not(.tab-dropdown-toggle)').forEach(btn => {
      btn.addEventListener("click", () => {
        menu.hidden = true;
        switchView(btn.dataset.view);
      });
    });

    document.addEventListener("click", (e) => {
      if (!dropdown.contains(e.target)) menu.hidden = true;
    });
  }

  // ─────────────────────────────────────────────────────────────
  // STATS + FEED (vista en vivo)
  // ─────────────────────────────────────────────────────────────

  function renderStats(stats) {
    setMoneyText(document.getElementById("stat-today-total"), fmtMoney(stats.today.total));
    document.getElementById("stat-today-count").textContent   = pluralPagos(stats.today.count);

    // Resumido arriba del gráfico/tabla de Historial.
    const monthTotal = document.getElementById("history-month-total");
    const monthCount = document.getElementById("history-month-count");
    if (monthTotal) setMoneyText(monthTotal, fmtMoney(stats.month.total));
    if (monthCount) monthCount.textContent = pluralPagos(stats.month.count);

    if (stats.lastMonth) {
      const histTotal = document.getElementById("history-lastmonth-total");
      const histCount = document.getElementById("history-lastmonth-count");
      if (histTotal) setMoneyText(histTotal, fmtMoney(stats.lastMonth.total));
      if (histCount) histCount.textContent = pluralPagos(stats.lastMonth.count);
      const label = document.getElementById("history-lastmonth-label");
      if (label) label.textContent = "Mes pasado (" + fmtMonthName(stats.lastMonth.month) + ")";
    }
  }

  // confirmado = verde, pendiente/sin código = amarillo, expirado = rojo
  function statusLabel(status) {
    if (status === "matched")  return "Confirmado";
    if (status === "expired")  return "Expirado";
    if (status === "no_code")  return "Sin código";
    return "Pendiente";
  }
  function statusClass(status) {
    if (status === "matched") return "matched";
    if (status === "expired") return "expired";
    return "pending"; // agrupa "pending" y "no_code" en amarillo
  }

  function fmtCode(p) {
    return p.hasCode && p.securityCode ? "Cód: " + escapeHtml(p.securityCode) : "Sin código";
  }

  // El teléfono no viaja aparte — va como prefijo del orderName
  // ("51987654321-uuid-fecha"), y solo existe si el pago ya se emparejó
  // con un pedido (si no, orderName llega vacío).
  function phoneFromOrderName(orderName) {
    if (!orderName) return "";
    const phone = orderName.split("-")[0];
    return /^\d{6,}$/.test(phone) ? phone : "";
  }

  function renderFeedItem(p, isNew) {
    const li = document.createElement("li");
    li.className = "feed-item" + (isNew ? " is-new" : "");
    li.dataset.id = p.id;
    const phone = phoneFromOrderName(p.orderName);
    li.innerHTML = `
      <span class="feed-badge ${statusClass(p.status)}"></span>
      <div class="feed-main">
        <div class="feed-name">${escapeHtml(p.senderName)}</div>
        ${phone ? `<div class="feed-phone">${escapeHtml(phone)}</div>` : ""}
        <div class="feed-time">${fmtTime(p.createdAt)} · <span class="feed-status ${statusClass(p.status)}">${statusLabel(p.status)}</span> · ${fmtCode(p)}</div>
      </div>
      <div class="feed-amount">${moneyValueHtml(fmtMoney(p.amount))}</div>
    `;
    return li;
  }

  /** Actualiza un pago ya pintado en pantalla (ej. pasó a expirado) sin recargar todo. */
  function updateFeedItemStatus(id, status) {
    const li = document.querySelector(`.feed-item[data-id="${id}"]`);
    if (!li) return;
    const badge = li.querySelector(".feed-badge");
    const label = li.querySelector(".feed-status");
    badge.className = "feed-badge " + statusClass(status);
    if (label) {
      label.className = "feed-status " + statusClass(status);
      label.textContent = statusLabel(status);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function prependFeedItem(payment) {
    cachedLivePayments = [payment, ...cachedLivePayments].slice(0, 50);

    const list  = document.getElementById("feed-list");
    const empty = document.getElementById("feed-empty");
    empty.hidden = true;
    const item = renderFeedItem(payment, true);
    list.prepend(item);
    while (list.children.length > 50) list.removeChild(list.lastChild);
  }

  function renderFeedList(payments) {
    const list  = document.getElementById("feed-list");
    const empty = document.getElementById("feed-empty");
    list.innerHTML = "";
    if (payments.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;
    for (const p of payments) list.appendChild(renderFeedItem(p, false));
  }

  // ─────────────────────────────────────────────────────────────
  // BUSCADOR POR CÓDIGO DE 3 DÍGITOS
  // ─────────────────────────────────────────────────────────────

  let searchActive = false;
  let cachedLivePayments = [];

  function initCodeSearch() {
    const input      = document.getElementById("code-search");
    const clearBtn   = document.getElementById("code-search-clear");
    const statusEl   = document.getElementById("search-status");

    async function runSearch() {
      const digits = input.value.replace(/\D/g, "");
      if (!digits) { clearSearch(); return; }

      searchActive = true;
      clearBtn.hidden = false;

      try {
        const { code, payments } = await api("/live/search?code=" + digits);
        statusEl.hidden = false;
        statusEl.textContent = payments.length
          ? `${payments.length} resultado(s) para el código ${code}`
          : `Sin resultados para el código ${code}`;
        renderFeedList(payments);
      } catch {
        statusEl.hidden = false;
        statusEl.textContent = "Error buscando el código.";
      }
    }

    function clearSearch() {
      searchActive = false;
      clearBtn.hidden = true;
      statusEl.hidden = true;
      input.value = "";
      renderFeedList(cachedLivePayments);
    }

    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(0, 3);
      if (input.value.length === 3) runSearch();
      else if (input.value.length === 0) clearSearch();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); runSearch(); }
    });
    clearBtn.addEventListener("click", clearSearch);
  }

  // ─────────────────────────────────────────────────────────────
  // CONEXIÓN EN VIVO
  // ─────────────────────────────────────────────────────────────

  function setConnIndicator(status) {
    const el = document.getElementById("conn-indicator");
    el.classList.remove("conn-connected", "conn-connecting");
    if (status === "connected") {
      el.classList.add("conn-connected");
      el.innerHTML = `<span class="conn-dot"></span> En vivo`;
    } else {
      el.classList.add("conn-connecting");
      el.innerHTML = `<span class="conn-dot"></span> Conectando…`;
    }
    setConnectorRow("bot", status === "connected", status === "connected" ? "En línea" : "Reconectando…");
  }

  // ─────────────────────────────────────────────────────────────
  // RESUMEN — estado de conectores (bot + Cloudinary)
  // ─────────────────────────────────────────────────────────────

  const CONNECTORS_POLL_MS = 30_000;
  const CLOUDINARY_STATE_LABEL = {
    ok:             "Conectado",
    error:          "Con errores",
    not_configured: "No configurado",
  };

  function setConnectorRow(key, ok, text) {
    const dot   = document.getElementById(`connector-dot-${key}`);
    const state = document.getElementById(`connector-state-${key}`);
    if (!dot || !state) return;
    dot.classList.toggle("connector-dot--ok", ok);
    dot.classList.toggle("connector-dot--warn", !ok);
    state.textContent = text;
  }

  async function loadConnectorsStatus() {
    try {
      const { bot, cloudinary } = await api("/live/connectors");
      setConnectorRow("bot", bot === "connected", bot === "connected" ? "En línea" : "Reconectando…");
      setConnectorRow("cloudinary", cloudinary === "ok", CLOUDINARY_STATE_LABEL[cloudinary] || "Sin datos");
    } catch {
      setConnectorRow("cloudinary", false, "Sin datos");
    }
  }

  // ─────────────────────────────────────────────────────────────
  // RESUMEN — aviso de stock (solo lo que está en 0, para no llenar
  // la pantalla con todas las plataformas que sí tienen)
  // ─────────────────────────────────────────────────────────────

  // CANVA, GEMINI AI PRO y YOUTUBE PREMIUM no tienen perfiles pre-cargados
  // a propósito (se activan a mano por pedido) — su sellableCount es
  // siempre 0, pero eso no significa que falte stock real, así que nunca
  // deben salir en este aviso.
  function isManualActivationPlatform(platform) {
    return /canva|gemini|youtube/i.test(platform || "");
  }

  async function loadProviderRenewalsCount() {
    try {
      const { accounts } = await api("/access/provider-renewals");
      document.getElementById("stat-provider-renewals-count").textContent = String(accounts.length);
    } catch { /* no crítico — se reintenta en el próximo poll */ }
  }

  async function loadStockAlert() {
    const list = document.getElementById("stock-alert-list");
    const ok   = document.getElementById("stock-alert-ok");
    try {
      const { platforms } = await api("/access/platforms");
      const withoutStock = platforms.filter(p => p.sellableCount === 0 && !isManualActivationPlatform(p.platform));

      if (withoutStock.length === 0) {
        list.innerHTML = "";
        ok.hidden = false;
        return;
      }

      ok.hidden = true;
      list.innerHTML = withoutStock.map(p => `
        <li class="dock-stock-item">
          <span class="connector-dot connector-dot--warn"></span>
          <span class="dock-stock-name">${escapeHtml(p.platform)}</span>
        </li>
      `).join("");
    } catch {
      list.innerHTML = "";
      ok.hidden = true;
    }
  }

  let evtSource = null;
  function connectLive() {
    if (evtSource) evtSource.close();
    evtSource = new EventSource("/api/live/stream");

    evtSource.onopen = () => setConnIndicator("connected");
    evtSource.onerror = () => setConnIndicator("connecting");

    evtSource.onmessage = (msg) => {
      let evt;
      try { evt = JSON.parse(msg.data); } catch { return; }

      if (evt.type === "connection") setConnIndicator(evt.status);

      if (evt.type === "payment" && !searchActive) {
        prependFeedItem(evt.payment);
        // Sin sonido si todavía no se confirmó (ahí es cuando el pedido
        // cae a "Pedidos pendientes"/"Renovaciones pendientes" — mucha
        // gente solo le da a comprar para ver el proceso y no paga).
        if (evt.payment.status === "matched") playChime();
      }

      if (evt.type === "status_update") {
        updateFeedItemStatus(evt.id, evt.status);
      }

      if (evt.type === "stats") {
        renderStats(evt.stats);
        refreshChartIfStale();
      }

      if (evt.type === "order_approved") {
        prependApprovedOrder(evt);
        loadPendingOrders(); // lo más probable es que un pendiente se acaba de resolver
      }

      if (evt.type === "customer_registered") {
        playCustomerChime();
        if (window.LiordarkWebCustomers) window.LiordarkWebCustomers.load();
      }

      if (evt.type === "order_needs_review") {
        playReviewAlertChime();
        loadPendingOrders();
      }
    };
  }

  // ─────────────────────────────────────────────────────────────
  // PEDIDOS — pendientes (en vivo desde el bot) y aprobados (historial propio)
  // ─────────────────────────────────────────────────────────────

  const ORDERS_POLL_MS = 20_000;

  const ORDER_STATUS_LABEL = {
    PENDING_APPROVAL:     "Pendiente de aprobar",
    COMPROBANTE_RECIBIDO: "Comprobante recibido",
    APPROVING:            "Aprobando…",
    REVALIDATING:         "Revalidando",
    NO_STOCK:             "Sin stock",
    REJECTED:             "Rechazada",
  };
  const ORDER_STATUS_CLASS = {
    NO_STOCK: "expired",
    REJECTED: "expired",
  };

  // Chip que marca los pedidos con pago ya validado por Yape (monto
  // exacto) — útil para saber, en "sin stock" o renovaciones, a cuáles
  // ya se les puede asignar cuenta apenas haya disponible.
  function yapeConfirmedBadge(o) {
    return o.yapeConfirmed
      ? `<span class="yape-confirmed-badge" title="Pago ya confirmado por Yape">✅ Yape confirmado</span>`
      : "";
  }

  // Recargas mayoristas quedan con platform="WALLET_TOPUP" (sentinel interno)
  // — el admin nunca debería ver ese texto crudo, acá se muestra bonito.
  function orderPlatformLabel(o) {
    return o.isWalletTopup ? "💳 Recarga mayorista" : o.platform;
  }

  function renderPendingOrder(o) {
    const li = document.createElement("li");
    li.className = "feed-item";
    const cls = ORDER_STATUS_CLASS[o.status] || "pending";
    li.innerHTML = `
      <span class="feed-badge ${cls}"></span>
      <div class="feed-main">
        <div class="feed-name">${escapeHtml(orderPlatformLabel(o))} · ${escapeHtml(o.phone)}</div>
        <div class="feed-time">${fmtTime(o.createdAt)} · <span class="feed-status ${cls}">${escapeHtml(ORDER_STATUS_LABEL[o.status] || o.status)}</span></div>
        ${o.clientEmail ? `<div class="feed-time">📧 ${escapeHtml(o.clientEmail)}</div>` : ""}
        ${o.clientPassword ? `<div class="feed-time">🔑 ${escapeHtml(o.clientPassword)}</div>` : ""}
        ${yapeConfirmedBadge(o)}
      </div>
      <div class="feed-amount">${moneyValueHtml("S/ " + o.price)}</div>
      <div class="pending-order-actions">
        <button class="row-action order-action-btn" data-order="${escapeHtml(o.orderName)}" data-act="approve" title="Aprobar">✅</button>
        <button class="row-action order-action-btn" data-order="${escapeHtml(o.orderName)}" data-act="reject" title="Rechazar">❌</button>
        <button class="row-action order-action-btn" data-order="${escapeHtml(o.orderName)}" data-act="clear" title="Limpiar (el cliente nunca pagó)">🧹</button>
      </div>
    `;
    return li;
  }

  // Renovación — mismas 3 opciones que Telegram (más "limpiar").
  function renderRenewalOrder(o) {
    const li = document.createElement("li");
    li.className = "feed-item";
    const cls = ORDER_STATUS_CLASS[o.status] || "pending";
    li.innerHTML = `
      <span class="feed-badge ${cls}"></span>
      <div class="feed-main">
        <div class="feed-name">${escapeHtml(o.platform)} · ${escapeHtml(o.phone)}</div>
        <div class="feed-time">${fmtTime(o.createdAt)} · <span class="feed-status ${cls}">${escapeHtml(ORDER_STATUS_LABEL[o.status] || o.status)}</span></div>
        ${o.clientEmail ? `<div class="feed-time">📧 ${escapeHtml(o.clientEmail)}</div>` : ""}
        ${o.clientPassword ? `<div class="feed-time">🔑 ${escapeHtml(o.clientPassword)}</div>` : ""}
        ${yapeConfirmedBadge(o)}
      </div>
      <div class="feed-amount">${moneyValueHtml("S/ " + o.price)}</div>
      <div class="pending-order-actions">
        <button class="row-action order-action-btn" data-order="${escapeHtml(o.orderName)}" data-act="approve" title="Nueva cuenta">🆕</button>
        <button class="row-action order-action-btn" data-order="${escapeHtml(o.orderName)}" data-act="renew-message-only" title="Solo mensaje (sin cuenta nueva)">✉️</button>
        <button class="row-action order-action-btn" data-order="${escapeHtml(o.orderName)}" data-act="reject" title="Rechazar">❌</button>
        <button class="row-action order-action-btn" data-order="${escapeHtml(o.orderName)}" data-act="clear" title="Limpiar (el cliente nunca pagó)">🧹</button>
      </div>
    `;
    return li;
  }

  // Activación manual pendiente (CANVA, GEMINI AI PRO, YOUTUBE PREMIUM) —
  // la cuenta ya existe en Accesos, pero alguien tiene que ir a la
  // plataforma real a activarla a mano. Se mezcla con los pedidos del bot
  // en la misma lista, con su propia etiqueta verde y un solo botón.
  function renderActivationPendingItem(a) {
    const li = document.createElement("li");
    li.className = "feed-item";
    const phones = (a.clientPhones || []).join(", ");
    li.innerHTML = `
      <span class="feed-badge activation-pending-badge"></span>
      <div class="feed-main">
        <div class="feed-name">${escapeHtml(a.platform)}${phones ? " · " + escapeHtml(phones) : ""}</div>
        <div class="feed-time">${fmtTime(a.createdAt)} · <span class="activation-pending-label">🟢 Pendiente de activación</span></div>
        <div class="feed-time">📧 ${escapeHtml(a.email)}</div>
        ${a.password ? `<div class="feed-time">🔑 ${escapeHtml(a.password)}</div>` : ""}
      </div>
      <div class="pending-order-actions">
        <button class="row-action activation-done-btn" data-account="${a.accountId}" title="Ya la activé en la plataforma">✅ Activada</button>
      </div>
    `;
    return li;
  }

  // Se guarda el último fetch para poder filtrar por celular sin
  // tener que golpear al bot de nuevo en cada tecla.
  let cachedPendingOrders = [];
  let cachedPendingActivations = [];
  let pendingSearchDigits = "";

  function renderPendingList(orders, activations) {
    const list  = document.getElementById("orders-pending-list");
    const empty = document.getElementById("orders-pending-empty");
    const count = document.getElementById("orders-pending-count");
    count.textContent = orders.length + activations.length;
    list.innerHTML = "";
    if (orders.length === 0 && activations.length === 0) {
      empty.hidden = false;
      empty.textContent = pendingSearchDigits ? "Sin resultados para ese número." : "No hay pedidos pendientes 🎉";
      return;
    }
    empty.hidden = true;
    for (const a of activations) list.appendChild(renderActivationPendingItem(a));
    for (const o of orders) list.appendChild(renderPendingOrder(o));
  }

  function renderRenewalList(orders) {
    const list  = document.getElementById("renewals-list");
    const empty = document.getElementById("renewals-empty");
    const count = document.getElementById("renewals-count");
    count.textContent = orders.length;
    list.innerHTML = "";
    if (orders.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;
    for (const o of orders) list.appendChild(renderRenewalOrder(o));
  }

  async function loadPendingOrders() {
    try {
      const [{ orders }, activationResult] = await Promise.all([
        api("/orders/pending"),
        api("/access/activation-pending").catch(() => ({ pending: [] })),
      ]);
      cachedPendingOrders = orders.filter(o => !o.isRenewal);
      cachedPendingActivations = activationResult.pending || [];
      applyPendingSearch();
      renderRenewalList(orders.filter(o => o.isRenewal));
    } catch {
      // el bot puede estar reiniciando — se deja lo último mostrado
    }
  }

  function applyPendingSearch() {
    const orders = pendingSearchDigits
      ? cachedPendingOrders.filter(o => o.phone.replace(/\D/g, "").includes(pendingSearchDigits))
      : cachedPendingOrders;
    const activations = pendingSearchDigits
      ? cachedPendingActivations.filter(a => (a.clientPhones || []).some(p => p.replace(/\D/g, "").includes(pendingSearchDigits)))
      : cachedPendingActivations;
    renderPendingList(orders, activations);
  }

  function initPendingSearch() {
    const input    = document.getElementById("pending-search");
    const clearBtn = document.getElementById("pending-search-clear");

    input.addEventListener("input", () => {
      pendingSearchDigits = input.value.replace(/\D/g, "");
      clearBtn.hidden = !pendingSearchDigits;
      applyPendingSearch();
    });
    clearBtn.addEventListener("click", () => {
      input.value = "";
      pendingSearchDigits = "";
      clearBtn.hidden = true;
      applyPendingSearch();
    });
  }

  // Delegado en el contenedor — las listas se re-dibujan enteras en cada
  // loadPendingOrders(), así que un listener fijo por botón se perdería.
  // Se usa para "Pedidos pendientes" y "Renovaciones pendientes" por igual.
  function wireOrderActions(containerId) {
    document.getElementById(containerId).addEventListener("click", async (e) => {
      const doneBtn = e.target.closest(".activation-done-btn");
      if (doneBtn) {
        doneBtn.disabled = true;
        doneBtn.innerHTML = '<span class="btn-spinner"></span>';
        try {
          await api("/access/activation-pending/" + doneBtn.dataset.account + "/done", { method: "POST" });
        } catch (err) {
          alert(err.message || "No se pudo marcar como activada.");
        } finally {
          loadPendingOrders();
        }
        return;
      }

      const btn = e.target.closest(".order-action-btn");
      if (!btn) return;

      const orderName = btn.dataset.order;
      const act       = btn.dataset.act; // "approve" | "reject" | "clear" | "renew-message-only"

      // Sin confirmación — igual que los botones de Telegram, para poder
      // procesar rápido. Ojo al tocar: aprobar/rechazar/solo-mensaje sí
      // afectan al cliente. El spinner es solo para saber que está
      // procesando (antes no había ninguna señal de que el clic sí hizo
      // algo) — la lista se vuelve a pintar entera al terminar, así que no
      // hace falta restaurar el botón a mano.
      btn.closest("li").querySelectorAll("button").forEach(b => b.disabled = true);
      btn.innerHTML = '<span class="btn-spinner"></span>';
      try {
        await api("/orders/" + encodeURIComponent(orderName) + "/" + act, { method: "POST" });
      } catch (err) {
        alert(err.message || "No se pudo procesar el pedido.");
      } finally {
        loadPendingOrders();
      }
    });
  }

  function initOrdersActions() {
    wireOrderActions("orders-pending-list");
    wireOrderActions("renewals-list");

    const sweep = async (btn) => {
      btn.disabled = true;
      try {
        await api("/orders/sweep", { method: "POST" });
        loadPendingOrders();
      } catch { /* silencioso — la lista sigue mostrando lo último que había */ }
      finally {
        btn.disabled = false;
      }
    };
    document.getElementById("orders-sweep-btn").addEventListener("click", (e) => sweep(e.currentTarget));
    document.getElementById("renewals-sweep-btn").addEventListener("click", (e) => sweep(e.currentTarget));
  }

  function renderApprovedOrder(o, isNew) {
    const li = document.createElement("li");
    li.className = "feed-item" + (isNew ? " is-new" : "");
    // Primera línea del mensaje = el título ("✅ Orden confirmada...") — es
    // lo único que se ve en modo compacto; el resto sigue en el HTML para
    // que la búsqueda por celular (que busca en la base, no en pantalla)
    // no se vea afectada por si está compactado o no.
    const summary = (o.message.split("\n")[0] || o.message).trim();
    li.innerHTML = `
      <span class="feed-badge matched"></span>
      <div class="feed-main">
        <div class="orders-approved-summary">${summary}</div>
        <div class="orders-approved-text">${o.message}</div>
        <div class="feed-time">${fmtTime(o.createdAt)}</div>
      </div>
    `;
    // En modo compacto, un clic sobre la orden la expande solo a ella
    // (sin tocar el interruptor global) para ver el detalle completo.
    li.addEventListener("click", () => {
      const list = document.getElementById("orders-approved-list");
      if (!list.classList.contains("compact")) return;
      li.classList.toggle("item-expanded");
    });
    return li;
  }

  function renderApprovedList(orders, emptyMessage) {
    const list  = document.getElementById("orders-approved-list");
    const empty = document.getElementById("orders-approved-empty");
    list.innerHTML = "";
    if (orders.length === 0) {
      empty.hidden = false;
      empty.textContent = emptyMessage;
      return;
    }
    empty.hidden = true;
    for (const o of orders) list.appendChild(renderApprovedOrder(o, false));
  }

  async function loadApprovedOrders() {
    const { orders } = await api("/orders/approved?limit=30");
    renderApprovedList(orders, "Todavía no hay aprobaciones registradas.");
  }

  function prependApprovedOrder(evt) {
    if (approvedSearchDigits) return; // hay una búsqueda activa — no mezclar resultados
    const list  = document.getElementById("orders-approved-list");
    const empty = document.getElementById("orders-approved-empty");
    empty.hidden = true;
    list.prepend(renderApprovedOrder({ message: evt.message, createdAt: evt.createdAt }, true));
    while (list.children.length > 30) list.removeChild(list.lastChild);
  }

  let approvedSearchDigits  = "";
  let approvedSearchTimeout = null;

  function initApprovedSearch() {
    const input    = document.getElementById("approved-search");
    const clearBtn = document.getElementById("approved-search-clear");

    input.addEventListener("input", () => {
      clearTimeout(approvedSearchTimeout);
      approvedSearchDigits = input.value.replace(/\D/g, "");
      clearBtn.hidden = !approvedSearchDigits;

      if (!approvedSearchDigits) { loadApprovedOrders(); return; }
      approvedSearchTimeout = setTimeout(async () => {
        const { orders } = await api("/orders/approved?phone=" + approvedSearchDigits);
        renderApprovedList(orders, "Sin resultados para ese número.");
      }, 300);
    });

    clearBtn.addEventListener("click", () => {
      input.value = "";
      approvedSearchDigits = "";
      clearBtn.hidden = true;
      loadApprovedOrders();
    });
  }

  function initApprovedCompactToggle() {
    const btn  = document.getElementById("approved-compact-toggle");
    const list = document.getElementById("orders-approved-list");
    const compact = localStorage.getItem("ldp_approved_compact") === "1";
    list.classList.toggle("compact", compact);
    btn.classList.toggle("active", compact);

    btn.addEventListener("click", () => {
      const nowCompact = !list.classList.contains("compact");
      list.classList.toggle("compact", nowCompact);
      btn.classList.toggle("active", nowCompact);
      localStorage.setItem("ldp_approved_compact", nowCompact ? "1" : "0");
    });
  }

  // ─────────────────────────────────────────────────────────────
  // GRÁFICO — últimos 30 días (Pagos > Historial)
  // ─────────────────────────────────────────────────────────────

  let chart = null;
  let lastChartLoad = 0;

  async function loadChart() {
    const { days } = await api("/history?days=30");
    const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));

    const labels = ordered.map(d => fmtDateShort(d.date));
    const totals = ordered.map(d => d.total);
    const today  = todayLima();

    const canvas = document.getElementById("chart-daily");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const barColors = ordered.map(d => d.date === today ? "#16a34a" : "rgba(22,163,74,0.55)");

    if (chart) chart.destroy();
    chart = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Ingresos",
          data: totals,
          backgroundColor: barColors,
          borderRadius: 4,
          maxBarThickness: 22,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => moneyHidden ? "S/ " + MONEY_MASK : "S/ " + ctx.parsed.y.toLocaleString("es-PE", { minimumFractionDigits: 2 }),
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: "#9a9a9a", font: { size: 11 } },
          },
          y: {
            beginAtZero: true,
            grid: { color: "#efefef" },
            ticks: {
              color: "#9a9a9a",
              font: { size: 11 },
              callback: (v) => moneyHidden ? MONEY_MASK : "S/ " + v,
            },
          },
        },
      },
    });

    lastChartLoad = Date.now();
  }

  function refreshChartIfStale() {
    if (Date.now() - lastChartLoad > 30_000) loadChart();
  }

  function fmtDateShort(ymd) {
    const [, m, d] = ymd.split("-");
    const meses = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
    return `${Number(d)} ${meses[Number(m) - 1]}`;
  }

  // ─────────────────────────────────────────────────────────────
  // HISTORIAL
  // ─────────────────────────────────────────────────────────────

  async function loadHistory() {
    const { days } = await api("/history?days=90");
    const tbody = document.getElementById("history-tbody");
    tbody.innerHTML = "";

    for (const d of days) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${fmtDateLong(d.date)}</td>
        <td>${moneyValueHtml(fmtMoney(d.total))}</td>
        <td>${d.count || "—"}</td>
        <td><span class="badge ${d.source}">${badgeLabel(d.source)}</span></td>
        <td>${d.source === "manual" ? `<button class="row-delete-btn" data-date="${d.date}">Borrar</button>` : ""}</td>
      `;
      tr.addEventListener("click", (e) => {
        if (e.target.closest(".row-delete-btn")) return;
        openDayDetail(d.date);
      });
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll(".row-delete-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("¿Borrar este registro manual?")) return;
        await api("/history/" + btn.dataset.date, { method: "DELETE" });
        loadHistory();
      });
    });
  }

  function badgeLabel(source) {
    if (source === "auto") return "Automático";
    if (source === "manual") return "Manual";
    return "Sin datos";
  }

  // ─────────────────────────────────────────────────────────────
  // RENOVACIONES — avisos de vencimiento enviados (detalle por cliente)
  // ─────────────────────────────────────────────────────────────

  function fmtDateTime(iso) {
    try {
      return new Date(toUtcISOString(iso)).toLocaleString("es-PE", {
        timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
    } catch { return ""; }
  }

  // "YYYY-MM-DD" en hora Lima a partir de un ISO — para agrupar cada
  // aviso bajo la fecha (Lima) de la corrida a la que pertenece.
  function limaDateKey(iso) {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date(toUtcISOString(iso)));
    } catch { return ""; }
  }

  // ─────────────────────────────────────────────────────────────
  // RECORDATORIOS DE VENCIMIENTO — historial de las tandas manuales de
  // WhatsApp que se mandaban desde acá (reemplazadas por el SMS
  // automático, ver "RECORDATORIOS POR SMS" más abajo). Se deja el
  // historial de corridas como registro, detrás del botón "Historial"
  // (ya no hay botón para generar una corrida nueva).
  // ─────────────────────────────────────────────────────────────

  const RUN_STATUS_LABEL = { pending: "⏳ Pendiente", incomplete: "🟡 Incompleta", complete: "✅ Completa" };

  function renderRunStatusBadge(status) {
    const el = document.getElementById("reminders-run-status-badge");
    el.className = "badge " + ({ pending: "badge-run-pending", incomplete: "badge-run-incomplete", complete: "badge-run-complete" }[status] || "badge-run-pending");
    el.textContent = RUN_STATUS_LABEL[status] || status;
    el.hidden = false;
  }

  async function loadReminderRuns() {
    try {
      const { runs } = await api("/renewals/runs?limit=14");
      renderRenewalRunHistory(runs || []);
      const today = runs && runs[0];
      if (today) renderRunStatusBadge(today.status);
    } catch {
      // se deja lo último mostrado
    }
  }

  function openWhatsappHistory() {
    document.getElementById("whatsapp-history-modal").hidden = false;
    loadReminderRuns();
  }

  let currentDayEntries        = [];
  let renewalNotifSearchDigits = "";

  async function loadRenewalNotifications() {
    try {
      const { todaySent, todayFailed } = await api("/renewals/notifications?limit=300");
      document.getElementById("renewals-notif-today-sent").textContent   = todaySent;
      document.getElementById("renewals-notif-today-failed").textContent = todayFailed;
    } catch {
      // el bot puede estar reiniciando — se deja lo último mostrado
    }
  }

  // Resumen por día — clickear una fila abre el detalle (a quién se le
  // mandó recordatorio esa fecha) en el modal de historial.
  function renderRenewalRunHistory(runs) {
    const panel  = document.getElementById("renewals-run-history-panel");
    const empty  = document.getElementById("renewals-run-history-empty");
    const tbody  = document.getElementById("renewals-run-history-tbody");

    if (runs.length === 0) {
      panel.hidden = true;
      empty.hidden = false;
      return;
    }
    panel.hidden = false;
    empty.hidden = true;
    tbody.innerHTML = runs.map(r => `
      <tr data-date-key="${r.runDate}">
        <td>${fmtDateLong(r.runDate)}</td>
        <td>${r.sentCount}</td>
        <td><span class="badge ${{ pending: "badge-run-pending", incomplete: "badge-run-incomplete", complete: "badge-run-complete" }[r.status] || "badge-run-pending"}">${escapeHtml(RUN_STATUS_LABEL[r.status] || r.status)}</span></td>
      </tr>
    `).join("");

    tbody.querySelectorAll("tr").forEach(tr => {
      tr.addEventListener("click", () => openRenewalNotifDay(tr.dataset.dateKey));
    });
  }

  // Abre el modal de historial con quiénes fueron recordados esa fecha.
  async function openRenewalNotifDay(dateKey) {
    try {
      const { clients } = await api("/renewals/runs/" + dateKey + "/detail");
      currentDayEntries = clients || [];
    } catch {
      currentDayEntries = [];
    }

    const input = document.getElementById("renewals-notif-search");
    const clearBtn = document.getElementById("renewals-notif-search-clear");
    input.value = "";
    renewalNotifSearchDigits = "";
    clearBtn.hidden = true;

    document.getElementById("renewals-notif-day-title").textContent =
      "Historial de avisos — " + fmtDateLong(dateKey);
    applyRenewalNotifSearch();
    document.getElementById("renewals-notif-history-modal").hidden = false;
  }

  function applyRenewalNotifSearch() {
    const filtered = renewalNotifSearchDigits
      ? currentDayEntries.filter(n => n.clientPhone.replace(/\D/g, "").includes(renewalNotifSearchDigits))
      : currentDayEntries;
    renderRenewalNotifTable(filtered);
  }

  function renderRenewalNotifTable(entries) {
    const tbody = document.getElementById("renewals-notif-tbody");
    const empty = document.getElementById("renewals-notif-empty");
    tbody.innerHTML = "";

    if (entries.length === 0) {
      empty.textContent = renewalNotifSearchDigits ? "Sin resultados para ese número." : "No hay avisos registrados.";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    for (const n of entries) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${fmtDateTime(n.remindedAt)}</td>
        <td>${escapeHtml(n.clientPhone)}</td>
        <td>${escapeHtml(n.platform)}</td>
        <td>${escapeHtml(n.email)}</td>
        <td><span class="badge sent">✅ Enviado</span></td>
      `;
      tbody.appendChild(tr);
    }
  }

  function initRenewalNotifSearch() {
    const input    = document.getElementById("renewals-notif-search");
    const clearBtn = document.getElementById("renewals-notif-search-clear");

    input.addEventListener("input", () => {
      renewalNotifSearchDigits = input.value.replace(/\D/g, "");
      clearBtn.hidden = !renewalNotifSearchDigits;
      applyRenewalNotifSearch();
    });
    clearBtn.addEventListener("click", () => {
      input.value = "";
      renewalNotifSearchDigits = "";
      clearBtn.hidden = true;
      applyRenewalNotifSearch();
    });
  }

  // ─────────────────────────────────────────────────────────────
  // RECORDATORIOS POR SMS (ClickLab/Infobip) — corridas pendientes/hechas
  // por día (Hoy/Mañana), cada una con su propio botón de envío. El
  // historial completo (corridas pasadas + detalle por cliente) vive
  // detrás del botón "Historial", para no ensuciar la vista principal.
  // ─────────────────────────────────────────────────────────────

  const SMS_RUN_STATUS_LABEL = {
    pending: "⏳ Pendiente", sending: "📨 Enviando", incomplete: "🟡 Incompleta", complete: "✅ Completa",
  };
  const SMS_RUN_STATUS_CLASS = {
    pending: "badge-run-pending", sending: "badge-run-sending", incomplete: "badge-run-incomplete", complete: "badge-run-complete",
  };

  // Día por día: "Hoy" (colgados de ayer, si falló algo) y "Mañana"
  // (tanda nueva) — cada fila manda SOLO ese día, no los dos juntos.
  function renderSmsDays(days) {
    const list = document.getElementById("sms-days-list");
    list.innerHTML = days.map(d => `
      <div class="sms-day-row" data-date="${d.date}">
        <div class="sms-day-label">
          ${escapeHtml(d.label)}
          <span class="sms-day-count">${d.pendingCount > 0 ? `${d.pendingCount} pendiente${d.pendingCount === 1 ? "" : "s"}` : "sin pendientes"}</span>
        </div>
        ${d.pendingCount > 0
          ? `<button class="btn-primary btn-sm sms-day-send-btn" data-date="${d.date}">Enviar</button>`
          : `<span class="badge badge-run-complete">✅ Hecho</span>`}
      </div>
    `).join("");
  }

  async function loadSmsDays() {
    try {
      const { days } = await api("/renewals/sms/days");
      renderSmsDays(days || []);
    } catch (err) {
      document.getElementById("sms-days-list").innerHTML = `<p class="panel-hint">${escapeHtml(err.message)}</p>`;
    }
  }

  async function sendSmsForDay(date, btn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Enviando…";
    const summaryEl = document.getElementById("sms-summary");
    summaryEl.hidden = false;
    summaryEl.textContent = "Enviando SMS…";
    try {
      const { sent, failed, message } = await api("/renewals/sms/send", { method: "POST", body: JSON.stringify({ date }) });
      summaryEl.textContent = message
        || `Listo (${fmtDateLong(date)}): ${sent} enviado${sent === 1 ? "" : "s"}${failed ? `, ${failed} fallido${failed === 1 ? "" : "s"}` : ""}.`;
    } catch (err) {
      summaryEl.textContent = err.message || "No se pudo enviar.";
    } finally {
      loadSmsDays();
    }
  }

  function initSmsDays() {
    document.getElementById("sms-days-list").addEventListener("click", (e) => {
      const btn = e.target.closest(".sms-day-send-btn");
      if (!btn) return;
      sendSmsForDay(btn.dataset.date, btn);
    });
  }

  // ── Historial — corridas pasadas + detalle por cliente de cada una ──

  function renderSmsRunHistory(runs) {
    const empty = document.getElementById("sms-run-history-empty");
    const tbody = document.getElementById("sms-run-history-tbody");

    if (runs.length === 0) {
      empty.hidden = false;
      tbody.innerHTML = "";
      return;
    }
    empty.hidden = true;
    tbody.innerHTML = runs.map(r => `
      <tr data-date-key="${r.runDate}">
        <td>${fmtDateLong(r.runDate)}</td>
        <td>${r.sentCount}</td>
        <td>${r.failedCount}</td>
        <td><span class="badge ${SMS_RUN_STATUS_CLASS[r.status] || "badge-run-pending"}">${escapeHtml(SMS_RUN_STATUS_LABEL[r.status] || r.status)}</span></td>
      </tr>
    `).join("");

    tbody.querySelectorAll("tr").forEach(tr => {
      tr.addEventListener("click", () => openSmsRunDay(tr.dataset.dateKey));
    });
  }

  async function loadSmsReminderRuns() {
    try {
      const { runs } = await api("/renewals/sms/runs?limit=14");
      renderSmsRunHistory(runs || []);
    } catch {
      // se deja lo último mostrado
    }
  }

  function openSmsHistory() {
    document.getElementById("sms-history-modal").hidden = false;
    loadSmsReminderRuns();
  }

  async function openSmsRunDay(dateKey) {
    let entries = [];
    try {
      const data = await api("/renewals/sms/runs/" + dateKey + "/detail");
      entries = data.entries || [];
    } catch { /* se deja vacío */ }

    const tbody = document.getElementById("sms-run-detail-tbody");
    const empty = document.getElementById("sms-run-detail-empty");
    tbody.innerHTML = "";
    if (entries.length === 0) {
      empty.hidden = false;
    } else {
      empty.hidden = true;
      for (const e of entries) {
        const tr = document.createElement("tr");
        const statusBadge = e.status === "sent"
          ? `<span class="badge sent">✅ Enviado</span>`
          : `<span class="badge failed" title="${escapeHtml(e.error)}">❌ Falló</span>`;
        tr.innerHTML = `
          <td>${fmtDateTime(e.createdAt)}</td>
          <td>${escapeHtml(e.clientPhone)}</td>
          <td>${escapeHtml(e.platforms)}</td>
          <td>${statusBadge}</td>
        `;
        tbody.appendChild(tr);
      }
    }

    document.getElementById("sms-history-modal").hidden = true;
    document.getElementById("sms-run-day-title").textContent = "Historial de SMS — " + fmtDateLong(dateKey);
    document.getElementById("sms-run-history-modal").hidden = false;
  }

  function initSmsReminders() {
    initSmsDays();
    document.getElementById("sms-history-btn").addEventListener("click", openSmsHistory);
  }

  // ─────────────────────────────────────────────────────────────
  // HISTÓRICO POR MES
  // ─────────────────────────────────────────────────────────────

  async function openMonthsModal() {
    const { months } = await api("/history/months");
    const body = document.getElementById("months-modal-body");

    if (months.length === 0) {
      body.innerHTML = `<p>Todavía no hay meses con datos.</p>`;
    } else {
      body.innerHTML = months.map(m => `
        <div class="day-detail-row">
          <span>${escapeHtml(fmtMonthName(m.month))}<br><small>${pluralPagos(m.count)}</small></span>
          <b>${moneyValueHtml(fmtMoney(m.total))}</b>
        </div>
      `).join("");
    }

    document.getElementById("months-modal").hidden = false;
  }

  function initMonthsModal() {
    document.getElementById("show-months-btn").addEventListener("click", openMonthsModal);
  }

  async function openDayDetail(date) {
    const info = await api("/history/" + date);
    document.getElementById("day-modal-title").textContent = fmtDateLong(date);
    const body = document.getElementById("day-modal-body");

    if (info.source === "none") {
      body.innerHTML = `<p>Sin datos para este día.</p>`;
    } else if (info.source === "manual") {
      body.innerHTML = `
        <div class="day-detail-row"><span>Total (manual)</span><b>${moneyValueHtml(fmtMoney(info.total))}</b></div>
        ${info.note ? `<div class="day-detail-row"><span>Nota</span><span>${escapeHtml(info.note)}</span></div>` : ""}
      `;
    } else {
      const rows = info.payments.map(p => `
        <div class="day-detail-row">
          <span>${fmtTime(p.createdAt)} · ${escapeHtml(p.senderName)}<br><small>${fmtCode(p)}</small></span>
          <b>${moneyValueHtml(fmtMoney(p.amount))}</b>
        </div>
      `).join("");
      body.innerHTML = `
        <div class="day-detail-row"><span><b>Total del día</b></span><b>${moneyValueHtml(fmtMoney(info.total))}</b></div>
        ${rows}
      `;
    }

    document.getElementById("day-modal").hidden = false;
  }

  // Cerrar modales: botón X, o clic en el fondo oscuro (fuera de la tarjeta)
  document.querySelectorAll("[data-close-modal]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.getElementById(btn.dataset.closeModal).hidden = true;
    });
  });
  document.querySelectorAll(".modal-backdrop").forEach(backdrop => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.hidden = true;
    });
  });

  // ── Modal: agregar día manual ──
  const manualModal = document.getElementById("manual-modal");
  document.getElementById("add-manual-btn").addEventListener("click", () => {
    document.getElementById("manual-form").reset();
    document.getElementById("manual-error").hidden = true;
    document.getElementById("manual-date").max = todayLima();
    manualModal.hidden = false;
  });
  document.getElementById("manual-cancel").addEventListener("click", () => { manualModal.hidden = true; });

  document.getElementById("manual-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const date   = document.getElementById("manual-date").value;
    const amount = document.getElementById("manual-amount").value;
    const note   = document.getElementById("manual-note").value;
    const errorEl = document.getElementById("manual-error");
    errorEl.hidden = true;

    try {
      await api("/history/" + date, {
        method: "PUT",
        body: JSON.stringify({ amount: Number(amount), note }),
      });
      manualModal.hidden = true;
      loadHistory();
      loadChart();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });

  // ─────────────────────────────────────────────────────────────
  // ARRANQUE
  // ─────────────────────────────────────────────────────────────

  let booted = false;
  async function boot() {
    if (booted) return;
    booted = true;

    initTabs();
    initConfigSubnav();

    // Se queda en la sección donde estaba al actualizar la página, en vez
    // de volver siempre a "Resumen" — el dato se recarga igual (cada vista
    // pide lo suyo al entrar), solo no se pierde DÓNDE estaba parado.
    try {
      const savedView = localStorage.getItem(ADMIN_VIEW_KEY);
      if (savedView && VALID_VIEWS.includes(savedView) && savedView !== "resumen") switchView(savedView);
    } catch { /* localStorage bloqueado — se queda en Resumen, default normal */ }

    initSoundToggle();
    initMoneyToggle();
    initCodeSearch();
    if (window.LiordarkAccess) window.LiordarkAccess.init();
    if (window.LiordarkCatalog) window.LiordarkCatalog.init();
    if (window.LiordarkSettings) window.LiordarkSettings.init();
    if (window.LiordarkWholesalers) window.LiordarkWholesalers.init();
    if (window.LiordarkSupportChat) window.LiordarkSupportChat.init();

    const { payments, stats } = await api("/live/initial");
    cachedLivePayments = payments;
    renderStats(stats);
    renderFeedList(payments);
    connectLive();

    initOrdersActions();
    initPendingSearch();
    initApprovedSearch();
    initRenewalNotifSearch();
    initSmsReminders();
    document.getElementById("whatsapp-history-btn").addEventListener("click", openWhatsappHistory);
    initApprovedCompactToggle();
    initMonthsModal();
    loadPendingOrders();
    loadApprovedOrders();
    setInterval(loadPendingOrders, ORDERS_POLL_MS);

    loadConnectorsStatus();
    setInterval(loadConnectorsStatus, CONNECTORS_POLL_MS);

    loadStockAlert();
    setInterval(loadStockAlert, CONNECTORS_POLL_MS);

    document.getElementById("resumen-quick-assign-btn").addEventListener("click", () => {
      if (window.LiordarkAccess) window.LiordarkAccess.openComboOrderModal();
    });

    loadProviderRenewalsCount();
    setInterval(loadProviderRenewalsCount, CONNECTORS_POLL_MS);
    document.getElementById("resumen-provider-renewals-btn").addEventListener("click", () => {
      switchView("renewals");
    });

    initLiveResync();
  }

  // ─────────────────────────────────────────────────────────────
  // Resincronización al volver a la pestaña — un navegador en segundo
  // plano pausa/retarda setInterval y puede dejar el EventSource colgado
  // sin que dispare onerror (el admin notaba "tengo que refrescar" tras
  // minutos sin mirar el panel). Al recuperar foco: reconecta el SSE si
  // quedó cerrado y refresca de una vez pedidos, soportes y chat.
  // ─────────────────────────────────────────────────────────────

  function resyncAll() {
    if (!evtSource || evtSource.readyState === EventSource.CLOSED) connectLive();
    loadPendingOrders();
    loadConnectorsStatus();
    loadStockAlert();
    if (window.LiordarkSupportChat) window.LiordarkSupportChat.load();
    if (window.LiordarkWholesalers) window.LiordarkWholesalers.load();
    if (window.LiordarkWebCustomers) window.LiordarkWebCustomers.load();
  }

  function initLiveResync() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") resyncAll();
    });
    window.addEventListener("focus", resyncAll);
  }

  checkAuth();
})();
