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
    showAuthCard("login-card");
  }

  function showApp() {
    document.getElementById("view-auth").hidden = true;
    document.getElementById("view-app").hidden = false;
  }

  function hideAllAuthCards() {
    ["login-card", "register-card", "guest-card", "guest-success-card"].forEach(id => {
      document.getElementById(id).hidden = true;
    });
  }

  function showAuthCard(id) {
    hideAllAuthCards();
    document.getElementById(id).hidden = false;
  }

  function initAuthToggle() {
    document.getElementById("show-register-btn").addEventListener("click", () => showAuthCard("register-card"));
    document.getElementById("show-login-btn").addEventListener("click", () => showAuthCard("login-card"));
    document.getElementById("show-guest-btn").addEventListener("click", () => showAuthCard("guest-card"));
    document.getElementById("show-login-from-guest-btn").addEventListener("click", () => showAuthCard("login-card"));
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
      const phone    = document.getElementById("login-phone").value.trim();
      const password = document.getElementById("login-password").value;
      try {
        await api("/auth/login", { method: "POST", body: { phone, password } });
        await onAuthenticated();
      } catch (err) {
        setFormError("login-error", err.message);
      }
    });

    document.getElementById("register-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      setFormError("register-error", "");
      const phone    = document.getElementById("register-phone").value.trim();
      const password = document.getElementById("register-password").value;
      try {
        await api("/auth/register", { method: "POST", body: { phone, password } });
        await onAuthenticated();
      } catch (err) {
        setFormError("register-error", err.message);
      }
    });

    document.getElementById("guest-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      setFormError("guest-error", "");
      const phone = document.getElementById("guest-phone").value.trim();
      try {
        const result = await api("/auth/guest", { method: "POST", body: { phone } });
        document.getElementById("guest-success-phone").textContent = result.phone;
        document.getElementById("guest-success-password").textContent = result.password;
        showAuthCard("guest-success-card");
      } catch (err) {
        setFormError("guest-error", err.message);
      }
    });

    document.getElementById("guest-continue-btn").addEventListener("click", onAuthenticated);

    document.getElementById("logout-btn").addEventListener("click", async () => {
      try { await api("/auth/logout", { method: "POST" }); } catch { /* no crítico */ }
      showAuth();
    });
  }

  let currentPhone = "";

  async function onAuthenticated() {
    showApp();
    try {
      const me = await api("/auth/me");
      currentPhone = me.phone || "";
    } catch { /* no crítico — el link de soporte queda sin el celular prellenado */ }
    await loadCatalog();
  }

  // ─────────────────────────────────────────────────────────────
  // NAV — Catálogo / Mis cuentas
  // ─────────────────────────────────────────────────────────────

  function initNav() {
    document.querySelectorAll(".nav-btn[data-view]").forEach(btn => {
      btn.addEventListener("click", () => switchPage(btn.dataset.view));
    });
    document.getElementById("topbar-support-link").href = "https://wa.me/" + SUPPORT_PHONE;
  }

  function switchPage(view) {
    document.querySelectorAll(".nav-btn[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === view));
    document.getElementById("page-catalog").hidden = view !== "catalog";
    document.getElementById("page-dashboard").hidden = view !== "dashboard";
    if (view === "dashboard") initDashboardRequestLink();
  }

  // ─────────────────────────────────────────────────────────────
  // CATÁLOGO
  // ─────────────────────────────────────────────────────────────

  let cachedCombos = [];
  let cachedProducts = [];

  function isAnnual(item) {
    const haystack = ((item.title || item.name || "") + " " + (item.keywords || "")).toLowerCase();
    return haystack.includes("anual");
  }

  function productDesc(p, kind) {
    return kind === "combo"
      ? p.items.map(i => i.quantity > 1 ? `${i.platform} x${i.quantity}` : i.platform).join("\n")
      : p.description;
  }

  // La descripción se carga como texto libre (a veces una línea por ítem,
  // ej. "✅ 1 Mes\n✅ Garantía y Soporte"). Si tiene más de una línea la
  // mostramos como lista; si es una sola, como párrafo normal.
  function renderDesc(el, desc) {
    // El precio ya se muestra aparte (footer/detalle) — si el texto lo
    // repite (ej. "PRECIO ➡ S/5.00"), se filtra para no mostrarlo 2 veces.
    const lines = (desc || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      .filter(l => !/precio/i.test(l) && !/S\/\s*\d/.test(l));
    el.hidden = lines.length === 0;
    if (lines.length > 1) {
      el.innerHTML = `<ul class="detail-list">${lines.map(l => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`;
    } else {
      el.textContent = lines[0] || "";
    }
  }

  // Datos del método de pago (ej. "Yape: 924173087\nTitular: Gustavo
  // Melendez") — una fila "etiqueta: valor" por línea, en vez de texto
  // corrido que colapsa los saltos de línea.
  function renderInfoRows(el, text) {
    // Puede venir con saltos de línea reales, o todo en una sola línea
    // separado por varios espacios (según cómo se haya tipeado en el
    // panel) — se parte por cualquiera de los dos casos.
    const lines = (text || "").split(/\r?\n|(?<=\S) {2,}(?=\S)/).map(l => l.trim()).filter(Boolean);
    el.hidden = lines.length === 0;
    el.innerHTML = lines.map(line => {
      const i = line.indexOf(":");
      if (i === -1) return `<div class="yape-info-row"><span class="yape-info-value">${escapeHtml(line)}</span></div>`;
      const label = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      return `<div class="yape-info-row"><span class="yape-info-label">${escapeHtml(label)}</span><span class="yape-info-value">${escapeHtml(value)}</span></div>`;
    }).join("");
  }

  function productImgHtml(p, kind) {
    const fallbackTag = (kind === "combo" ? "COMBO" : p.platform).slice(0, 3).toUpperCase();
    return p.imageUrl
      ? `<img src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<span class=\\'product-img-fallback\\'>${escapeHtml(fallbackTag)}</span>'">`
      : `<span class="product-img-fallback">${escapeHtml(fallbackTag)}</span>`;
  }

  function productCardHtml(p, kind) {
    const annual = isAnnual(p);
    const title  = kind === "combo" ? p.name : p.title;
    const detailAttr = kind === "combo" ? `data-detail-combo="${p.id}"` : `data-detail-platform="${escapeHtml(p.platform)}"`;

    return `
      <div class="product-card" ${detailAttr} role="button" tabindex="0">
        <div class="product-img-wrap">${productImgHtml(p, kind)}</div>
        <div class="product-body">
          <div class="product-title-row">
            <span class="product-title">${escapeHtml(title)}</span>
            ${annual ? '<span class="badge-annual">ANUAL</span>' : ""}
          </div>
        </div>
        <div class="product-price-banner">
          <span class="product-price">S/ ${escapeHtml(p.price)}</span>
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

      const sortedProducts = [...(products || [])].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
      cachedProducts = sortedProducts;

      let html = "";
      if (sortedProducts.length > 0) {
        html += `<div class="section-chip">Perfiles</div>`;
        html += `<div class="product-grid">${sortedProducts.map(p => productCardHtml(p, "platform")).join("")}</div>`;
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
      const card = e.target.closest("[data-detail-platform], [data-detail-combo]");
      if (!card) return;
      if (card.dataset.detailPlatform) openProductDetail({ kind: "platform", id: card.dataset.detailPlatform });
      else openProductDetail({ kind: "combo", id: Number(card.dataset.detailCombo) });
    });
    document.getElementById("catalog-sections").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target.closest("[data-detail-platform], [data-detail-combo]");
      if (!card) return;
      e.preventDefault();
      card.click();
    });
  }

  // ─────────────────────────────────────────────────────────────
  // DETALLE DE PRODUCTO — la tarjeta solo muestra lo esencial; la
  // descripción y el botón de comprar aparecen acá, al hacer click.
  // ─────────────────────────────────────────────────────────────

  function openProductDetail({ kind, id }) {
    const item = kind === "combo"
      ? cachedCombos.find(c => c.id === id)
      : cachedProducts.find(p => p.platform === id);
    if (!item) return;

    const title = kind === "combo" ? item.name : item.title;
    const desc  = productDesc(item, kind);

    document.getElementById("detail-img-wrap").innerHTML = productImgHtml(item, kind);
    document.getElementById("detail-title").textContent = title;
    document.getElementById("detail-annual").hidden = !isAnnual(item);
    renderDesc(document.getElementById("detail-desc"), desc);
    document.getElementById("detail-price").textContent = "S/ " + item.price;

    document.getElementById("detail-buy-btn").onclick = () => {
      closeProductDetail();
      startCheckout({ kind, id });
    };

    document.getElementById("product-detail-modal").hidden = false;
  }

  function closeProductDetail() {
    document.getElementById("product-detail-modal").hidden = true;
  }

  function initProductDetailModal() {
    document.getElementById("detail-close").addEventListener("click", closeProductDetail);
    document.getElementById("product-detail-modal").addEventListener("click", (e) => {
      if (e.target.id === "product-detail-modal") closeProductDetail();
    });
  }

  // ─────────────────────────────────────────────────────────────
  // MIS CUENTAS — en vez de listar automático (poco confiable para
  // compras viejas/hechas por WhatsApp antes de existir la web), el
  // cliente pide su historial por WhatsApp con su celular registrado
  // y el soporte se lo manda a mano. Las compras recién hechas ya se
  // muestran directo en el éxito del checkout (showCheckoutSuccess).
  // `cachedDashboard` lo sigue usando el checkout para detectar la
  // cuenta nueva por polling.
  // ─────────────────────────────────────────────────────────────

  let cachedDashboard = [];

  function initDashboardRequestLink() {
    const link = document.getElementById("dashboard-request-link");
    const msg = `Hola! Ya compré antes (celular ${currentPhone}) y quiero ver mi historial de cuentas. ¿Me ayudan?`;
    link.href = "https://wa.me/" + SUPPORT_PHONE + "?text=" + encodeURIComponent(msg);
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
      const beforeAccounts = cachedDashboard.length ? cachedDashboard : (await api("/dashboard")).accounts || [];
      const body = kind === "combo" ? { comboId: id } : { platform: id };
      const order = await api("/checkout", { method: "POST", body });

      await ensureYapeInfo();

      document.getElementById("checkout-amount").textContent = "S/ " + order.amount;
      const qrImg = document.getElementById("checkout-qr");
      if (cachedYapeQr) { qrImg.src = cachedYapeQr; qrImg.hidden = false; } else { qrImg.hidden = true; }
      renderInfoRows(document.getElementById("checkout-instructions"), cachedYapeText);
      document.getElementById("checkout-support-link").href = "https://wa.me/" + SUPPORT_PHONE
        + "?text=" + encodeURIComponent(`Hola, tengo dudas con mi pago de S/ ${order.amount} por Yape.`);
      document.getElementById("checkout-wrong-amount-link").href = "https://wa.me/" + SUPPORT_PHONE
        + "?text=" + encodeURIComponent(`Hola, envié un monto distinto al indicado (S/ ${order.amount}) por Yape. ¿Me ayudan?`);
      document.getElementById("checkout-waiting-text").textContent = "Esperando tu pago…";

      showCheckoutState("ready");
      startPolling(beforeAccounts, targetNewAccounts);
    } catch (err) {
      document.getElementById("checkout-error-text").textContent = err.message;
      showCheckoutState("error");
    }
  }

  // Identifica una cuenta sin depender de un id (la API no devuelve uno) —
  // la combinación plataforma+correo+perfil+vencimiento es única por fila.
  function accountKey(a) {
    return [a.platform, a.email, a.profileName, a.expiresAt].join("|");
  }

  function diffNewAccounts(before, after) {
    const beforeKeys = new Set(before.map(accountKey));
    return after.filter(a => !beforeKeys.has(accountKey(a)));
  }

  function startPolling(beforeAccounts, targetNewAccounts) {
    stopPolling();
    pollExpiry = Date.now() + POLL_TIMEOUT_MS;

    pollTimer = setInterval(async () => {
      try {
        const { accounts } = await api("/dashboard");
        cachedDashboard = accounts || [];
        if (cachedDashboard.length >= beforeAccounts.length + targetNewAccounts) {
          stopPolling();
          showCheckoutSuccess(diffNewAccounts(beforeAccounts, cachedDashboard));
          return;
        }
      } catch { /* red momentánea — sigue intentando */ }

      if (Date.now() > pollExpiry) {
        document.getElementById("checkout-waiting-text").textContent = "Seguimos esperando tu pago…";
      }
    }, POLL_MS);
  }

  function successAccountHtml(a, idx) {
    return `
      <div class="success-account-card">
        <div class="success-account-head">
          <span class="success-account-platform">${escapeHtml(a.platform)}</span>
          <button class="btn-secondary btn-sm success-copy-btn" data-idx="${idx}" type="button">📋 Copiar todo</button>
        </div>
        <div class="success-account-row"><b>Correo:</b> ${escapeHtml(a.email)}</div>
        <div class="success-account-row"><b>Contraseña:</b> ${escapeHtml(a.password)}</div>
        ${a.profileName ? `<div class="success-account-row"><b>Perfil:</b> ${escapeHtml(a.profileName)}</div>` : ""}
      </div>`;
  }

  function accountCopyText(a) {
    return `Manguitope — ${a.platform}\nCorreo: ${a.email}\nContraseña: ${a.password}` +
      (a.profileName ? `\nPerfil: ${a.profileName}` : "");
  }

  function showCheckoutSuccess(newAccounts) {
    const container = document.getElementById("checkout-success-accounts");
    container.innerHTML = newAccounts.map(successAccountHtml).join("");
    container.querySelectorAll(".success-copy-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(accountCopyText(newAccounts[Number(btn.dataset.idx)]));
          const original = btn.textContent;
          btn.textContent = "✅ Copiado";
          setTimeout(() => { btn.textContent = original; }, 1800);
        } catch {
          alert("No se pudo copiar. Copiá los datos manualmente.");
        }
      });
    });
    showCheckoutState("success");
  }

  function closeCheckout() {
    stopPolling();
    document.getElementById("checkout-modal").hidden = true;
  }

  function initCheckoutModal() {
    document.getElementById("checkout-close").addEventListener("click", closeCheckout);
    document.getElementById("checkout-retry").addEventListener("click", closeCheckout);
    document.getElementById("checkout-goto-dashboard").addEventListener("click", closeCheckout);
  }

  // ─────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────

  async function init() {
    initAuthToggle();
    initAuthForms();
    initNav();
    initCatalogClicks();
    initCheckoutModal();
    initProductDetailModal();

    try {
      const me = await api("/auth/me");
      if (me.authenticated) { await onAuthenticated(); return; }
    } catch { /* sin sesión — muestra el login */ }
    showAuth();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
