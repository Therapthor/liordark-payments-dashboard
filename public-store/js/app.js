(function () {
  "use strict";

  const API_BASE      = "/api/store";
  const SUPPORT_PHONE = "51963081436"; // wa.me — sin +, sin espacios
  const POLL_MS        = 4000;
  const POLL_TIMEOUT_MS = 3 * 60 * 1000;

  // ─────────────────────────────────────────────────────────────
  // HELPER — fetch con cookie de sesión de cliente
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
    if (!res.ok) throw new Error(data.message || "Ocurrió un error. Intenta de nuevo.");
    return data;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ─────────────────────────────────────────────────────────────
  // GATE — login / registro
  // ─────────────────────────────────────────────────────────────

  function showAuth() {
    document.getElementById("view-auth").hidden = false;
    document.getElementById("view-app").hidden = true;
  }

  function showApp() {
    document.getElementById("view-auth").hidden = true;
    document.getElementById("view-app").hidden = false;
  }

  function initAuthToggle() {
    document.getElementById("show-register-btn").addEventListener("click", () => {
      document.getElementById("login-card").hidden = true;
      document.getElementById("register-card").hidden = false;
    });
    document.getElementById("show-login-btn").addEventListener("click", () => {
      document.getElementById("register-card").hidden = true;
      document.getElementById("login-card").hidden = false;
    });
  }

  function setFormError(id, message) {
    const el = document.getElementById(id);
    if (!message) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = message;
    el.hidden = false;
  }

  function initAuthForms() {
    document.getElementById("login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      setFormError("login-error", "");
      const email    = document.getElementById("login-email").value.trim();
      const password = document.getElementById("login-password").value;
      try {
        await api("/auth/login", { method: "POST", body: { email, password } });
        await onAuthenticated();
      } catch (err) {
        setFormError("login-error", err.message);
      }
    });

    document.getElementById("register-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      setFormError("register-error", "");
      const email    = document.getElementById("register-email").value.trim();
      const phone    = document.getElementById("register-phone").value.trim();
      const password = document.getElementById("register-password").value;
      try {
        await api("/auth/register", { method: "POST", body: { email, phone, password } });
        await onAuthenticated();
      } catch (err) {
        setFormError("register-error", err.message);
      }
    });

    document.getElementById("logout-btn").addEventListener("click", async () => {
      try { await api("/auth/logout", { method: "POST" }); } catch { /* no crítico */ }
      showAuth();
    });
  }

  async function onAuthenticated() {
    showApp();
    await loadCatalog();
  }

  // ─────────────────────────────────────────────────────────────
  // NAV — Catálogo / Mis cuentas
  // ─────────────────────────────────────────────────────────────

  function initNav() {
    document.querySelectorAll(".nav-btn[data-view]").forEach(btn => {
      btn.addEventListener("click", () => switchPage(btn.dataset.view));
    });
  }

  function switchPage(view) {
    document.querySelectorAll(".nav-btn[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === view));
    document.getElementById("page-catalog").hidden = view !== "catalog";
    document.getElementById("page-dashboard").hidden = view !== "dashboard";
    if (view === "dashboard") loadDashboard();
  }

  // ─────────────────────────────────────────────────────────────
  // CATÁLOGO
  // ─────────────────────────────────────────────────────────────

  let cachedCombos = [];

  function isAnnual(item) {
    const haystack = ((item.title || item.name || "") + " " + (item.keywords || "")).toLowerCase();
    return haystack.includes("anual");
  }

  function productCardHtml(p, kind) {
    const annual = isAnnual(p);
    const title  = kind === "combo" ? p.name : p.title;
    const desc   = kind === "combo"
      ? p.items.map(i => i.platform).join(" + ")
      : p.description;
    const buyAttr = kind === "combo" ? `data-combo="${p.id}"` : `data-platform="${escapeHtml(p.platform)}"`;
    const img = p.imageUrl
      ? `<img src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<span class=\\'product-img-fallback\\'>${escapeHtml((kind === "combo" ? "COMBO" : p.platform).slice(0,3).toUpperCase())}</span>'">`
      : `<span class="product-img-fallback">${escapeHtml((kind === "combo" ? "COMBO" : p.platform).slice(0, 3).toUpperCase())}</span>`;

    return `
      <div class="product-card">
        <div class="product-img-wrap">${img}</div>
        <div class="product-body">
          <div class="product-title-row">
            <span class="product-title">${escapeHtml(title)}</span>
            ${annual ? '<span class="badge-annual">ANUAL</span>' : ""}
          </div>
          <p class="product-desc">${escapeHtml(desc)}</p>
          <div class="product-footer">
            <span class="product-price">S/ ${escapeHtml(p.price)}</span>
            <button class="btn-primary btn-sm" ${buyAttr}>Comprar</button>
          </div>
        </div>
      </div>`;
  }

  async function loadCatalog() {
    const container = document.getElementById("catalog-sections");
    const empty     = document.getElementById("catalog-empty");
    try {
      const { products, combos } = await api("/catalog");
      cachedCombos = combos || [];

      if ((!products || products.length === 0) && (!combos || combos.length === 0)) {
        container.innerHTML = "";
        empty.hidden = false;
        return;
      }
      empty.hidden = true;

      const byPlatform = new Map();
      for (const p of products) {
        const list = byPlatform.get(p.platform) || [];
        list.push(p);
        byPlatform.set(p.platform, list);
      }

      let html = "";
      for (const [platform, items] of byPlatform) {
        html += `<div class="section-chip">${escapeHtml(platform)}</div>`;
        html += `<div class="product-grid">${items.map(p => productCardHtml(p, "platform")).join("")}</div>`;
      }
      if (combos && combos.length > 0) {
        html += `<div class="section-chip">Combos</div>`;
        html += `<div class="product-grid">${combos.map(c => productCardHtml(c, "combo")).join("")}</div>`;
      }
      container.innerHTML = html;

      // Animación escalonada de entrada
      container.querySelectorAll(".product-card").forEach((card, i) => {
        card.style.animationDelay = Math.min(i * 40, 400) + "ms";
      });
    } catch (err) {
      container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function initCatalogClicks() {
    document.getElementById("catalog-sections").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-platform], [data-combo]");
      if (!btn) return;
      if (btn.dataset.platform) startCheckout({ kind: "platform", id: btn.dataset.platform });
      else startCheckout({ kind: "combo", id: Number(btn.dataset.combo) });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // MIS CUENTAS
  // ─────────────────────────────────────────────────────────────

  let cachedDashboard = [];

  function daysLabel(days) {
    if (days == null) return { text: "—", cls: "ok" };
    if (days < 0) return { text: Math.abs(days) + "d vencido", cls: "over" };
    if (days === 0) return { text: "Vence hoy", cls: "soon" };
    if (days <= 5) return { text: days + "d restantes", cls: "soon" };
    return { text: days + "d restantes", cls: "ok" };
  }

  function accountCardHtml(a, idx) {
    const d = daysLabel(a.daysLeft);
    const soon = a.daysLeft != null && a.daysLeft <= 5;
    return `
      <div class="account-card" style="animation-delay:${Math.min(idx * 40, 300)}ms">
        <div class="account-platform">${escapeHtml(a.platform)}</div>
        <div class="account-details">
          <div class="account-reveal" data-idx="${idx}">Ver credenciales</div>
          <div class="account-creds" data-idx="${idx}" hidden>
            <div><b>Correo:</b> ${escapeHtml(a.email)}</div>
            <div><b>Contraseña:</b> ${escapeHtml(a.password)}</div>
            ${a.profileName ? `<div><b>Perfil:</b> ${escapeHtml(a.profileName)}</div>` : ""}
          </div>
          ${soon ? `<div class="account-renew-hint"><a href="https://wa.me/${SUPPORT_PHONE}" target="_blank" rel="noopener">Vence pronto — escribinos para renovar</a></div>` : ""}
        </div>
        <span class="account-days ${d.cls}">${d.text}</span>
      </div>`;
  }

  async function loadDashboard() {
    const list  = document.getElementById("dashboard-list");
    const empty = document.getElementById("dashboard-empty");
    try {
      const { accounts } = await api("/dashboard");
      cachedDashboard = accounts || [];
      if (cachedDashboard.length === 0) {
        list.innerHTML = "";
        empty.hidden = false;
        return;
      }
      empty.hidden = true;
      list.innerHTML = cachedDashboard.map(accountCardHtml).join("");
    } catch (err) {
      list.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function initDashboardClicks() {
    document.getElementById("dashboard-list").addEventListener("click", (e) => {
      const reveal = e.target.closest(".account-reveal");
      if (!reveal) return;
      const creds = document.querySelector(`.account-creds[data-idx="${reveal.dataset.idx}"]`);
      if (creds) creds.hidden = !creds.hidden;
      reveal.textContent = creds && !creds.hidden ? "Ocultar credenciales" : "Ver credenciales";
    });
  }

  // ─────────────────────────────────────────────────────────────
  // CHECKOUT — reserva el monto, muestra el QR, espera el pago
  // ─────────────────────────────────────────────────────────────

  let pollTimer  = null;
  let pollExpiry = null;
  let cachedYapeQr = null;
  let cachedYapeText = "";

  function showCheckoutState(state) {
    ["loading", "ready", "success", "error"].forEach(s => {
      document.getElementById("checkout-" + s).hidden = s !== state;
    });
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function ensureYapeInfo() {
    if (cachedYapeQr !== null) return;
    try {
      const { methods } = await api("/payment-methods");
      const yape = (methods || []).find(m => m.name.toLowerCase().includes("yape"));
      cachedYapeQr   = yape && yape.imageUrl ? yape.imageUrl : "";
      cachedYapeText = yape ? yape.description : "";
    } catch {
      cachedYapeQr = "";
    }
  }

  async function startCheckout({ kind, id }) {
    const modal = document.getElementById("checkout-modal");
    modal.hidden = false;
    showCheckoutState("loading");

    let targetNewAccounts = 1;
    if (kind === "combo") {
      const combo = cachedCombos.find(c => c.id === id);
      targetNewAccounts = combo ? combo.items.length : 1;
    }

    try {
      const beforeCount = cachedDashboard.length || (await api("/dashboard")).accounts.length;
      const body = kind === "combo" ? { comboId: id } : { platform: id };
      const order = await api("/checkout", { method: "POST", body });

      await ensureYapeInfo();

      document.getElementById("checkout-amount").textContent = "S/ " + order.amount;
      const qrImg = document.getElementById("checkout-qr");
      if (cachedYapeQr) { qrImg.src = cachedYapeQr; qrImg.hidden = false; } else { qrImg.hidden = true; }
      document.getElementById("checkout-instructions").textContent = cachedYapeText || "";
      document.getElementById("checkout-support-hint").hidden = true;
      document.getElementById("checkout-support-link").href = "https://wa.me/" + SUPPORT_PHONE;
      document.getElementById("checkout-waiting-text").textContent = "Esperando tu pago…";

      showCheckoutState("ready");
      startPolling(beforeCount, targetNewAccounts);
    } catch (err) {
      document.getElementById("checkout-error-text").textContent = err.message;
      showCheckoutState("error");
    }
  }

  function startPolling(beforeCount, targetNewAccounts) {
    stopPolling();
    pollExpiry = Date.now() + POLL_TIMEOUT_MS;

    pollTimer = setInterval(async () => {
      try {
        const { accounts } = await api("/dashboard");
        cachedDashboard = accounts || [];
        if (cachedDashboard.length >= beforeCount + targetNewAccounts) {
          stopPolling();
          showCheckoutState("success");
          return;
        }
      } catch { /* red momentánea — sigue intentando */ }

      if (Date.now() > pollExpiry) {
        document.getElementById("checkout-support-hint").hidden = false;
        document.getElementById("checkout-waiting-text").textContent = "Seguimos esperando tu pago…";
      }
    }, POLL_MS);
  }

  function closeCheckout() {
    stopPolling();
    document.getElementById("checkout-modal").hidden = true;
  }

  function initCheckoutModal() {
    document.getElementById("checkout-close").addEventListener("click", closeCheckout);
    document.getElementById("checkout-retry").addEventListener("click", closeCheckout);
    document.getElementById("checkout-goto-dashboard").addEventListener("click", () => {
      closeCheckout();
      switchPage("dashboard");
      loadDashboard();
    });
  }

  // ─────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────

  async function init() {
    initAuthToggle();
    initAuthForms();
    initNav();
    initCatalogClicks();
    initDashboardClicks();
    initCheckoutModal();

    try {
      const me = await api("/auth/me");
      if (me.authenticated) { await onAuthenticated(); return; }
    } catch { /* sin sesión — muestra el login */ }
    showAuth();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
