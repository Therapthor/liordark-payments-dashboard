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

  function fmtDateShort(ymd) {
    const [, m, d] = ymd.split("-");
    const meses = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
    return `${Number(d)} ${meses[Number(m) - 1]}`;
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

  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString("es-PE", {
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

  // "Pagos" es un desplegable con dos sub-vistas (En vivo / Historial);
  // "Accesos" es un botón directo aparte.
  function switchView(view) {
    document.getElementById("view-live").hidden    = view !== "live";
    document.getElementById("view-access").hidden  = view !== "access";
    document.getElementById("view-history").hidden = view !== "history";

    const isPagos = view === "live" || view === "history";
    document.getElementById("pagos-toggle").classList.toggle("active", isPagos);
    document.querySelectorAll(".tab-dropdown-item").forEach(item => {
      item.classList.toggle("active", item.dataset.view === view);
    });
    const accessBtn = document.querySelector('.tab-btn[data-view="access"]');
    if (accessBtn) accessBtn.classList.toggle("active", view === "access");

    if (view === "history") loadHistory();
    if (view === "access" && window.LiordarkAccess) window.LiordarkAccess.load();
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

    document.querySelector('.tab-btn[data-view="access"]').addEventListener("click", () => {
      menu.hidden = true;
      switchView("access");
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
    setMoneyText(document.getElementById("stat-month-total"), fmtMoney(stats.month.total));
    document.getElementById("stat-month-count").textContent   = pluralPagos(stats.month.count);
    setMoneyText(document.getElementById("stat-alltime-total"), fmtMoney(stats.allTime.total));
    document.getElementById("stat-alltime-count").textContent = pluralPagos(stats.allTime.count);

    if (stats.lastMonth) {
      document.getElementById("stat-lastmonth-label").textContent = "Mes pasado";
      setMoneyText(document.getElementById("stat-lastmonth-total"), fmtMoney(stats.lastMonth.total));
      document.getElementById("stat-lastmonth-count").textContent = pluralPagos(stats.lastMonth.count);

      // Mismo dato, resumido arriba de la tabla de Historial.
      const histTotal = document.getElementById("history-lastmonth-total");
      const histCount = document.getElementById("history-lastmonth-count");
      if (histTotal) setMoneyText(histTotal, fmtMoney(stats.lastMonth.total));
      if (histCount) histCount.textContent = pluralPagos(stats.lastMonth.count);
      const hint = document.getElementById("history-lastmonth-hint");
      if (hint) hint.firstChild.textContent = "Mes pasado (" + fmtMonthName(stats.lastMonth.month) + "): ";
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

  function renderFeedItem(p, isNew) {
    const li = document.createElement("li");
    li.className = "feed-item" + (isNew ? " is-new" : "");
    li.dataset.id = p.id;
    li.innerHTML = `
      <span class="feed-badge ${statusClass(p.status)}"></span>
      <div class="feed-main">
        <div class="feed-name">${escapeHtml(p.senderName)}</div>
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
        playChime();
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

  function renderPendingOrder(o) {
    const li = document.createElement("li");
    li.className = "feed-item";
    const cls = ORDER_STATUS_CLASS[o.status] || "pending";
    li.innerHTML = `
      <span class="feed-badge ${cls}"></span>
      <div class="feed-main">
        <div class="feed-name">${escapeHtml(o.platform)} · ${escapeHtml(o.phone)}</div>
        <div class="feed-time">${fmtTime(o.createdAt)} · <span class="feed-status ${cls}">${escapeHtml(ORDER_STATUS_LABEL[o.status] || o.status)}</span></div>
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

  // Se guarda el último fetch para poder filtrar por celular sin
  // tener que golpear al bot de nuevo en cada tecla.
  let cachedPendingOrders = [];
  let pendingSearchDigits = "";

  function renderPendingList(orders) {
    const list  = document.getElementById("orders-pending-list");
    const empty = document.getElementById("orders-pending-empty");
    const count = document.getElementById("orders-pending-count");
    count.textContent = orders.length;
    list.innerHTML = "";
    if (orders.length === 0) {
      empty.hidden = false;
      empty.textContent = pendingSearchDigits ? "Sin resultados para ese número." : "No hay pedidos pendientes 🎉";
      return;
    }
    empty.hidden = true;
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
      const { orders } = await api("/orders/pending");
      cachedPendingOrders = orders.filter(o => !o.isRenewal);
      applyPendingSearch();
      renderRenewalList(orders.filter(o => o.isRenewal));
    } catch {
      // el bot puede estar reiniciando — se deja lo último mostrado
    }
  }

  function applyPendingSearch() {
    const filtered = pendingSearchDigits
      ? cachedPendingOrders.filter(o => o.phone.replace(/\D/g, "").includes(pendingSearchDigits))
      : cachedPendingOrders;
    renderPendingList(filtered);
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
      const btn = e.target.closest(".order-action-btn");
      if (!btn) return;

      const orderName = btn.dataset.order;
      const act       = btn.dataset.act; // "approve" | "reject" | "clear" | "renew-message-only"

      // Sin confirmación — igual que los botones de Telegram, para poder
      // procesar rápido. Ojo al tocar: aprobar/rechazar/solo-mensaje sí
      // afectan al cliente.
      btn.closest("li").querySelectorAll("button").forEach(b => b.disabled = true);
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
  // GRÁFICO — últimos 30 días
  // ─────────────────────────────────────────────────────────────

  let chart = null;
  let lastChartLoad = 0;

  async function loadChart() {
    const { days } = await api("/history?days=30");
    const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));

    const labels = ordered.map(d => fmtDateShort(d.date));
    const totals = ordered.map(d => d.total);
    const today  = todayLima();

    const ctx = document.getElementById("chart-daily").getContext("2d");
    const barColors = ordered.map(d => d.date === today ? "#3987e5" : "rgba(57,135,229,0.55)");

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
            ticks: { color: "#898781", font: { size: 11 } },
          },
          y: {
            beginAtZero: true,
            grid: { color: "#2c2c2a" },
            ticks: {
              color: "#898781",
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
    initSoundToggle();
    initMoneyToggle();
    initCodeSearch();
    if (window.LiordarkAccess) window.LiordarkAccess.init();

    const { payments, stats } = await api("/live/initial");
    cachedLivePayments = payments;
    renderStats(stats);
    renderFeedList(payments);
    await loadChart();
    connectLive();

    initOrdersActions();
    initPendingSearch();
    initApprovedSearch();
    initApprovedCompactToggle();
    initMonthsModal();
    loadPendingOrders();
    loadApprovedOrders();
    setInterval(loadPendingOrders, ORDERS_POLL_MS);
  }

  checkAuth();
})();
