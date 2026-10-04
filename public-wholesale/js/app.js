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

  function expiryClass(days) {
    if (days === null || days === undefined) return "";
    if (days < 0) return "expiry-over";
    if (days <= 5) return "expiry-soon";
    return "expiry-ok";
  }

  function expiryLabel(expiresAt, days) {
    if (!expiresAt) return "Sin fecha";
    if (days < 0) return `Venció hace ${Math.abs(days)}d · ${fmtDate(expiresAt)}`;
    if (days === 0) return `Vence hoy · ${fmtDate(expiresAt)}`;
    return `Vence en ${days}d · ${fmtDate(expiresAt)}`;
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

  let lockoutTimer = null;

  function startLoginLockoutCountdown(seconds) {
    const btn = document.querySelector('#login-form button[type="submit"]');
    if (!btn) return;
    if (lockoutTimer) { clearInterval(lockoutTimer); lockoutTimer = null; }
    if (!seconds || seconds <= 0) return;
    let remaining = Math.ceil(seconds);
    const original = btn.dataset.originalLabel || btn.textContent;
    btn.dataset.originalLabel = original;
    btn.disabled = true;
    const tick = () => {
      if (remaining <= 0) {
        clearInterval(lockoutTimer);
        lockoutTimer = null;
        btn.disabled = false;
        btn.textContent = original;
        return;
      }
      btn.textContent = `Espera ${remaining}s…`;
      remaining--;
    };
    tick();
    lockoutTimer = setInterval(tick, 1000);
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
        setFormError("login-error", err.message);
        if (err.status === 429) startLoginLockoutCountdown(err.data && err.data.retryAfterSeconds);
      }
    });

    document.getElementById("app-logout-btn").addEventListener("click", async () => {
      try { await api("/auth/logout", { method: "POST" }); } catch { /* no crítico */ }
      cartItems = [];
      showAuth();
    });
  }

  async function onAuthenticated() {
    showApp();
    await Promise.all([refreshBalance(), refreshUnseenBadge()]);
    switchPage("clientes");
  }

  // ─────────────────────────────────────────────────────────────
  // SHELL — header con saldo + nav (sidebar en desktop, tabs abajo en
  // mobile). Un solo arreglo de páginas genera ambas navegaciones.
  // ─────────────────────────────────────────────────────────────

  const PAGES = [
    { id: "clientes",      label: "Clientes",      icon: "👥" },
    { id: "comprar",       label: "Comprar",       icon: "🛒" },
    { id: "cuentas",       label: "Cuentas",       icon: "📦", badge: true },
    { id: "resumen",       label: "Resumen",       icon: "📊" },
    { id: "creditos",      label: "Créditos",      icon: "💳" },
    { id: "recordatorios", label: "Recordatorios", icon: "🔔" },
    { id: "soporte",       label: "Soporte",       icon: "💬" },
  ];

  function renderNav() {
    const tabBar      = document.getElementById("tab-bar");
    const sidebarNav  = document.getElementById("sidebar-nav");

    tabBar.innerHTML = PAGES.map(p => `
      <button class="tab-btn" data-page="${p.id}" type="button">
        <span class="tab-btn-icon">${p.icon}</span>
        <span>${escapeHtml(p.label)}</span>
        ${p.badge ? `<span class="tab-badge" id="badge-${p.id}-tab" hidden>0</span>` : ""}
      </button>
    `).join("");

    sidebarNav.innerHTML = PAGES.map(p => `
      <button class="sidebar-btn" data-page="${p.id}" type="button">
        <span class="sidebar-btn-icon">${p.icon}</span>
        <span>${escapeHtml(p.label)}</span>
        ${p.badge ? `<span class="sidebar-badge" id="badge-${p.id}-sidebar" hidden>0</span>` : ""}
      </button>
    `).join("");

    document.querySelectorAll(".tab-btn[data-page], .sidebar-btn[data-page]").forEach(btn => {
      btn.addEventListener("click", () => switchPage(btn.dataset.page));
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
    document.querySelectorAll(".tab-btn[data-page]").forEach(b => b.classList.toggle("active", b.dataset.page === view));
    document.querySelectorAll(".sidebar-btn[data-page]").forEach(b => b.classList.toggle("active", b.dataset.page === view));
    document.querySelectorAll(".page").forEach(sec => { sec.hidden = sec.id !== "page-" + view; });
    document.getElementById("app-main").scrollTo(0, 0);
    window.scrollTo(0, 0);

    if (view === "clientes")      loadClients();
    else if (view === "comprar")       loadComprar();
    else if (view === "cuentas")       loadCuentas();
    else if (view === "resumen")       loadResumen();
    else if (view === "creditos")      loadCreditos();
    else if (view === "recordatorios") loadReminders();
  }

  let currentBalanceCents = 0;

  async function refreshBalance() {
    try {
      const { balanceCents, displayName, phone } = await api("/balance");
      currentBalanceCents = balanceCents;
      document.getElementById("header-hello").textContent = "Hola, " + (displayName || phone || "");
      document.getElementById("header-balance").textContent = "Saldo: " + money(balanceCents);
      const creditsBalanceEl = document.getElementById("credits-balance-value");
      if (creditsBalanceEl) creditsBalanceEl.textContent = money(balanceCents);
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
      cachedCatalog = [];
    }
    return cachedCatalog;
  }

  function catalogItem(platform) {
    return cachedCatalog.find(c => c.platform === platform) || null;
  }

  // ─────────────────────────────────────────────────────────────
  // CLIENTES — sub-clientes del mayorista con perfil asignado.
  // ─────────────────────────────────────────────────────────────

  const RENEWAL_ICON  = { "": "➖", yes: "✅", no: "❌" };
  const RENEWAL_NEXT  = { "": "yes", yes: "no", no: "" };
  const RENEWAL_TITLE = { "": "Marcar si renueva", yes: "Renueva — clic para marcar que no", no: "No renueva — clic para dejar sin marcar" };

  let cachedClients = [];

  async function loadClients() {
    const listEl  = document.getElementById("clients-list");
    const emptyEl = document.getElementById("clients-empty");
    listEl.innerHTML = `<p class="muted small">Cargando…</p>`;
    emptyEl.hidden = true;
    try {
      const [, { clients }] = await Promise.all([fetchCatalog(), api("/clients")]);
      cachedClients = clients || [];
      renderClients();
    } catch (err) {
      listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function clientCardHtml(c) {
    const days   = daysLeftFor(c.expiresAt);
    const cls    = expiryClass(days);
    const label  = expiryLabel(c.expiresAt, days);
    const status = c.renewalStatus || "";
    return `
      <div class="client-card" data-profile-id="${c.id}">
        <div class="client-card-head">
          <div>
            <div class="client-platform">${escapeHtml(c.platform)}</div>
            <div class="client-phone">${escapeHtml(c.clientPhone)}</div>
          </div>
          <button class="renewal-btn renewal-${status || "unset"}" data-act="marker" data-profile-id="${c.id}" title="${RENEWAL_TITLE[status]}">${RENEWAL_ICON[status]}</button>
        </div>
        <div class="client-expiry ${cls}">${escapeHtml(label)}</div>
        ${c.email ? `<div class="client-email">${escapeHtml(c.email)}</div>` : ""}
        <div class="client-card-actions">
          <button class="btn-primary btn-sm" data-act="renew" data-profile-id="${c.id}" type="button">💰 Renovar</button>
          <button class="btn-ghost btn-sm" data-act="send" data-profile-id="${c.id}" type="button">📧 Enviar cuenta</button>
          <button class="btn-danger btn-sm" data-act="delete" data-profile-id="${c.id}" type="button">🗑 Eliminar</button>
        </div>
      </div>`;
  }

  function renderClients() {
    const listEl  = document.getElementById("clients-list");
    const emptyEl = document.getElementById("clients-empty");
    if (cachedClients.length === 0) {
      listEl.innerHTML = "";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    listEl.innerHTML = cachedClients.map(clientCardHtml).join("");
  }

  async function handleRenewalMarker(btn, client) {
    const next = RENEWAL_NEXT[client.renewalStatus || ""];
    try {
      const { profile } = await api(`/clients/${client.id}/renewal-marker`, { method: "POST", body: { status: next } });
      client.renewalStatus = profile.renewalStatus;
      btn.className = "renewal-btn renewal-" + (next || "unset");
      btn.title = RENEWAL_TITLE[next];
      btn.textContent = RENEWAL_ICON[next];
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleRenew(client) {
    const product   = catalogItem(client.platform);
    const priceLine = product ? `Se descontará S/ ${product.wholesalePrice} de tu saldo.` : "Se descontará el precio mayorista de tu saldo.";
    if (!confirm(`¿Renovar "${client.platform}" de ${client.clientPhone}?\n${priceLine}\nLa cuenta se extiende 30 días.`)) return;
    try {
      const { account } = await api(`/clients/${client.id}/renew`, { method: "POST" });
      client.expiresAt = account ? account.expiresAt : client.expiresAt;
      renderClients();
      await refreshBalance();
    } catch (err) {
      alert(err.message);
    }
  }

  function handleSendClientAccount(client) {
    const msg = `Hola! 👋 Te paso los datos de tu cuenta de *${client.platform}*:\n\nCorreo: ${client.email || "—"}\nContraseña: ${client.password || "—"}\n\nCualquier duda me escribes por acá. 🙌`;
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
      const act = btn.dataset.act;
      if (act === "marker") handleRenewalMarker(btn, client);
      else if (act === "renew") handleRenew(client);
      else if (act === "send") handleSendClientAccount(client);
      else if (act === "delete") handleDeleteClient(client);
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
      const { profiles, fullAccountOrders } = await api("/accounts");
      renderCuentasProfiles(profiles || []);
      cachedFullOrders = fullAccountOrders || [];
      renderCuentasOrders();
    } catch (err) {
      profilesList.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function cuentaProfileCardHtml(p) {
    const days  = daysLeftFor(p.expiresAt);
    const cls   = expiryClass(days);
    const label = expiryLabel(p.expiresAt, days);
    return `
      <div class="client-card">
        <div class="client-card-head">
          <div>
            <div class="client-platform">${escapeHtml(p.platform)}</div>
            <div class="client-phone">${escapeHtml(p.clientPhone)}</div>
          </div>
        </div>
        <div class="client-expiry ${cls}">${escapeHtml(label)}</div>
        ${p.email ? `<div class="client-email">${escapeHtml(p.email)}</div>` : ""}
        <div class="client-card-actions">
          <button class="btn-ghost btn-sm" data-act="send" data-phone="${escapeHtml(p.clientPhone)}" data-platform="${escapeHtml(p.platform)}" data-email="${escapeHtml(p.email || "")}" data-password="${escapeHtml(p.password || "")}" type="button">📧 Enviar cuenta</button>
        </div>
      </div>`;
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
          <button class="btn-ghost btn-sm" data-act="send-order" data-id="${o.id}" type="button">📧 Enviar</button>
        </div>`;
    }
    const metaLine = o.status === "delivered"
      ? `Entregado: ${escapeHtml(fmtDateTime(o.deliveredAt))}`
      : `Antes de: ${escapeHtml(fmtDateTime(o.dueBy))}`;
    return `
      <div class="order-card">
        <div class="order-card-head">
          <span class="order-platform">${escapeHtml(o.platform)} ×${o.quantity}</span>
          <span class="status-chip status-${escapeHtml(o.status)}">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="order-meta">Cliente: ${escapeHtml(o.endClientPhone)} · ${money(o.totalCents)}</div>
        <div class="order-meta">${metaLine}</div>
        ${credsHtml}
        ${actionsHtml}
      </div>`;
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
      const msg = `Hola! 👋 Te paso los datos de tu cuenta de *${btn.dataset.platform}*:\n\nCorreo: ${btn.dataset.email || "—"}\nContraseña: ${btn.dataset.password || "—"}\n\nCualquier duda me escribes por acá. 🙌`;
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
  // RESUMEN
  // ─────────────────────────────────────────────────────────────

  async function loadResumen() {
    try {
      const { activeCount, expiringCount, totalClients } = await api("/summary");
      document.getElementById("stat-active").textContent    = activeCount;
      document.getElementById("stat-expiring").textContent  = expiringCount;
      document.getElementById("stat-total").textContent     = totalClients;
    } catch (err) {
      document.getElementById("stat-active").textContent = "—";
      document.getElementById("stat-expiring").textContent = "—";
      document.getElementById("stat-total").textContent = "—";
      console.error(err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // CRÉDITOS — saldo, historial y recarga por Yape.
  // ─────────────────────────────────────────────────────────────

  const LEDGER_TYPE_LABEL = {
    topup_yape:             "Recarga Yape",
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
      const original = btn.textContent;
      btn.textContent = "✅";
      setTimeout(() => { btn.textContent = original; }, 1200);
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

  function cartQtyFor(platform) {
    const item = cartItems.find(i => i.platform === platform);
    return item ? item.qty : 0;
  }

  function catalogCardHtml(p) {
    const qty = cartQtyFor(p.platform);
    const img = mediaHtml(p.imageUrl, (p.platform || "").slice(0, 3).toUpperCase());
    const stepper = qty > 0
      ? `<div class="catalog-qty-stepper">
           <button class="qty-btn" data-act="dec" data-platform="${escapeHtml(p.platform)}" type="button" aria-label="Quitar uno">−</button>
           <span class="qty-value">${qty}</span>
           <button class="qty-btn" data-act="inc" data-platform="${escapeHtml(p.platform)}" type="button" aria-label="Agregar uno" ${qty >= p.freeStock ? "disabled" : ""}>+</button>
         </div>`
      : `<button class="catalog-add-btn" data-act="inc" data-platform="${escapeHtml(p.platform)}" type="button" aria-label="Agregar al carrito">+</button>`;
    return `
      <div class="catalog-card">
        <div class="catalog-card-img">${img}</div>
        <div class="catalog-card-body">
          <div class="catalog-card-title">${escapeHtml(p.title)}</div>
          <div class="catalog-card-price">S/ ${escapeHtml(p.wholesalePrice)}</div>
          <div class="catalog-card-stock">${p.freeStock} disponible${p.freeStock === 1 ? "" : "s"}</div>
        </div>
        ${stepper}
      </div>`;
  }

  function renderComprarGrid() {
    const grid  = document.getElementById("catalog-grid");
    const empty = document.getElementById("catalog-empty");
    if (cachedCatalog.length === 0) {
      grid.innerHTML = "";
      empty.hidden = false;
    } else {
      empty.hidden = true;
      grid.innerHTML = cachedCatalog.map(catalogCardHtml).join("");
    }
    renderCart();
  }

  function cartTotalCents() {
    return cartItems.reduce((sum, i) => {
      const p = catalogItem(i.platform);
      const price = p ? Number(p.wholesalePrice) : 0;
      return sum + Math.round(price * 100) * i.qty;
    }, 0);
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
    list.innerHTML = cartItems.map(i => {
      const p = catalogItem(i.platform);
      const title = p ? p.title : i.platform;
      const price = p ? Number(p.wholesalePrice) : 0;
      return `<div class="cart-row"><span>${escapeHtml(title)} ×${i.qty}</span><span>S/ ${(price * i.qty).toFixed(2)}</span></div>`;
    }).join("");
    totalEl.textContent = money(cartTotalCents());
    buyBtn.disabled = false;
  }

  function renderFullOrderPlatformOptions() {
    const select = document.getElementById("full-order-platform");
    if (!select) return;
    const previous = select.value;
    select.innerHTML = cachedCatalog.length
      ? cachedCatalog.map(p => `<option value="${escapeHtml(p.platform)}">${escapeHtml(p.title)} — S/ ${escapeHtml(p.wholesaleFullPrice)}</option>`).join("")
      : `<option value="">Sin plataformas disponibles</option>`;
    if (previous && cachedCatalog.some(p => p.platform === previous)) select.value = previous;
  }

  async function loadComprar() {
    const grid = document.getElementById("catalog-grid");
    grid.innerHTML = `<p class="muted small">Cargando…</p>`;
    try {
      await fetchCatalog();
      renderComprarGrid();
      renderFullOrderPlatformOptions();
    } catch (err) {
      grid.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function purchaseAccountCardHtml(a, idx) {
    return `
      <div class="success-account-card">
        <div class="success-account-head">
          <span class="success-account-platform">${escapeHtml(a.platform)}</span>
        </div>
        <div class="success-account-row"><b>Correo:</b> ${escapeHtml(a.email)}</div>
        <div class="success-account-row"><b>Contraseña:</b> ${escapeHtml(a.password)}</div>
        <div class="success-account-actions">
          <button class="btn-wa btn-xs" data-act="send" data-idx="${idx}" type="button">📧 Enviar</button>
          <button class="btn-ghost btn-xs" data-act="copy" data-idx="${idx}" type="button">📋 Copiar</button>
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
      if (btn.dataset.act === "inc") {
        if (!item) { item = { platform, qty: 0 }; cartItems.push(item); }
        if (item.qty < product.freeStock) item.qty++;
      } else if (btn.dataset.act === "dec" && item) {
        item.qty--;
        if (item.qty <= 0) cartItems = cartItems.filter(i => i !== item);
      }
      renderComprarGrid();
    });

    document.getElementById("cart-buy-btn").addEventListener("click", () => {
      if (cartItems.length === 0) return;
      document.getElementById("cart-checkout-phone").value = "";
      setFormError("cart-checkout-error", "");
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

      const platforms = [];
      cartItems.forEach(i => { for (let n = 0; n < i.qty; n++) platforms.push(i.platform); });

      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const result = await api("/purchase", { method: "POST", body: { platforms, clientPhone } });
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
        const msg = `Hola! 👋 Te paso los datos de tu cuenta de *${account.platform}*:\n\nCorreo: ${account.email}\nContraseña: ${account.password}\n\n¡Gracias por tu compra! 🙌`;
        window.open(waLink(lastPurchaseClientPhone, msg), "_blank");
      } else if (btn.dataset.act === "copy") {
        try {
          await navigator.clipboard.writeText(`${account.platform}\nCorreo: ${account.email}\nContraseña: ${account.password}`);
          const original = btn.textContent;
          btn.textContent = "✅ Copiado";
          setTimeout(() => { btn.textContent = original; }, 1500);
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
  // SOPORTE
  // ─────────────────────────────────────────────────────────────

  function initSoportePage() {
    document.getElementById("support-wa-link").href = "https://wa.me/" + SUPPORT_PHONE
      + "?text=" + encodeURIComponent("Hola! Soy mayorista y necesito ayuda.");
  }

  // ─────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────

  async function init() {
    wireGlobalImgFallback();
    renderNav();
    initLoginForm();
    initClientsPage();
    initCuentasPage();
    initCreditosPage();
    initComprarPage();
    initRemindersPage();
    initSoportePage();

    try {
      const me = await api("/auth/me");
      if (me.authenticated) { await onAuthenticated(); return; }
    } catch { /* sin sesión — muestra el login */ }
    showAuth();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
