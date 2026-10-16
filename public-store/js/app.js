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
    showAuthCard("start-card");
  }

  function showApp() {
    document.getElementById("view-auth").hidden = true;
    document.getElementById("view-app").hidden = false;
  }

  function hideAllAuthCards() {
    ["start-card", "login-card", "guest-card"].forEach(id => {
      document.getElementById(id).hidden = true;
    });
  }

  function showAuthCard(id) {
    hideAllAuthCards();
    document.getElementById(id).hidden = false;
  }

  function initAuthToggle() {
    document.getElementById("show-login-btn").addEventListener("click", () => showAuthCard("login-card"));
    document.getElementById("show-guest-btn").addEventListener("click", () => showAuthCard("guest-card"));
    document.getElementById("back-to-start-from-login").addEventListener("click", () => showAuthCard("start-card"));
    document.getElementById("back-to-start-from-guest").addEventListener("click", () => showAuthCard("start-card"));
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

    document.getElementById("guest-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      setFormError("guest-error", "");
      const phone = document.getElementById("guest-phone").value.trim();
      const pin   = document.getElementById("guest-pin").value;
      if (!/^\d{4}$/.test(pin)) {
        setFormError("guest-error", "El PIN debe ser de 4 dígitos.");
        return;
      }
      try {
        await api("/auth/guest", { method: "POST", body: { phone, password: pin } });
        await onAuthenticated();
      } catch (err) {
        setFormError("guest-error", err.message);
      }
    });

    document.getElementById("logout-btn").addEventListener("click", async () => {
      try { await api("/auth/logout", { method: "POST" }); } catch { /* no crítico */ }
      stopNotifPolling();
      showAuth();
    });
  }

  let currentPhone = "";

  async function onAuthenticated() {
    showApp();
    try {
      const me = await api("/auth/me");
      currentPhone = me.phone || "";
      // Códigos — apagado por ahora (el reenvío de Gmail resultó más
      // complicado de lo esperado); el botón queda oculto para todos.
    } catch { /* no crítico — el link de soporte queda sin el celular prellenado */ }
    startNotifPolling();
    await loadCatalog();
  }

  // ─────────────────────────────────────────────────────────────
  // NOTIFICACIONES — campanita del topbar. Solo dos eventos: cuenta
  // nueva asignada o cuenta renovada (ver customer-notifications.repository
  // en el backend). Polling simple, mismo patrón que el resto de la app.
  // ─────────────────────────────────────────────────────────────

  const NOTIF_POLL_MS = 20000;
  let notifPollTimer = null;

  // created_at sale de SQLite como "YYYY-MM-DD HH:MM:SS" en UTC, sin
  // zona — hay que marcarlo como tal para que no se interprete como hora
  // local del navegador.
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
      el.innerHTML = '<div class="notif-empty">No tienes notificaciones todavía.</div>';
      return;
    }
    el.innerHTML = list.map(n => `
      <div class="notif-item${n.readAt ? "" : " notif-item-unread"}" data-platform="${escapeHtml(n.platform)}" data-email="${escapeHtml(n.accountEmail || "")}">
        <div class="notif-item-msg">${escapeHtml(n.message)}</div>
        <div class="notif-item-time">${timeAgo(n.createdAt)}</div>
      </div>
    `).join("");
  }

  // Al tocar una notificación — lleva a "Mis cuentas" y resalta la
  // tarjeta exacta unos segundos (mismo criterio platform+email que ya
  // usa accountKey() para identificar cuentas sin id).
  let pendingHighlight = null;

  function applyPendingHighlight() {
    if (!pendingHighlight) return;
    const { platform, email } = pendingHighlight;
    pendingHighlight = null;

    const cards = [...document.querySelectorAll("#dashboard-active-list .success-account-card")];
    const card = cards.find(c => c.dataset.platform === platform && c.dataset.email === email)
      || cards.find(c => c.dataset.platform === platform);
    if (!card) return;

    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("success-account-card-highlight");
    void card.offsetWidth; // reinicia la animación si ya se había resaltado antes
    card.classList.add("success-account-card-highlight");
    setTimeout(() => card.classList.remove("success-account-card-highlight"), 2400);
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
    document.getElementById("notif-list").addEventListener("click", (e) => {
      const item = e.target.closest(".notif-item");
      if (!item || !item.dataset.platform) return;
      closeNotifPanel();
      pendingHighlight = { platform: item.dataset.platform, email: item.dataset.email };
      switchPage("dashboard");
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
    document.getElementById("page-codes").hidden = view !== "codes";
    if (view === "dashboard") { initDashboardRequestLink(); loadDashboardAccounts(); }
    if (view === "codes") loadCodesAccounts();
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

  // Plataformas de activación manual (CANVA, GEMINI AI PRO, YOUTUBE
  // PREMIUM) — se activan a mano, nunca con stock de perfiles. Van
  // siempre en la sección "Exclusivos" aunque no sean anuales (ej. Gemini
  // es mensual) — por eso esta sección ya no se basa solo en isAnnual.
  function isManualActivationPlatform(platform) {
    return /canva|gemini|youtube/i.test(platform || "");
  }

  // YOUTUBE PREMIUM se activa sobre la cuenta propia del cliente — a
  // diferencia de Canva/Gemini (solo correo, invitación), necesita
  // también la contraseña para poder entrar y activar el plan.
  function requiresPasswordPlatform(platform) {
    return /youtube/i.test(platform || "");
  }

  // YOUTUBE PREMIUM no es renovable — cada ciclo es una compra nueva, así
  // que en "Mis cuentas" no se ofrece "Renovar", se avisa con una etiqueta.
  function isNonRenewablePlatform(platform) {
    return /youtube/i.test(platform || "");
  }

  function isExclusive(item, kind) {
    return isAnnual(item) || (kind === "platform" && isManualActivationPlatform(item.platform));
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
      const label = i === -1 ? "" : line.slice(0, i).trim();
      const value = i === -1 ? line : line.slice(i + 1).trim();
      const copyBtn = `<button class="yape-copy-btn" type="button" data-copy="${escapeHtml(value)}" aria-label="Copiar" title="Copiar">📋</button>`;
      return `<div class="yape-info-row">${label ? `<span class="yape-info-label">${escapeHtml(label)}</span>` : ""}<span class="yape-info-value">${escapeHtml(value)}</span>${copyBtn}</div>`;
    }).join("");
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

  function initYapeCopyButtons() {
    document.getElementById("checkout-instructions").addEventListener("click", handleYapeCopyClick);
    document.getElementById("checkout-amount-copy").addEventListener("click", handleYapeCopyClick);
  }

  function productImgHtml(p, kind) {
    const fallbackTag = (kind === "combo" ? "COMBO" : p.platform).slice(0, 3).toUpperCase();
    return p.imageUrl
      ? `<img src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<span class=\\'product-img-fallback\\'>${escapeHtml(fallbackTag)}</span>'">`
      : `<span class="product-img-fallback">${escapeHtml(fallbackTag)}</span>`;
  }

  function isOutOfStock(p, kind) {
    return kind === "combo" ? p.inStock === false : (p.available ?? 0) <= 0;
  }

  // Precio como píldora flotante bajo el nombre, sin botón propio: toda
  // la card es clicable (role=button) y abre el mismo modal de detalle,
  // que ya trae su botón Comprar/Reservar listo. Lo único que diferencia
  // Exclusivos de Perfiles es la etiqueta flotando sobre la foto.
  function productCardHtml(p, kind, opts) {
    const annual     = isAnnual(p);
    const exclusive  = !!(opts && opts.exclusive);
    const outOfStock = isOutOfStock(p, kind);
    const title      = kind === "combo" ? p.name : p.title;
    const detailAttr = kind === "combo" ? `data-detail-combo="${p.id}"` : `data-detail-platform="${escapeHtml(p.platform)}"`;
    const cardClass  = [exclusive && "product-card-exclusive", outOfStock && "product-card-outofstock"].filter(Boolean).join(" ");
    const overlayBadge = exclusive
      ? '<span class="product-badge-overlay badge-exclusive">★ EXCLUSIVO</span>'
      : (annual ? '<span class="product-badge-overlay badge-annual">ANUAL</span>' : "");

    return `
      <div class="product-card${cardClass ? " " + cardClass : ""}" ${detailAttr} role="button" tabindex="0">
        <div class="product-img-wrap">
          ${productImgHtml(p, kind)}
          ${overlayBadge}
        </div>
        <div class="product-body product-body-pill">
          <span class="product-title">${escapeHtml(title)}</span>
          ${outOfStock ? '<span class="product-reserve-tag-sm">Reservar</span>' : ""}
          <div class="product-price-pill${outOfStock ? " product-price-pill-reserve" : ""}">
            <span class="product-price-pill-currency">S/</span><span class="product-price-pill-amount">${escapeHtml(p.price)}</span>
          </div>
        </div>
      </div>`;
  }

  async function loadCatalog() {
    const container = document.getElementById("catalog-sections");
    const empty     = document.getElementById("catalog-empty");
    try {
      const { products } = await api("/catalog");

      if (!products || products.length === 0) {
        container.innerHTML = "";
        empty.hidden = false;
        return;
      }
      empty.hidden = true;

      const sortedProducts = [...(products || [])].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
      cachedProducts = sortedProducts;

      let html = "";
      // Los combos fijos del catálogo ya no se muestran en la web — el
      // cliente arma el suyo con "¿Quieres armar tu combo?", arriba de
      // todo para que se note antes de ver el catálogo normal.
      if (sortedProducts.filter(p => !isOutOfStock(p, "platform")).length >= MIN_CUSTOM_COMBO_ITEMS) {
        html += buildComboPromptHtml();
      }
      const exclusiveProducts = sortedProducts.filter(p => isExclusive(p, "platform"));
      const regularProducts   = sortedProducts.filter(p => !isExclusive(p, "platform"));
      if (exclusiveProducts.length > 0) {
        html += `<div class="section-chip section-chip-exclusive">✨ Exclusivos ✨</div>`;
        html += `<div class="product-grid product-grid-exclusive">${exclusiveProducts.map(p => productCardHtml(p, "platform", { exclusive: true })).join("")}</div>`;
      }
      if (regularProducts.length > 0) {
        html += `<div class="section-chip">Perfiles</div>`;
        html += `<div class="product-grid">${regularProducts.map(p => productCardHtml(p, "platform")).join("")}</div>`;
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
      if (e.target.closest("#build-combo-btn")) { openComboBuilder(); return; }
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
  // ARMA TU COMBO — carrito interactivo: el cliente elige 2 o más
  // productos sueltos y arma su propio combo con descuento por cantidad
  // (2 = 5%, 3+ = 15%). El precio final SIEMPRE lo recalcula el servidor
  // en /checkout — acá solo se muestra una vista previa.
  // ─────────────────────────────────────────────────────────────

  const MIN_CUSTOM_COMBO_ITEMS = 2;
  let comboBuilderCart = []; // platforms elegidas, sin repetir

  function buildComboPromptHtml() {
    return `
      <div class="build-combo-prompt">
        <p class="build-combo-prompt-text">¿Quieres armar tu combo? ¡Hazlo!</p>
        <button class="btn-primary" id="build-combo-btn" type="button">🛒 Armar combo</button>
      </div>
    `;
  }

  function comboDiscountRate(count) {
    if (count >= 3) return 0.15;
    if (count === 2) return 0.05;
    return 0;
  }

  function comboBuilderSelection() {
    const items = comboBuilderCart
      .map(platform => cachedProducts.find(p => p.platform === platform))
      .filter(Boolean);
    const sum  = items.reduce((s, p) => s + parseFloat(p.price), 0);
    const rate = comboDiscountRate(items.length);
    const total = sum * (1 - rate);
    return { items, sum, rate, total };
  }

  function renderComboBuilderCatalog() {
    const container = document.getElementById("build-combo-catalog");
    const inStock = cachedProducts.filter(p => !isOutOfStock(p, "platform"));
    container.innerHTML = inStock.map(p => {
      const added = comboBuilderCart.includes(p.platform);
      return `
        <div class="build-combo-item">
          <span class="build-combo-item-name">${escapeHtml(p.title)}</span>
          <span class="build-combo-item-price">S/ ${escapeHtml(p.price)}</span>
          <button class="btn-secondary btn-sm build-combo-add-btn" data-platform="${escapeHtml(p.platform)}" type="button" ${added ? "disabled" : ""}>
            ${added ? "✓ Agregado" : "+ Agregar"}
          </button>
        </div>
      `;
    }).join("");
  }

  function renderComboBuilderCart() {
    const list  = document.getElementById("build-combo-cart-list");
    const empty = document.getElementById("build-combo-cart-empty");
    const discountLabel = document.getElementById("build-combo-discount-label");
    const totalEl        = document.getElementById("build-combo-total");
    const buyBtn          = document.getElementById("build-combo-buy-btn");
    const { items, rate, total } = comboBuilderSelection();

    if (items.length === 0) {
      list.innerHTML = "";
      empty.hidden = false;
    } else {
      empty.hidden = true;
      list.innerHTML = items.map(p => `
        <div class="build-combo-cart-row">
          <span>${escapeHtml(p.title)}</span>
          <span>S/ ${escapeHtml(p.price)}</span>
          <button class="build-combo-remove-btn" data-platform="${escapeHtml(p.platform)}" type="button" aria-label="Quitar">✕</button>
        </div>
      `).join("");
    }

    if (items.length === 0) {
      discountLabel.textContent = "";
      totalEl.textContent = "";
    } else if (items.length < MIN_CUSTOM_COMBO_ITEMS) {
      discountLabel.textContent = "Agrega 1 más para desbloquear 5% dcto";
      totalEl.textContent = "S/ " + total.toFixed(2);
    } else if (rate < 0.15) {
      discountLabel.textContent = "5% de descuento — agrega 1 más para 15%";
      totalEl.textContent = "S/ " + total.toFixed(2);
    } else {
      discountLabel.textContent = "🎉 15% de descuento aplicado";
      totalEl.textContent = "S/ " + total.toFixed(2);
    }

    buyBtn.disabled = items.length < MIN_CUSTOM_COMBO_ITEMS;
    renderComboBuilderCatalog();
  }

  function openComboBuilder() {
    comboBuilderCart = [];
    document.getElementById("build-combo-error").hidden = true;
    renderComboBuilderCart();
    document.getElementById("build-combo-modal").hidden = false;
  }

  function closeComboBuilder() {
    document.getElementById("build-combo-modal").hidden = true;
  }

  async function startCustomComboCheckout(platforms) {
    const modal = document.getElementById("checkout-modal");
    modal.hidden = false;
    showCheckoutState("loading");

    try {
      const beforeAccounts = cachedDashboard.length ? cachedDashboard : (await api("/dashboard")).accounts || [];
      const order = await api("/checkout", { method: "POST", body: { customComboPlatforms: platforms } });

      await ensureYapeInfo();
      document.getElementById("checkout-amount").textContent = "S/ " + order.amount;
      document.getElementById("checkout-amount-copy").dataset.copy = order.amount;
      const qrImg = document.getElementById("checkout-qr");
      if (cachedYapeQr) { qrImg.src = cachedYapeQr; qrImg.hidden = false; } else { qrImg.hidden = true; }
      renderInfoRows(document.getElementById("checkout-instructions"), cachedYapeText);
      document.getElementById("checkout-support-link").href = "https://wa.me/" + SUPPORT_PHONE
        + "?text=" + encodeURIComponent(`Hola, tengo dudas con mi pago de S/ ${order.amount} por Yape.`);
      document.getElementById("checkout-wrong-amount-link").href = "https://wa.me/" + SUPPORT_PHONE
        + "?text=" + encodeURIComponent(`Hola, envié un monto distinto al indicado (S/ ${order.amount}) por Yape. ¿Me ayudan?`);
      document.getElementById("checkout-waiting-text").textContent = "Esperando tu pago…";

      showCheckoutState("ready");
      startPolling(beforeAccounts, platforms.length);
    } catch (err) {
      document.getElementById("checkout-error-text").textContent = err.message;
      showCheckoutState("error");
    }
  }

  function initComboBuilder() {
    document.getElementById("build-combo-close").addEventListener("click", closeComboBuilder);

    document.getElementById("build-combo-catalog").addEventListener("click", (e) => {
      const btn = e.target.closest(".build-combo-add-btn");
      if (!btn || btn.disabled) return;
      const platform = btn.dataset.platform;
      if (!comboBuilderCart.includes(platform)) comboBuilderCart.push(platform);
      renderComboBuilderCart();
    });

    document.getElementById("build-combo-cart-list").addEventListener("click", (e) => {
      const btn = e.target.closest(".build-combo-remove-btn");
      if (!btn) return;
      comboBuilderCart = comboBuilderCart.filter(p => p !== btn.dataset.platform);
      renderComboBuilderCart();
    });

    document.getElementById("build-combo-buy-btn").addEventListener("click", () => {
      if (comboBuilderCart.length < MIN_CUSTOM_COMBO_ITEMS) return;
      const platforms = [...comboBuilderCart];
      closeComboBuilder();
      startCustomComboCheckout(platforms);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // DETALLE DE PRODUCTO — la tarjeta solo muestra lo esencial; la
  // descripción y el botón de comprar aparecen acá, al hacer click.
  // ─────────────────────────────────────────────────────────────

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function openProductDetail({ kind, id }) {
    const item = kind === "combo"
      ? cachedCombos.find(c => c.id === id)
      : cachedProducts.find(p => p.platform === id);
    if (!item) return;

    const title = kind === "combo" ? item.name : item.title;
    const desc  = productDesc(item, kind);
    const needsCanvaEmail = kind === "platform" && isManualActivationPlatform(item.platform);
    const needsPassword   = kind === "platform" && requiresPasswordPlatform(item.platform);
    const outOfStock = isOutOfStock(item, kind);

    document.getElementById("detail-img-wrap").innerHTML = productImgHtml(item, kind);
    document.getElementById("detail-title").textContent = title;
    document.getElementById("detail-annual").hidden = !isAnnual(item);
    renderDesc(document.getElementById("detail-desc"), desc);
    document.getElementById("detail-price").textContent = "S/ " + item.price;

    document.getElementById("detail-canva-email").hidden = !needsCanvaEmail;
    document.getElementById("detail-canva-email-input").value = "";
    setFormError("detail-canva-email-error", "");

    document.getElementById("detail-canva-password").hidden = !needsPassword;
    document.getElementById("detail-canva-password-input").value = "";
    setFormError("detail-canva-password-error", "");

    // Sin stock: se puede pagar igual para reservar — el pedido queda
    // pendiente y se entrega automático apenas el admin cargue stock
    // nuevo de esa plataforma (el bot revisa cada pocos minutos).
    document.getElementById("detail-reserve-note").hidden = !outOfStock;

    const buyBtn = document.getElementById("detail-buy-btn");
    buyBtn.disabled = false;
    buyBtn.textContent = outOfStock ? "Reservar" : "Comprar";
    buyBtn.onclick = () => {
      let clientEmail;
      let clientPassword;
      if (needsCanvaEmail) {
        clientEmail = document.getElementById("detail-canva-email-input").value.trim();
        if (!isValidEmail(clientEmail)) {
          setFormError("detail-canva-email-error", "Escribe un correo válido para activar " + item.platform + ".");
          return;
        }
      }
      if (needsPassword) {
        clientPassword = document.getElementById("detail-canva-password-input").value;
        if (!clientPassword.trim()) {
          setFormError("detail-canva-password-error", "Escribe la contraseña de esa cuenta.");
          return;
        }
      }
      closeProductDetail();
      startCheckout({ kind, id, clientEmail, clientPassword });
    };

    document.getElementById("product-detail-modal").hidden = false;
  }

  function closeProductDetail() {
    const modal = document.getElementById("product-detail-modal");
    modal.classList.add("closing");
    setTimeout(() => {
      modal.hidden = true;
      modal.classList.remove("closing");
    }, 180);
  }

  function initProductDetailModal() {
    document.getElementById("detail-close").addEventListener("click", closeProductDetail);
    document.getElementById("product-detail-modal").addEventListener("click", (e) => {
      if (e.target.id === "product-detail-modal") closeProductDetail();
    });
  }

  // ─────────────────────────────────────────────────────────────
  // MIS CUENTAS — activas (con credenciales, para poder entrar) y
  // vencidas (solo correo, sin contraseña — ya no sirven para entrar,
  // es puro registro). El link de WhatsApp queda como respaldo por si
  // algo no calzó por teléfono (ej. compró con otro número).
  // `cachedDashboard` también lo usa el checkout para detectar la
  // cuenta nueva por polling.
  // ─────────────────────────────────────────────────────────────

  let cachedDashboard = [];

  function initDashboardRequestLink() {
    const link = document.getElementById("dashboard-request-link");
    const msg = `Hola! Ya compré antes (celular ${currentPhone}) y quiero ver mi historial de cuentas. ¿Me ayudan?`;
    link.href = "https://wa.me/" + SUPPORT_PHONE + "?text=" + encodeURIComponent(msg);
  }

  function expiredAccountCardHtml(a) {
    return `
      <div class="renewal-account-card">
        <div class="renewal-account-head">
          <span class="renewal-account-platform">${escapeHtml(a.platform)}</span>
          <span class="renewal-account-status">Venció${a.expiresAt ? ": " + escapeHtml(a.expiresAt) : ""}</span>
        </div>
        <div class="renewal-account-email">${escapeHtml(a.email)}</div>
        ${a.profileName ? `<div class="muted small">Perfil: ${escapeHtml(a.profileName)}</div>` : ""}
      </div>
    `;
  }

  async function loadDashboardAccounts() {
    const activeList  = document.getElementById("dashboard-active-list");
    const activeEmpty = document.getElementById("dashboard-active-empty");
    const expiredSection = document.getElementById("dashboard-expired-section");
    const expiredList = document.getElementById("dashboard-expired-list");

    try {
      const { accounts, expiredAccounts } = await api("/dashboard");
      cachedDashboard = accounts || [];

      if (cachedDashboard.length === 0) {
        activeList.innerHTML = "";
        activeEmpty.hidden = false;
      } else {
        activeEmpty.hidden = true;
        activeList.innerHTML = cachedDashboard.map(successAccountHtml).join("");
        wireSuccessCopyButtons(activeList, cachedDashboard);
      }

      if (expiredAccounts && expiredAccounts.length > 0) {
        expiredSection.hidden = false;
        expiredList.innerHTML = expiredAccounts.map(expiredAccountCardHtml).join("");
      } else {
        expiredSection.hidden = true;
      }

      applyPendingHighlight();
    } catch { /* se deja lo último mostrado — el link de WhatsApp sigue de respaldo */ }
  }

  // ─────────────────────────────────────────────────────────────
  // RENOVACIONES — ahora solo desde Mis cuentas, por sesión (ya no hay
  // lookup público por celular). El botón de "Renovar" en cada cuenta
  // activa solo aparece con 1 día o menos para vencer (ver
  // successAccountHtml / initDashboardRenewals, arriba).
  // ─────────────────────────────────────────────────────────────

  function renewalStatusText(daysLeft) {
    if (daysLeft === null || daysLeft === undefined) return "";
    if (daysLeft < 0)  return `Venció hace ${Math.abs(daysLeft)} día(s)`;
    if (daysLeft === 0) return "Vence hoy";
    return `Vence en ${daysLeft} día(s)`;
  }

  async function startRenewalCheckout(platform, clientEmail, clientPassword) {
    const modal = document.getElementById("checkout-modal");
    modal.hidden = false;
    showCheckoutState("loading");

    try {
      const order = await api("/renewals/checkout", {
        method: "POST",
        body: { phone: currentPhone, platform, clientEmail, clientPassword },
      });
      await ensureYapeInfo();

      document.getElementById("checkout-amount").textContent = "S/ " + order.amount;
      document.getElementById("checkout-amount-copy").dataset.copy = order.amount;
      const qrImg = document.getElementById("checkout-qr");
      if (cachedYapeQr) { qrImg.src = cachedYapeQr; qrImg.hidden = false; } else { qrImg.hidden = true; }
      renderInfoRows(document.getElementById("checkout-instructions"), cachedYapeText);
      document.getElementById("checkout-support-link").href = "https://wa.me/" + SUPPORT_PHONE
        + "?text=" + encodeURIComponent(`Hola, tengo dudas con mi pago de renovación de S/ ${order.amount} por Yape.`);
      document.getElementById("checkout-wrong-amount-link").href = "https://wa.me/" + SUPPORT_PHONE
        + "?text=" + encodeURIComponent(`Hola, envié un monto distinto al indicado (S/ ${order.amount}) por una renovación. ¿Me ayudan?`);

      // Las renovaciones SIEMPRE se aprueban a mano (nunca automático,
      // aunque Yape detecte el pago al instante) — no hay nada que
      // "pollear": se le avisa que espere el mensaje de confirmación.
      document.getElementById("checkout-waiting-text").textContent =
        "En cuanto confirmemos tu pago, tu renovación queda pendiente de aprobación final — te avisamos por WhatsApp.";

      showCheckoutState("ready");
    } catch (err) {
      document.getElementById("checkout-error-text").textContent = err.message;
      showCheckoutState("error");
    }
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

  async function startCheckout({ kind, id, clientEmail, clientPassword }) {
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
      const body = kind === "combo" ? { comboId: id } : { platform: id, clientEmail, clientPassword };
      const order = await api("/checkout", { method: "POST", body });

      await ensureYapeInfo();

      document.getElementById("checkout-amount").textContent = "S/ " + order.amount;
      document.getElementById("checkout-amount-copy").dataset.copy = order.amount;
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
    // Renovar solo aparece acá cuando falta 1 día o menos (o ya venció pero
    // sigue activa) — antes no tiene sentido ofrecerlo.
    const canRenew = a.daysLeft !== null && a.daysLeft !== undefined && a.daysLeft <= 1;
    const nonRenewable = isNonRenewablePlatform(a.platform);
    const needsCanvaEmail = canRenew && !nonRenewable && isManualActivationPlatform(a.platform);
    const needsRenewPassword = canRenew && !nonRenewable && requiresPasswordPlatform(a.platform);
    // Siempre visible — antes solo se mostraba el vencimiento cuando faltaba
    // 1 día o menos (dentro del cuadro de Renovar), así que una cuenta recién
    // comprada no mostraba en ningún lado cuánto tiempo le quedaba.
    const expiryLabel = a.daysLeft !== null && a.daysLeft !== undefined
      ? renewalStatusText(a.daysLeft)
      : (a.expiresAt ? "Vence: " + a.expiresAt : "");
    // Franja del header en color — naranja normal, o rojo/naranja "urgente"
    // cuando ya se puede renovar (mismo umbral que canRenew), para que el
    // estado se note de un vistazo sin tener que leer el texto.
    const headClass = canRenew ? "urgent" : "ok";
    return `
      <div class="success-account-card" data-platform="${escapeHtml(a.platform)}" data-email="${escapeHtml(a.email)}">
        <div class="success-account-head ${headClass}">
          <span class="success-account-platform">${escapeHtml(a.platform)}</span>
          ${expiryLabel ? `<span class="success-account-expiry-pill">${escapeHtml(expiryLabel)}</span>` : ""}
          <button class="btn-secondary btn-sm success-copy-btn" data-idx="${idx}" type="button">📋 Copiar todo</button>
        </div>
        <div class="success-account-body">
          ${expiryLabel ? `<div class="success-account-expiry">${escapeHtml(expiryLabel)}</div>` : ""}
          <div class="success-account-row"><b>Correo:</b> <span class="success-account-value">${escapeHtml(a.email)}</span></div>
          <div class="success-account-row"><b>Contraseña:</b> <span class="success-account-value">${escapeHtml(a.password)}</span></div>
          ${a.profileName ? `<div class="success-account-row"><b>Perfil:</b> <span class="success-account-value">${escapeHtml(a.profileName)}</span></div>` : ""}
          ${canRenew && nonRenewable ? `
            <div class="success-account-renew-box">
              <span class="badge-no-renewable">🚫 No Renovable</span>
            </div>
          ` : ""}
          ${canRenew && !nonRenewable ? `
            <div class="success-account-renew-box">
              ${needsCanvaEmail ? `
                <input type="email" class="renewal-canva-email-input" data-idx="${idx}" placeholder="Correo para activar ${escapeHtml(a.platform)}">
                <p class="form-error renewal-canva-email-error" data-idx="${idx}" hidden></p>
              ` : ""}
              ${needsRenewPassword ? `
                <input type="password" class="renewal-canva-password-input" data-idx="${idx}" placeholder="Contraseña de esa cuenta">
                <p class="form-error renewal-canva-password-error" data-idx="${idx}" hidden></p>
              ` : ""}
              <button class="btn-primary btn-sm success-renew-btn" data-idx="${idx}" type="button">Renovar</button>
            </div>
          ` : ""}
        </div>
      </div>`;
  }

  function initDashboardRenewals() {
    document.getElementById("dashboard-active-list").addEventListener("click", (e) => {
      const btn = e.target.closest(".success-renew-btn");
      if (!btn) return;
      const idx = Number(btn.dataset.idx);
      const acc = cachedDashboard[idx];
      if (!acc) return;

      let clientEmail;
      let clientPassword;
      if (isManualActivationPlatform(acc.platform)) {
        const input   = document.querySelector(`.renewal-canva-email-input[data-idx="${idx}"]`);
        const errorEl = document.querySelector(`.renewal-canva-email-error[data-idx="${idx}"]`);
        clientEmail = input.value.trim();
        if (!isValidEmail(clientEmail)) {
          errorEl.textContent = "Escribe un correo válido para activar " + acc.platform + ".";
          errorEl.hidden = false;
          return;
        }
        errorEl.hidden = true;
      }
      if (requiresPasswordPlatform(acc.platform)) {
        const input   = document.querySelector(`.renewal-canva-password-input[data-idx="${idx}"]`);
        const errorEl = document.querySelector(`.renewal-canva-password-error[data-idx="${idx}"]`);
        clientPassword = input.value;
        if (!clientPassword.trim()) {
          errorEl.textContent = "Escribe la contraseña de esa cuenta.";
          errorEl.hidden = false;
          return;
        }
        errorEl.hidden = true;
      }

      startRenewalCheckout(acc.platform, clientEmail, clientPassword);
    });
  }

  function accountCopyText(a) {
    return `Manguitope — ${a.platform}\nCorreo: ${a.email}\nContraseña: ${a.password}` +
      (a.profileName ? `\nPerfil: ${a.profileName}` : "");
  }

  function wireSuccessCopyButtons(container, accounts) {
    container.querySelectorAll(".success-copy-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(accountCopyText(accounts[Number(btn.dataset.idx)]));
          const original = btn.textContent;
          btn.textContent = "✅ Copiado";
          setTimeout(() => { btn.textContent = original; }, 1800);
        } catch {
          alert("No se pudo copiar. Copia los datos manualmente.");
        }
      });
    });
  }

  function showCheckoutSuccess(newAccounts) {
    const container = document.getElementById("checkout-success-accounts");
    container.innerHTML = newAccounts.map(successAccountHtml).join("");
    wireSuccessCopyButtons(container, newAccounts);
    showCheckoutState("success");
  }

  function closeCheckout() {
    stopPolling();
    document.getElementById("checkout-modal").hidden = true;
  }

  // ─────────────────────────────────────────────────────────────
  // CÓDIGOS — en pruebas, solo CODES_TEST_PHONE (ver onAuthenticated)
  // ─────────────────────────────────────────────────────────────

  function codesCardHtml(a) {
    const remaining = a.requestsMax - a.requestsUsed;
    const canRequest = remaining > 0;
    return `
      <div class="renewal-account-card" data-account-id="${a.accountId}">
        <div class="renewal-account-head">
          <span class="renewal-account-platform">${escapeHtml(a.platform)}</span>
          <span class="renewal-account-status">${escapeHtml(a.expiresAt ? "Vence: " + a.expiresAt : "")}</span>
        </div>
        <div class="renewal-account-email">${escapeHtml(a.email)}</div>
        <div class="codes-result" data-role="result" hidden></div>
        <div class="renewal-account-footer">
          <span class="codes-remaining" data-role="remaining">${remaining} de ${a.requestsMax} pedido(s) disponibles</span>
          <button class="btn-primary btn-sm codes-request-btn" type="button" ${canRequest ? "" : "disabled"}>Pedir código</button>
        </div>
      </div>
    `;
  }

  async function loadCodesAccounts() {
    const list  = document.getElementById("codes-list");
    const empty = document.getElementById("codes-empty");
    try {
      const { accounts } = await api("/codes");
      if (!accounts || accounts.length === 0) {
        list.innerHTML = "";
        empty.hidden = false;
      } else {
        empty.hidden = true;
        list.innerHTML = accounts.map(codesCardHtml).join("");
      }
    } catch (err) {
      list.innerHTML = "";
      empty.textContent = err.message;
      empty.hidden = false;
    }
  }

  function initCodesView() {
    document.getElementById("codes-list").addEventListener("click", async (e) => {
      const btn = e.target.closest(".codes-request-btn");
      if (!btn) return;
      const card = btn.closest(".renewal-account-card");
      const accountId = card.dataset.accountId;
      const resultEl = card.querySelector("[data-role='result']");
      const remainingEl = card.querySelector("[data-role='remaining']");

      btn.disabled = true;
      resultEl.hidden = true;
      try {
        const { code, receivedAt } = await api("/codes/" + accountId + "/request", { method: "POST" });
        resultEl.hidden = false;
        if (code) {
          resultEl.innerHTML = `<div class="codes-value">${escapeHtml(code)}</div><div class="codes-meta">Llegó: ${escapeHtml(receivedAt)}</div>`;
        } else {
          resultEl.innerHTML = `<div class="codes-meta">Todavía no llegó ningún código. Intenta de nuevo en un rato.</div>`;
        }
        const match = remainingEl.textContent.match(/^(\d+) de (\d+)/);
        if (match) {
          const left = Math.max(0, Number(match[1]) - 1);
          remainingEl.textContent = `${left} de ${match[2]} pedido(s) disponibles`;
          btn.disabled = left <= 0;
        }
      } catch (err) {
        resultEl.hidden = false;
        resultEl.innerHTML = `<div class="codes-meta">${escapeHtml(err.message)}</div>`;
        btn.disabled = false;
      }
    });
  }

  function initCheckoutModal() {
    document.getElementById("checkout-close").addEventListener("click", closeCheckout);
    document.getElementById("checkout-retry").addEventListener("click", closeCheckout);
    document.getElementById("checkout-goto-dashboard").addEventListener("click", closeCheckout);
    initYapeCopyButtons();
  }

  // ─────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────

  async function init() {
    initAuthToggle();
    initAuthForms();
    initNav();
    initNotifications();
    initCatalogClicks();
    initCheckoutModal();
    initProductDetailModal();
    initDashboardRenewals();
    initComboBuilder();
    initCodesView();

    try {
      const me = await api("/auth/me");
      if (me.authenticated) { await onAuthenticated(); return; }
    } catch { /* sin sesión — muestra el login */ }
    showAuth();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
