(function () {
  "use strict";

  const API_BASE      = "/api/store";
  const SUPPORT_PHONE = "51963081436"; // wa.me — sin +, sin espacios
  const POLL_MS        = 4000;
  const POLL_TIMEOUT_MS = 3 * 60 * 1000;
  const API_TIMEOUT_MS  = 20_000;

  // ─────────────────────────────────────────────────────────────
  // HELPER — fetch con cookie de sesión de cliente
  // ─────────────────────────────────────────────────────────────

  async function api(path, opts) {
    opts = opts || {};
    const method = opts.method || "GET";
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    // Cache-busting en GET — cualquier capa intermedia (proxy, CDN, el
    // propio navegador) puede cachear una respuesta por URL sin importar
    // los headers que mande el servidor. Un parámetro único por pedido
    // garantiza una URL distinta cada vez, así nunca sirve algo viejo
    // (ej. "ya tengo correo guardado" después de reiniciar el servidor).
    const url = method === "GET"
      ? API_BASE + path + (path.includes("?") ? "&" : "?") + "_=" + Date.now()
      : API_BASE + path;

    let res;
    try {
      res = await fetch(url, {
        method,
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch {
      // No llegó respuesta (timeout/red) — del otro lado el pedido puede
      // haberse creado igual, así que esto NO es un error de negocio
      // (sin .isBusinessError) y el caller decide mostrar un mensaje
      // tranquilizador en vez de un error tajante.
      throw new Error("No se pudo confirmar la respuesta del servidor. Si corresponde, tu pedido puede haberse registrado igual.");
    } finally {
      clearTimeout(timeoutId);
    }

    let data = {};
    try { data = await res.json(); } catch { /* respuesta vacía */ }
    if (!res.ok) {
      const err = new Error(data.message || "Ocurrió un error. Intenta de nuevo.");
      err.isBusinessError = true;
      throw err;
    }
    return data;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ─────────────────────────────────────────────────────────────
  // MODAL — iniciar sesión / comprar sin cuenta
  //
  // Ya no es un gate de pantalla completa: el catálogo (#view-app) se ve
  // siempre, con o sin sesión. Este modal aparece al tocar "🔑 Iniciar
  // sesión" en la barra, o al intentar comprar/armar combo sin sesión
  // (ver initCatalogClicks).
  // ─────────────────────────────────────────────────────────────

  let isAuthenticated = false;
  let customerHasEmail = false;
  // Compra que el cliente quiso hacer sin sesión: se retoma sola apenas
  // termina el registro rápido, sin que tenga que buscar el producto otra vez.
  let pendingAfterAuth = null;

  function openAuthModal(context) {
    const sub = document.getElementById("quick-subtitle");
    sub.textContent = context && context.label
      ? `${context.label}${context.price ? " · S/ " + context.price : ""} — déjanos tu celular y un PIN y pasas directo al pago.`
      : "Déjanos tu celular y tu PIN para continuar.";
    setFormError("quick-error", "");
    showAuthCard("start-card");
    document.getElementById("auth-modal").hidden = false;
    setTimeout(() => document.getElementById("quick-phone").focus(), 50);
  }

  function closeAuthModal() {
    document.getElementById("auth-modal").hidden = true;
  }

  // Ejecuta la acción si hay sesión; si no, abre el registro rápido y la
  // deja pendiente para después.
  function requireAuth(action, context) {
    if (isAuthenticated) { action(); return; }
    pendingAfterAuth = action;
    openAuthModal(context);
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

  // Muestra/oculta los botones de la barra según haya sesión o no —
  // "Mis cuentas"/Soporte/Códigos/campanita/salir vs. "Iniciar sesión"/
  // "Acceso Mayorista".
  function setNavMode(authed) {
    document.getElementById("nav-auth-actions").hidden  = !authed;
    document.getElementById("nav-guest-actions").hidden = authed;
    refreshCourseVisibility();
  }

  // Curso: el botón y el banner solo aparecen si el curso está publicado
  // (o, en borrador, para el celular de prueba / quien ya lo tiene).
  async function refreshCourseVisibility() {
    let visible = false;
    try {
      const res = await fetch("/api/course/info", { credentials: "include" });
      visible = !!(await res.json()).visible;
    } catch { /* sin red: se queda oculto */ }
    const link = document.getElementById("nav-course-link");
    const banner = document.getElementById("course-banner");
    if (link) link.hidden = !visible;
    if (banner) banner.hidden = !visible;
  }

  function initAuthToggle() {
    document.getElementById("show-login-btn").addEventListener("click", () => showAuthCard("login-card"));
    document.getElementById("show-guest-btn").addEventListener("click", () => showAuthCard("guest-card"));
    document.getElementById("back-to-start-from-login").addEventListener("click", () => showAuthCard("start-card"));
    document.getElementById("back-to-start-from-guest").addEventListener("click", () => showAuthCard("start-card"));
    document.getElementById("nav-login-btn").addEventListener("click", () => { pendingAfterAuth = null; openAuthModal(); });
    // Cerrar sin registrarse cancela la compra pendiente.
    document.getElementById("auth-modal-close").addEventListener("click", () => { pendingAfterAuth = null; closeAuthModal(); });
    document.getElementById("auth-modal").addEventListener("click", (e) => {
      if (e.target.id === "auth-modal") { pendingAfterAuth = null; closeAuthModal(); }
    });
  }

  function setFormError(id, message) {
    const el = document.getElementById(id);
    if (!message) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = message;
    el.hidden = false;
  }

  function initAuthForms() {
    document.getElementById("quick-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      setFormError("quick-error", "");
      const phone = document.getElementById("quick-phone").value.trim();
      const pin   = document.getElementById("quick-pin").value;
      const btn   = document.getElementById("quick-submit");
      btn.disabled = true;
      try {
        await api("/auth/quick", { method: "POST", body: { phone, password: pin } });
        await onAuthenticated();
      } catch (err) {
        setFormError("quick-error", err.message);
      } finally {
        btn.disabled = false;
      }
    });

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
      await enterGuestMode();
    });
  }

  let currentPhone = "";

  // Respaldo local de "ya tiene correo registrado" — una vez confirmado
  // por el servidor, queda guardado por celular en este navegador. Así,
  // si algún pedido puntual (reinicio del servidor, red, un proxy
  // intermedio) devuelve un dato viejo o falla, el banner NUNCA vuelve a
  // pedir el correo de alguien que ya lo registró — solo un POST real a
  // /account/email (o el admin borrándolo) puede revertir esta marca.
  function emailConfirmedKey(phone) { return "ldp_email_ok_" + phone; }
  function markEmailConfirmedLocally(phone) {
    try { localStorage.setItem(emailConfirmedKey(phone), "1"); } catch { /* localStorage bloqueado */ }
  }
  function isEmailConfirmedLocally(phone) {
    try { return localStorage.getItem(emailConfirmedKey(phone)) === "1"; } catch { return false; }
  }

  async function onAuthenticated() {
    isAuthenticated = true;
    closeAuthModal();
    setNavMode(true);
    try {
      const me = await api("/auth/me");
      currentPhone = me.phone || "";
      customerHasEmail = !!me.hasEmail || isEmailConfirmedLocally(currentPhone);
      if (me.hasEmail) markEmailConfirmedLocally(currentPhone);
      // Códigos: el botón solo aparece si tiene alguna cuenta con códigos.
      await refreshCodesAvailability();
    } catch (err) {
      // Si /auth/me falla, nos quedamos con lo último confirmado en este
      // navegador (no hay forma de saber el teléfono todavía) — nunca
      // false por default, para no mostrar el banner de más.
      console.error("No se pudo cargar /auth/me:", err);
    }
    updateDashboardNotifyBtn();
    updateEmailBanner();
    refreshEmailStatus();
    startNotifPolling();
    initVisibilityResync();
    await loadCatalog();

    if (pendingSaleCode) {
      const code = pendingSaleCode;
      pendingSaleCode = null;
      await openSaleLink(code);
      return;
    }

    if (pendingAfterAuth) {
      const action = pendingAfterAuth;
      pendingAfterAuth = null;
      switchPage("catalog");
      action();
      return;
    }

    // Se queda en la página donde estaba (Catálogo/Mis cuentas) al
    // actualizar, en vez de volver siempre al catálogo — los datos se
    // recargan igual (loadDashboardAccounts/loadCodesAccounts arriba),
    // solo no se pierde dónde estaba parado.
    // liordark.com/#codigos (botón «Volver a Códigos» del visor).
    if (location.hash === "#codigos" && hasCodesAccounts) {
      history.replaceState(null, "", location.pathname + location.search);
      switchPage("codes");
      return;
    }
    try {
      const savedPage = localStorage.getItem(STORE_PAGE_KEY);
      if (savedPage && VALID_STORE_PAGES.includes(savedPage) && savedPage !== "catalog"
          && (savedPage !== "codes" || hasCodesAccounts)) switchPage(savedPage);
    } catch { /* localStorage bloqueado — se queda en Catálogo, default normal */ }
  }

  // Si el celular bloquea la pantalla o cambia de pestaña, el navegador
  // pausa los setInterval y puede dejar el chat SSE colgado sin avisar
  // (notificaciones/chat "atrasados" hasta refrescar). Al volver: resync
  // inmediato en vez de esperar al siguiente tick del polling.
  function initVisibilityResync() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      loadNotifications();
    });
  }

  // Sin sesión — catálogo visible igual, con precios (el registro rápido
  // se pide al tocar Comprar, ver requireAuth) y la barra en modo
  // invitado (ver setNavMode). Se usa al arrancar sin sesión y al cerrarla.
  async function enterGuestMode() {
    isAuthenticated = false;
    currentPhone = "";
    customerHasEmail = false;
    setNavMode(false);
    updateDashboardNotifyBtn();
    updateEmailBanner();
    switchPage("catalog");
    await loadCatalog();
    if (pendingSaleCode) {
      const code = pendingSaleCode;
      pendingSaleCode = null;
      clearSaleParam();
      let state = "expired";
      try { state = (await api("/sale-link-status/" + encodeURIComponent(code))).state; } catch { /* sin red */ }
      showSaleNotice(state);
    }
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

    const others = cards.filter(c => c !== card);

    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("success-account-card-highlight");
    others.forEach(c => c.classList.remove("success-account-card-dimmed"));
    void card.offsetWidth; // reinicia la animación si ya se había resaltado antes
    card.classList.add("success-account-card-highlight");
    others.forEach(c => c.classList.add("success-account-card-dimmed"));
    setTimeout(() => {
      card.classList.remove("success-account-card-highlight");
      others.forEach(c => c.classList.remove("success-account-card-dimmed"));
    }, 2400);
  }

  async function loadNotifications() {
    try {
      const { notifications, unreadCount } = await api("/notifications");
      renderNotifications(notifications);
      document.getElementById("notif-dot").hidden = !unreadCount;
    } catch { /* no crítico */ }
    refreshEmailStatus();
  }

  // Se re-confirma con el servidor cada ciclo (en vez de confiar solo en
  // el flag local) — así el banner/botón de "Mis cuentas" se autocorrige
  // solo si algún punto del código se queda con el estado viejo.
  async function refreshEmailStatus() {
    try {
      const { email } = await api("/account/email");
      if (email) {
        markEmailConfirmedLocally(currentPhone);
        customerHasEmail = true;
      } else {
        // Un "no tiene correo" del servidor NUNCA pisa una confirmación
        // local previa — evita que un dato viejo/puntual haga reaparecer
        // el banner de alguien que ya lo había registrado.
        customerHasEmail = isEmailConfirmedLocally(currentPhone);
      }
      updateDashboardNotifyBtn();
      updateEmailBanner();
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
    document.getElementById("notif-clear-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await api("/notifications/clear", { method: "POST" });
        renderNotifications([]);
        document.getElementById("notif-dot").hidden = true;
      } catch { /* no crítico */ }
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
    document.getElementById("topbar-support-link").addEventListener("click", (e) => {
      e.preventDefault();
      openChatModal();
    });
  }

  const STORE_PAGE_KEY = "ldp_store_page";
  const VALID_STORE_PAGES = ["catalog", "dashboard", "codes"];

  function switchPage(view) {
    try { localStorage.setItem(STORE_PAGE_KEY, view); } catch { /* localStorage bloqueado — no crítico */ }

    document.querySelectorAll(".nav-btn[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === view));
    document.getElementById("page-catalog").hidden = view !== "catalog";
    document.getElementById("page-dashboard").hidden = view !== "dashboard";
    document.getElementById("page-codes").hidden = view !== "codes";
    document.body.classList.toggle("theme-codes-dark", view === "codes");
    if (view === "dashboard") { loadDashboardAccounts(); refreshEmailStatus(); }
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

    // El precio se ve siempre, con o sin sesión — el registro rápido
    // (celular + PIN) se pide recién al tocar Comprar (ver requireAuth).
    const priceHtml = `${outOfStock ? '<span class="product-reserve-tag-sm">Reservar</span>' : ""}
         <div class="product-price-pill${outOfStock ? " product-price-pill-reserve" : ""}">
           <span class="product-price-pill-currency">S/</span><span class="product-price-pill-amount">${escapeHtml(p.price)}</span>
         </div>`;

    return `
      <div class="product-card${cardClass ? " " + cardClass : ""}" ${detailAttr} role="button" tabindex="0">
        <div class="product-img-wrap">
          ${productImgHtml(p, kind)}
          ${overlayBadge}
        </div>
        <div class="product-body product-body-pill">
          <span class="product-title">${escapeHtml(title)}</span>
          ${priceHtml}
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
      const comboBtn = e.target.closest("#build-combo-btn");
      const card = e.target.closest("[data-detail-platform], [data-detail-combo]");
      if (!comboBtn && !card) return;

      // Sin sesión también se puede ver el detalle y armar el combo — el
      // registro rápido se pide recién al tocar Comprar (ver requireAuth).
      if (comboBtn) { openComboBuilder(); return; }
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
        <div class="build-combo-prompt-deco1"></div>
        <div class="build-combo-prompt-deco2"></div>
        <div class="build-combo-prompt-icons">
          <span class="build-combo-prompt-icon build-combo-prompt-icon--netflix">N</span>
          <span class="build-combo-prompt-icon build-combo-prompt-icon--disney">D+</span>
          <span class="build-combo-prompt-icon build-combo-prompt-icon--max">M</span>
        </div>
        <span class="build-combo-prompt-arrow">→</span>
        <div class="build-combo-prompt-badge">
          <span class="build-combo-prompt-badge-top">Hasta</span>
          <span class="build-combo-prompt-badge-bottom">-15%</span>
        </div>
        <div class="build-combo-prompt-text-wrap">
          <p class="build-combo-prompt-title">Junta tus plataformas, paga menos</p>
          <p class="build-combo-prompt-desc">Elige 2 o más del catálogo y ahorra hasta 15% de descuento.</p>
        </div>
        <button class="build-combo-prompt-btn" id="build-combo-btn" type="button">🛒 Armar combo</button>
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

  // Paleta fija para la "ficha" de cada plataforma en Arma tu combo — el
  // color se elige por hash del nombre, así cada plataforma mantiene
  // siempre el mismo color aunque cambie el orden del catálogo.
  const COMBO_BADGE_COLORS = ["#8e3bd9", "#1577c6", "#5b21b6", "#0ea968", "#d1373d", "#b08550", "#0f9bb5"];
  function comboBadgeColor(platform) {
    let hash = 0;
    for (let i = 0; i < platform.length; i++) hash = (hash * 31 + platform.charCodeAt(i)) >>> 0;
    return COMBO_BADGE_COLORS[hash % COMBO_BADGE_COLORS.length];
  }
  function comboBadgeLetters(title) {
    const words = title.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return title.trim().slice(0, 2).toUpperCase();
  }

  function renderComboBuilderCatalog() {
    const container = document.getElementById("build-combo-catalog");
    const inStock = cachedProducts.filter(p => !isOutOfStock(p, "platform"));
    container.innerHTML = inStock.map(p => {
      const added = comboBuilderCart.includes(p.platform);
      return `
        <div class="build-combo-item">
          <div class="build-combo-item-badge" style="background:${comboBadgeColor(p.platform)}">${escapeHtml(comboBadgeLetters(p.title))}</div>
          <div class="build-combo-item-info">
            <span class="build-combo-item-name">${escapeHtml(p.title)}</span>
            <span class="build-combo-item-price">S/ ${escapeHtml(p.price)}</span>
          </div>
          <button class="build-combo-add-btn" data-platform="${escapeHtml(p.platform)}" type="button" ${added ? "disabled" : ""} aria-label="${added ? "Agregado" : "Agregar"}">
            ${added ? "✓" : "+"}
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

    // Barra de progreso del header — 1 seg prendido por cada producto
    // agregado (tope 3, que ya es el tramo máximo de descuento).
    const litSegs = Math.min(items.length, 3);
    for (let i = 1; i <= 3; i++) {
      document.getElementById("build-combo-seg-" + i).classList.toggle("on", i <= litSegs);
    }

    // Canva / Gemini AI Pro (y YouTube Premium, que además pide contraseña)
    // se activan a mano con el correo del cliente — se pide una sola vez
    // para todo el combo, aunque incluya más de una de estas plataformas.
    const manualItems = items.filter(p => isManualActivationPlatform(p.platform));
    document.getElementById("build-combo-manual-fields").hidden = manualItems.length === 0;
    document.getElementById("build-combo-manual-platforms").textContent =
      manualItems.map(p => p.title).join(" y ");
    document.getElementById("build-combo-manual-password-wrap").hidden =
      !manualItems.some(p => requiresPasswordPlatform(p.platform));

    renderComboBuilderCatalog();
  }

  function openComboBuilder(preset) {
    comboBuilderCart = Array.isArray(preset) ? preset.slice() : [];
    document.getElementById("build-combo-error").hidden = true;
    document.getElementById("build-combo-manual-email").value = "";
    document.getElementById("build-combo-manual-password").value = "";
    renderComboBuilderCart();
    document.getElementById("build-combo-modal").hidden = false;
  }

  function closeComboBuilder() {
    document.getElementById("build-combo-modal").hidden = true;
  }

  async function startCustomComboCheckout(platforms, clientEmail, clientPassword) {
    const modal = document.getElementById("checkout-modal");
    modal.hidden = false;
    showCheckoutState("loading");

    let beforeAccounts = cachedDashboard;
    try {
      beforeAccounts = cachedDashboard.length ? cachedDashboard : (await api("/dashboard")).accounts || [];
      const order = await api("/checkout", {
        method: "POST",
        body: { customComboPlatforms: platforms, clientEmail, clientPassword, saleLink: activeSaleCode || undefined },
      });
      activeSaleCode = null;

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
      if (err.isBusinessError) {
        document.getElementById("checkout-error-text").textContent = err.message;
        showCheckoutState("error");
      } else {
        const reserveInfo = { platformLabel: "tu combo", amount: null };
        showCheckoutReserved(reserveInfo);
        startPolling(beforeAccounts, platforms.length, reserveInfo);
      }
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
      const errorEl = document.getElementById("build-combo-error");
      errorEl.hidden = true;

      const { items } = comboBuilderSelection();
      const manualItems = items.filter(p => isManualActivationPlatform(p.platform));
      let clientEmail, clientPassword;
      if (manualItems.length > 0) {
        clientEmail = document.getElementById("build-combo-manual-email").value.trim();
        if (!isValidEmail(clientEmail)) {
          errorEl.textContent = "Escribe un correo válido para activar " + manualItems.map(p => p.title).join(" y ") + ".";
          errorEl.hidden = false;
          return;
        }
        if (manualItems.some(p => requiresPasswordPlatform(p.platform))) {
          clientPassword = document.getElementById("build-combo-manual-password").value;
          if (!clientPassword.trim()) {
            errorEl.textContent = "Escribe la contraseña de tu cuenta de YouTube.";
            errorEl.hidden = false;
            return;
          }
        }
      }

      const platforms = [...comboBuilderCart];
      closeComboBuilder();
      requireAuth(() => startCustomComboCheckout(platforms, clientEmail, clientPassword), { label: "tu combo" });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // DETALLE DE PRODUCTO — la tarjeta solo muestra lo esencial; la
  // descripción y el botón de comprar aparecen acá, al hacer click.
  // ─────────────────────────────────────────────────────────────

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function openProductDetail({ kind, id, presetMonths }) {
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

    // Planes por meses (GEMINI): 1, 3, 6 o 12 meses — cambia el precio.
    const plans = kind === "platform" && Array.isArray(item.plans) ? item.plans : null;
    let selectedPlan = plans ? (plans.find(pl => pl.months === Number(presetMonths)) || plans[0]) : null;
    const plansBox = document.getElementById("detail-plans");
    plansBox.hidden = !plans;
    const renderPlans = () => {
      if (!plans) return;
      document.getElementById("detail-plans-grid").innerHTML = plans.map(pl => `
        <button type="button" class="detail-plan${pl.months === selectedPlan.months ? " active" : ""}" data-months="${pl.months}">
          <b>${escapeHtml(pl.label)}</b><span>S/ ${escapeHtml(pl.price)}</span>
        </button>`).join("");
      document.getElementById("detail-price").textContent = "S/ " + selectedPlan.price;
    };
    renderPlans();
    document.getElementById("detail-plans-grid").onclick = (e) => {
      const btn = e.target.closest("[data-months]");
      if (!btn || !plans) return;
      selectedPlan = plans.find(pl => pl.months === Number(btn.dataset.months)) || plans[0];
      renderPlans();
    };

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
      const months = selectedPlan ? selectedPlan.months : undefined;
      const label = selectedPlan ? title + " · " + selectedPlan.label : title;
      requireAuth(() => startCheckout({ kind, id, clientEmail, clientPassword, months, isReserve: outOfStock, platformLabel: label }),
        { label, price: selectedPlan ? selectedPlan.price : item.price });
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

  // Colapsadas por defecto (hidden ya viene puesto en el HTML) — el cliente
  // casi nunca necesita ver sus cuentas vencidas, así que no ocupan espacio
  // hasta que las pida con el ojito.
  function initDashboardExpiredToggle() {
    const btn  = document.getElementById("dashboard-expired-toggle");
    const list = document.getElementById("dashboard-expired-list");
    btn.addEventListener("click", () => {
      list.hidden = !list.hidden;
      btn.textContent = list.hidden ? "👁" : "🙈";
      btn.title = list.hidden ? "Mostrar vencidas" : "Ocultar vencidas";
    });
  }

  // ─────────────────────────────────────────────────────────────
  // RECORDATORIO DE VENCIMIENTO POR CORREO — botón en "Mis cuentas" y
  // banner al entrar si no tiene correo guardado. Ambos abren el mismo
  // modal; si ya tiene correo, el campo sale prellenado (no hace falta
  // volver a escribirlo, solo confirmar/cambiar).
  // ─────────────────────────────────────────────────────────────

  let emailToastTimer = null;

  function showEmailToast(desc) {
    clearTimeout(emailToastTimer);
    document.getElementById("email-toast-desc").textContent = desc;
    const toast = document.getElementById("email-toast");
    toast.hidden = false;
    emailToastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
  }

  function closeEmailReminderModal() {
    document.getElementById("email-reminder-modal").hidden = true;
  }

  async function openEmailReminderModal() {
    setFormError("email-reminder-error", "");
    const input = document.getElementById("email-reminder-input");
    input.value = "";
    try {
      const { email } = await api("/account/email");
      input.value = email || "";
    } catch { /* no crítico — queda vacío */ }
    document.getElementById("email-reminder-modal").hidden = false;
  }

  // Botón grande (sin correo) vs. fila chica "✓ Recordatorios activados"
  // + "Cambiar correo" (ya lo tiene) — nunca los dos a la vez.
  function updateDashboardNotifyBtn() {
    document.getElementById("dashboard-notify-btn").hidden = customerHasEmail;
    document.getElementById("dashboard-notify-active").hidden = !customerHasEmail;
  }

  function initEmailReminderModal() {
    document.getElementById("dashboard-notify-btn").addEventListener("click", openEmailReminderModal);
    document.getElementById("dashboard-notify-change-btn").addEventListener("click", openEmailReminderModal);
    document.getElementById("email-reminder-close").addEventListener("click", closeEmailReminderModal);
    document.getElementById("email-reminder-modal").addEventListener("click", (e) => {
      if (e.target.id === "email-reminder-modal") closeEmailReminderModal();
    });

    document.getElementById("email-reminder-save").addEventListener("click", async () => {
      const email = document.getElementById("email-reminder-input").value.trim();
      if (!isValidEmail(email)) {
        setFormError("email-reminder-error", "Escribe un correo válido.");
        return;
      }
      try {
        await api("/account/email", { method: "POST", body: { email } });
        markEmailConfirmedLocally(currentPhone);
        customerHasEmail = true;
        updateDashboardNotifyBtn();
        closeEmailReminderModal();
        updateEmailBanner();
        showEmailToast("Te avisaremos a " + email + " antes de que venzan.");
      } catch (err) {
        setFormError("email-reminder-error", err.message);
      }
    });
  }

  // Banner "falta tu correo" — pocas veces al día (no clavado en pantalla
  // todo el rato): hasta 3 apariciones por día, con al menos 4h entre una
  // y la siguiente. El contador vive en este navegador y se reinicia solo
  // al cambiar de día. Una vez que tiene correo, no se vuelve a mostrar
  // nunca (ver customerHasEmail, con respaldo local en isEmailConfirmedLocally).
  const EMAIL_BANNER_MAX_SHOWS_PER_DAY = 3;
  const EMAIL_BANNER_COOLDOWN_MS = 4 * 60 * 60 * 1000;
  const EMAIL_BANNER_STATE_KEY = "ldp_email_banner_state";

  function readEmailBannerState() {
    const today = new Date().toISOString().slice(0, 10);
    try {
      const raw = JSON.parse(localStorage.getItem(EMAIL_BANNER_STATE_KEY) || "{}");
      if (raw.day === today) return { day: today, shows: raw.shows || 0, lastShownAt: raw.lastShownAt || 0 };
    } catch { /* corrupto o localStorage bloqueado — arranca de cero */ }
    return { day: today, shows: 0, lastShownAt: 0 };
  }

  function writeEmailBannerState(state) {
    try { localStorage.setItem(EMAIL_BANNER_STATE_KEY, JSON.stringify(state)); } catch { /* localStorage bloqueado */ }
  }

  function updateEmailBanner() {
    const banner = document.getElementById("email-banner");
    if (!isAuthenticated || customerHasEmail) { banner.hidden = true; return; }
    if (!banner.hidden) return; // ya se está mostrando — no se re-evalúa ni se cuenta de nuevo

    const state = readEmailBannerState();
    const coolingDown = Date.now() - state.lastShownAt < EMAIL_BANNER_COOLDOWN_MS;
    if (state.shows >= EMAIL_BANNER_MAX_SHOWS_PER_DAY || coolingDown) { banner.hidden = true; return; }

    banner.hidden = false;
    writeEmailBannerState({ day: state.day, shows: state.shows + 1, lastShownAt: Date.now() });
  }

  function closeEmailBanner() {
    document.getElementById("email-banner").hidden = true;
  }

  function initEmailBanner() {
    document.getElementById("email-banner-close").addEventListener("click", closeEmailBanner);
    document.getElementById("email-banner-add").addEventListener("click", openEmailReminderModal);
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
      if (err.isBusinessError) {
        document.getElementById("checkout-error-text").textContent = err.message;
        showCheckoutState("error");
      } else {
        // Igual que en startCheckout: no llegó la respuesta, pero la
        // renovación puede haberse registrado igual del otro lado.
        showCheckoutReserved({ platformLabel: platform, amount: null });
      }
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
    ["loading", "ready", "reserved", "success", "error"].forEach(s => {
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

  async function startCheckout({ kind, id, clientEmail, clientPassword, months, isReserve, platformLabel }) {
    const modal = document.getElementById("checkout-modal");
    modal.hidden = false;
    showCheckoutState("loading");

    let targetNewAccounts = 1;
    if (kind === "combo") {
      const combo = cachedCombos.find(c => c.id === id);
      targetNewAccounts = combo ? combo.items.length : 1;
    }

    let beforeAccounts = cachedDashboard;
    try {
      beforeAccounts = cachedDashboard.length ? cachedDashboard : (await api("/dashboard")).accounts || [];
      const body = kind === "combo" ? { comboId: id } : { platform: id, clientEmail, clientPassword, months };
      if (activeSaleCode) body.saleLink = activeSaleCode;
      const order = await api("/checkout", { method: "POST", body });
      activeSaleCode = null;

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
      startPolling(beforeAccounts, targetNewAccounts, isReserve ? { platformLabel: platformLabel || id, amount: order.amount } : null);
    } catch (err) {
      if (err.isBusinessError) {
        document.getElementById("checkout-error-text").textContent = err.message;
        showCheckoutState("error");
      } else {
        const reserveInfo = { platformLabel: platformLabel || id, amount: null };
        showCheckoutReserved(reserveInfo);
        startPolling(beforeAccounts, targetNewAccounts, reserveInfo);
      }
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

  let reservedScreenShown = false;

  // reserveInfo.amount === null → la orden ni siquiera llegó a confirmarse
  // (la respuesta del checkout se perdió/tardó), así que no hay monto que
  // mostrar — mensaje distinto al de "sin stock, reservado".
  function showCheckoutReserved(reserveInfo) {
    document.getElementById("checkout-reserved-text").innerHTML = reserveInfo.amount === null
      ? `Tu pedido de <b>${escapeHtml(reserveInfo.platformLabel)}</b> se está procesando — puede tardar unos segundos más de lo normal. ` +
        `Si el pago ya se realizó, tu cuenta va a aparecer sola en "Mis cuentas" y te vamos a notificar. No necesitas hacer nada más 😊`
      : `Estamos subiendo stock nuevo de <b>${escapeHtml(reserveInfo.platformLabel)}</b> — apenas esté listo, ` +
        `tu cuenta va a aparecer sola en "Mis cuentas". No necesitas hacer nada más 😊`;
    document.getElementById("checkout-reserved-order").hidden = reserveInfo.amount === null;
    if (reserveInfo.amount !== null) {
      document.getElementById("checkout-reserved-amount").textContent =
        reserveInfo.platformLabel + " · S/ " + reserveInfo.amount;
    }
    showCheckoutState("reserved");
  }

  // reserveInfo: si el pedido es una reserva (sin stock al momento de pagar),
  // al vencer el timeout se muestra la pantalla "¡Reservado!" en vez del
  // texto de espera — pero el polling sigue corriendo igual en segundo
  // plano, así que apenas llegue la cuenta pasa solo a "¡Listo!".
  function startPolling(beforeAccounts, targetNewAccounts, reserveInfo) {
    stopPolling();
    pollExpiry = Date.now() + POLL_TIMEOUT_MS;
    reservedScreenShown = false;

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
        if (reserveInfo) {
          if (!reservedScreenShown) {
            reservedScreenShown = true;
            showCheckoutReserved(reserveInfo);
          }
        } else {
          document.getElementById("checkout-waiting-text").textContent = "Seguimos esperando tu pago…";
        }
      }
    }, POLL_MS);
  }

  function successAccountHtml(a, idx) {
    // La ventana de renovación es el día antes de vencer — ahí el corte
    // automático (ver access.service.ts) alcanza a sumar los 30 días. El
    // mismo día de vencer (o ya vencida) ya no da tiempo: se ofrece
    // comprar una cuenta nueva en vez de dejar pagar una renovación que no
    // se va a aplicar.
    const dueSoon = a.daysLeft !== null && a.daysLeft !== undefined && a.daysLeft <= 1;
    const expired = a.daysLeft !== null && a.daysLeft !== undefined && a.daysLeft <= 0;
    const nonRenewable = isNonRenewablePlatform(a.platform);
    const canRenew = dueSoon && !expired && !nonRenewable;
    const needsNewAccount = dueSoon && (expired || nonRenewable);
    const needsCanvaEmail = canRenew && isManualActivationPlatform(a.platform);
    const needsRenewPassword = canRenew && requiresPasswordPlatform(a.platform);
    // Siempre visible — antes solo se mostraba el vencimiento cuando faltaba
    // 1 día o menos (dentro del cuadro de Renovar), así que una cuenta recién
    // comprada no mostraba en ningún lado cuánto tiempo le quedaba.
    const expiryLabel = a.daysLeft !== null && a.daysLeft !== undefined
      ? renewalStatusText(a.daysLeft)
      : (a.expiresAt ? "Vence: " + a.expiresAt : "");
    // Franja del header en color — naranja normal, o rojo/naranja "urgente"
    // cuando ya se puede renovar (mismo umbral que canRenew), para que el
    // estado se note de un vistazo sin tener que leer el texto.
    const headClass = dueSoon ? "urgent" : "ok";
    return `
      <div class="success-account-card" data-platform="${escapeHtml(a.platform)}" data-email="${escapeHtml(a.email)}">
        <div class="success-account-head ${headClass}">
          <span class="success-account-platform">${escapeHtml(a.platform)}</span>
          ${expiryLabel ? `<span class="success-account-expiry-pill">${escapeHtml(expiryLabel)}</span>` : ""}
          <div class="success-account-actions">
            <button class="btn-secondary btn-sm success-copy-btn" data-idx="${idx}" type="button">📋 Copiar</button>
          </div>
        </div>
        <div class="success-account-body">
          ${expiryLabel ? `<div class="success-account-expiry">${escapeHtml(expiryLabel)}</div>` : ""}
          <div class="success-account-row"><b>Correo:</b> <span class="success-account-value">${escapeHtml(a.email)}</span></div>
          <div class="success-account-row"><b>Contraseña:</b> <span class="success-account-value">${escapeHtml(a.password)}</span></div>
          ${a.profileName ? `<div class="success-account-row"><b>Perfil:</b> <span class="success-account-value">${escapeHtml(a.profileName)}</span></div>` : ""}
          ${a.link ? `<div class="success-account-row"><b>Código:</b> <a class="success-account-link" href="${escapeHtml(a.link)}" target="_blank" rel="noopener">Abrir enlace ↗</a></div>` : ""}
          ${needsNewAccount && nonRenewable ? `
            <div class="success-account-renew-box">
              <span class="badge-no-renewable">🚫 No Renovable</span>
            </div>
          ` : ""}
          ${needsNewAccount && !nonRenewable ? `
            <div class="success-account-renew-box">
              <p class="muted" style="margin:0;">${expired ? "Esta cuenta ya venció." : "Esta cuenta vence hoy."} Ya no se puede renovar el mismo día — compra una cuenta nueva.</p>
              <button class="btn-primary btn-sm success-newaccount-btn" type="button">Comprar cuenta nueva</button>
            </div>
          ` : ""}
          ${canRenew ? `
            <div class="success-account-renew-box">
              <p class="muted" style="margin:0;">Renueva con 1 día de anticipación para que tu cuenta no sea reemplazada.</p>
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
      if (e.target.closest(".success-newaccount-btn")) {
        switchPage("catalog");
        return;
      }

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
    // «Ver códigos»: solo si alguna de sus cuentas tiene códigos (ej. Netflix
    // con código de inicio de sesión). Lleva directo a su sección Códigos.
    const codesBtn = document.getElementById("checkout-goto-codes");
    codesBtn.hidden = true;
    refreshCodesAvailability().then(has => { codesBtn.hidden = !has; }).catch(() => {});
    showCheckoutState("success");
  }

  function closeCheckout() {
    stopPolling();
    document.getElementById("checkout-modal").hidden = true;
  }

  // ─────────────────────────────────────────────────────────────
  // CÓDIGOS — el cliente elige una de sus cuentas con código y se abre la
  // consulta (liordark.com/codigo/…), que revisa cada 30 s. Máximo 3
  // consultas por cuenta al día; si ya hay una abierta, se retoma.
  // ─────────────────────────────────────────────────────────────

  let hasCodesAccounts = false;

  function codesTheme(platform) {
    return /netflix/i.test(platform) ? "netflix"
      : /disney/i.test(platform) ? "disney"
      : /prime|amazon/i.test(platform) ? "prime"
      : /crunchy/i.test(platform) ? "crunchy"
      : /chatgpt|gpt|openai/i.test(platform) ? "chatgpt" : "other";
  }

  function fmtDayMonth(iso) {
    const [y, m, d] = String(iso || "").split("-");
    return d && m && y ? `${d}/${m}/${y}` : "";
  }

  function codesCardHtml(a) {
    const canOpen = !!a.openUrl || a.remaining > 0;
    const label = a.openUrl ? "Continuar consulta" : a.remaining > 0 ? (a.is2fa ? "Ver código 2FA" : "Ver código") : "Sin consultas hoy";
    const dots = Array.from({ length: a.limit }, (_, i) => `<i class="${i < a.used ? "used" : ""}"></i>`).join("");
    return `
      <div class="codes-acc codes-acc-${codesTheme(a.platform)}" data-account-id="${a.accountId}">
        <div class="codes-acc-main">
          <span class="codes-acc-dot"></span>
          <div class="codes-acc-info">
            <b>${escapeHtml(a.platform)}</b>
            <span>${escapeHtml(a.email)}${a.profileName ? " · " + escapeHtml(a.profileName) : ""}</span>
            ${a.expiresAt ? `<span class="codes-acc-exp">Vence: ${escapeHtml(fmtDayMonth(a.expiresAt))}</span>` : ""}
          </div>
        </div>
        <div class="codes-acc-foot">
          <span class="codes-acc-count" title="Consultas usadas hoy"><span class="codes-acc-dots">${dots}</span> ${a.used} de ${a.limit} hoy</span>
          <button class="btn-primary codes-open-btn" type="button" ${canOpen ? "" : "disabled"}>${label}</button>
        </div>
      </div>`;
  }

  async function refreshCodesAvailability() {
    try {
      const { accounts } = await api("/codes");
      hasCodesAccounts = !!(accounts && accounts.length);
    } catch { hasCodesAccounts = false; }
    document.getElementById("topbar-codes-btn").hidden = !hasCodesAccounts;
    return hasCodesAccounts;
  }

  async function loadCodesAccounts() {
    const list  = document.getElementById("codes-list");
    const empty = document.getElementById("codes-empty");
    list.innerHTML = `<p class="muted small">Cargando…</p>`;
    try {
      const { accounts } = await api("/codes");
      if (!accounts || accounts.length === 0) {
        list.innerHTML = "";
        empty.textContent = "Ninguna de tus cuentas activas tiene códigos disponibles.";
        empty.hidden = false;
        return;
      }
      empty.hidden = true;
      list.innerHTML = accounts.map(codesCardHtml).join("");
    } catch (err) {
      list.innerHTML = "";
      empty.textContent = err.message;
      empty.hidden = false;
    }
  }

  // Si el hash cambia a #codigos sin recargar la página.
  window.addEventListener("hashchange", () => {
    if (location.hash !== "#codigos" || !isAuthenticated || !hasCodesAccounts) return;
    history.replaceState(null, "", location.pathname + location.search);
    switchPage("codes");
  });

  function initCodesView() {
    document.getElementById("codes-list").addEventListener("click", async (e) => {
      const btn = e.target.closest(".codes-open-btn");
      if (!btn || btn.disabled) return;
      const card = btn.closest("[data-account-id]");
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = "Abriendo…";
      try {
        const { url } = await api("/codes/" + card.dataset.accountId + "/open", { method: "POST" });
        location.href = url;
      } catch (err) {
        alert(err.message || "No se pudo abrir la consulta.");
        btn.textContent = original;
        loadCodesAccounts();
      }
    });
  }

  function initCheckoutModal() {
    document.getElementById("checkout-close").addEventListener("click", closeCheckout);
    document.getElementById("checkout-retry").addEventListener("click", closeCheckout);
    document.getElementById("checkout-goto-dashboard").addEventListener("click", closeCheckout);
    document.getElementById("checkout-goto-codes").addEventListener("click", () => {
      closeCheckout();
      switchPage("codes");
    });
    document.getElementById("checkout-reserved-goto-dashboard").addEventListener("click", () => {
      closeCheckout();
      switchPage("dashboard");
    });
    initYapeCopyButtons();
  }

  // ─────────────────────────────────────────────────────────────
  // SOPORTE — asistente solo con botones, todo en el navegador: no hay
  // chat ni se guarda ninguna conversación. Lo único que va al panel es el
  // reporte de una cuenta «sin suscripción» (una vez por cuenta). «No
  // puedo ingresar» y «Otro problema» llevan a WhatsApp; «Necesito un
  // código», a Códigos.
  // ─────────────────────────────────────────────────────────────

  const SUPPORT_WA_DISPLAY = "+51 963 081 436";
  let supportAccounts = [];
  let supportCloseTimer = null;

  function waSupportUrl(text) {
    return "https://wa.me/" + SUPPORT_PHONE + "?text=" + encodeURIComponent(text);
  }

  function localPhoneNumber() {
    return String(currentPhone || "").replace(/\D/g, "").slice(-9);
  }

  function supportScroll() {
    const list = document.getElementById("chat-messages");
    list.scrollTop = list.scrollHeight;
  }

  function disableSupportOptions() {
    document.querySelectorAll("#chat-messages .chat-bot-option").forEach(b => {
      if (b.tagName === "BUTTON") b.disabled = true;
    });
  }

  // html: texto YA escapado. options: [{ id, label, url?, disabled? }]
  function supportSay(html, options) {
    disableSupportOptions();
    const opts = (options || []).map(o => o.url
      ? `<a class="chat-bot-option chat-bot-option-link" href="${escapeHtml(o.url)}" target="_blank" rel="noopener">${escapeHtml(o.label)}</a>`
      : `<button type="button" class="chat-bot-option" data-opt="${escapeHtml(o.id)}"${o.disabled ? " disabled" : ""}>${escapeHtml(o.label)}</button>`
    ).join("");
    document.getElementById("chat-messages").insertAdjacentHTML("beforeend", `
      <div class="chat-bubble-row from-admin">
        <div class="chat-bubble"><span class="chat-bot-tag">🤖 Asistente</span><div class="chat-bot-text">${html}</div>${opts ? `<div class="chat-bot-options">${opts}</div>` : ""}</div>
      </div>`);
    supportScroll();
  }

  function supportUserSays(label) {
    document.getElementById("chat-messages").insertAdjacentHTML("beforeend", `
      <div class="chat-bubble-row from-customer"><div class="chat-bubble">${escapeHtml(label)}</div></div>`);
    supportScroll();
  }

  const BACK_OPTION = { id: "menu", label: "⬅️ Volver al menú" };

  function supportMenu(text) {
    supportSay(text, [
      { id: "nosub", label: "📺 Mi cuenta dice «sin suscripción»" },
      { id: "login", label: "🔒 No puedo ingresar a mi cuenta" },
      { id: "other", label: "⚠️ Otro problema con mi cuenta" },
      ...(hasCodesAccounts ? [{ id: "codes", label: "🔑 Necesito un código" }] : []),
    ]);
  }

  function supportWhatsapp(problemText) {
    supportSay(
      `Para esto te atiende un asesor por WhatsApp 💬<br>📱 <b>${SUPPORT_WA_DISPLAY}</b>`,
      [
        { id: "wa", label: "💬 Abrir WhatsApp", url: waSupportUrl(`Hola 👋, ${problemText}. Mi número: ${localPhoneNumber()}`) },
        BACK_OPTION,
      ]
    );
  }

  async function supportPickAccount() {
    supportSay("Un momento, busco tus cuentas… ⏳");
    try {
      const { accounts } = await api("/support/accounts");
      supportAccounts = accounts || [];
    } catch (err) {
      supportSay(escapeHtml(err.message || "No se pudo cargar tus cuentas."), [BACK_OPTION]);
      return;
    }
    if (!supportAccounts.length) {
      supportSay("No encontramos cuentas activas en tu perfil 🤔. Si crees que es un error, escríbenos.", [
        { id: "wa", label: "💬 Abrir WhatsApp", url: waSupportUrl(`Hola 👋, mi cuenta dice sin suscripción. Mi número: ${localPhoneNumber()}`) },
        BACK_OPTION,
      ]);
      return;
    }
    supportSay("¿Cuál de tus cuentas dice «sin suscripción»? 👇", [
      ...supportAccounts.map((a, i) => ({
        id: "acc:" + i,
        label: `${a.platformTag} · ${a.email}${a.reported ? " · ya reportada" : ""}`,
        disabled: a.reported,
      })),
      BACK_OPTION,
    ]);
  }

  function finishSupport() {
    disableSupportOptions();
    document.getElementById("chat-messages").insertAdjacentHTML("beforeend", `<div class="chat-empty">— Chat finalizado —</div>`);
    supportScroll();
    clearTimeout(supportCloseTimer);
    supportCloseTimer = setTimeout(closeChatModal, 7000);
  }

  async function supportReport(index) {
    const acc = supportAccounts[index];
    if (!acc) return supportMenu("Elige una opción 👇");
    try {
      const data = await api("/support/reports", { method: "POST", body: { platform: acc.platform, email: acc.email } });
      supportSay(
        `✅ ¡Listo! Tu cuenta de <b>${escapeHtml(data.platformTag || acc.platformTag)}</b> (${escapeHtml(acc.email)}) ya fue enviada a soporte 🛠️<br>` +
        `La revisamos y te avisamos por WhatsApp y en la campanita 🔔. ¡Gracias por tu paciencia! 🥭`
      );
      finishSupport();
    } catch (err) {
      supportSay(escapeHtml(err.message || "No se pudo enviar el reporte."), [BACK_OPTION]);
    }
  }

  async function handleSupportOption(btn) {
    const id = btn.dataset.opt || "";
    supportUserSays(btn.textContent || "");
    if (id === "menu") return supportMenu("¿En qué más te ayudo? 👇");
    if (id === "nosub") return supportPickAccount();
    if (id === "login") return supportWhatsapp("no puedo ingresar a mi cuenta");
    if (id === "other") return supportWhatsapp("tengo un problema con mi cuenta");
    if (id === "codes") {
      supportSay("¡Listo! Te llevo a «Códigos» 🔑");
      setTimeout(async () => {
        closeChatModal();
        if (await refreshCodesAvailability()) switchPage("codes");
      }, 700);
      return;
    }
    if (id.startsWith("acc:")) return supportReport(Number(id.slice(4)));
  }

  function openChatModal() {
    clearTimeout(supportCloseTimer);
    document.getElementById("chat-modal").hidden = false;
    document.getElementById("chat-messages").innerHTML = "";
    supportAccounts = [];
    supportMenu("¡Hola! 👋 Soy Manguito, el asistente de Liordark 🥭<br>¿Qué pasa con tu cuenta? Elige una opción 👇");
  }

  function closeChatModal() {
    clearTimeout(supportCloseTimer);
    document.getElementById("chat-modal").hidden = true;
  }

  function initChatModal() {
    document.getElementById("chat-close").addEventListener("click", closeChatModal);
    document.getElementById("chat-modal").addEventListener("click", (e) => {
      if (e.target.id === "chat-modal") closeChatModal();
    });
    document.getElementById("chat-messages").addEventListener("click", (e) => {
      const opt = e.target.closest("button.chat-bot-option");
      if (opt && !opt.disabled) { disableSupportOptions(); opt.classList.add("is-picked"); handleSupportOption(opt); }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────
  // LINK DE VENTA — liordark.com/v/<código> deja la sesión abierta y
  // vuelve acá con ?venta=<código>: se muestra el pedido que armó el
  // admin y se abre listo para pagar. La orden queda ligada al link.
  // ─────────────────────────────────────────────────────────────

  let pendingSaleCode = null;
  let activeSaleCode = null;
  try {
    const v = new URLSearchParams(location.search).get("venta");
    if (v && /^[A-Za-z0-9]{8,20}$/.test(v)) pendingSaleCode = v;
  } catch { /* sin URLSearchParams */ }

  function clearSaleParam() {
    try { history.replaceState(null, "", location.pathname + location.hash); } catch { /* nada */ }
  }

  function showSaleModal({ icon, title, text, order, pin, button, onGo }) {
    document.getElementById("sale-icon").textContent = icon;
    document.getElementById("sale-title").textContent = title;
    document.getElementById("sale-text").textContent = text || "";
    const orderBox = document.getElementById("sale-order");
    orderBox.hidden = !order;
    if (order) {
      document.getElementById("sale-order-title").textContent = order.title;
      document.getElementById("sale-order-price").textContent = "S/ " + order.price;
    }
    document.getElementById("sale-pin").hidden = !pin;
    document.getElementById("sale-pin-code").textContent = pin || "";
    const go = document.getElementById("sale-go");
    go.textContent = button;
    const modal = document.getElementById("sale-modal");
    const close = () => { modal.hidden = true; };
    go.onclick = () => { close(); if (onGo) onGo(); };
    document.getElementById("sale-close").onclick = close;
    modal.hidden = false;
  }

  function showSaleNotice(state) {
    if (state === "paid") {
      showSaleModal({ icon: "✅", title: "Este pedido ya está pagado", text: "Inicia sesión con tu celular y PIN para ver tu cuenta en «Mis cuentas».", button: "Entendido" });
    } else if (state === "pending" || state === "opened") {
      showSaleModal({ icon: "🔗", title: "Abre tu link otra vez", text: "No pudimos abrir tu sesión. Vuelve a tocar el link que te enviamos por WhatsApp.", button: "Entendido" });
    } else {
      showSaleModal({
        icon: "⌛", title: "Este link ya no sirve",
        text: state === "cancelled" ? "Este pedido fue anulado. Escríbenos por WhatsApp si necesitas uno nuevo." : "El link venció. Escríbenos por WhatsApp y te mandamos uno nuevo.",
        button: "Escribir por WhatsApp",
        onGo: () => { window.open("https://wa.me/" + SUPPORT_PHONE + "?text=" + encodeURIComponent("Hola, mi link de pedido ya no sirve. ¿Me mandan uno nuevo?"), "_blank", "noopener"); },
      });
    }
  }

  async function openSaleLink(code) {
    clearSaleParam();
    let sale;
    try { sale = await api("/sale-link/" + encodeURIComponent(code)); }
    catch {
      let state = "expired";
      try { state = (await api("/sale-link-status/" + encodeURIComponent(code))).state; } catch { /* nada */ }
      showSaleNotice(state);
      return;
    }
    if (sale.state === "paid") {
      switchPage("dashboard");
      showSaleModal({ icon: "✅", title: "¡Pedido pagado!", text: "Tu cuenta ya está en «Mis cuentas».", button: "Ver mis cuentas" });
      return;
    }
    if (sale.state !== "pending" && sale.state !== "opened") { showSaleNotice(sale.state); return; }

    const openOrder = () => {
      activeSaleCode = code;
      switchPage("catalog");
      if (sale.kind === "combo") {
        openProductDetail({ kind: "combo", id: Number(sale.comboId) });
      } else if (sale.kind === "custom") {
        openComboBuilder(sale.platforms);
      } else {
        openProductDetail({ kind: "platform", id: sale.platforms[0], presetMonths: sale.months });
      }
    };
    const exists = sale.kind === "combo"
      ? cachedCombos.some(c => c.id === Number(sale.comboId))
      : sale.platforms.every(p => cachedProducts.some(x => x.platform === p));
    if (!exists) {
      showSaleModal({ icon: "😕", title: "Ese producto ya no está disponible", text: "Escríbenos por WhatsApp y te ayudamos.", button: "Entendido" });
      return;
    }
    showSaleModal({
      icon: "🥭", title: "¡Tu pedido está listo!",
      text: "Revisa tu pedido y paga con Yape. Apenas pagues, tu cuenta aparece en «Mis cuentas».",
      order: { title: sale.title, price: sale.price },
      pin: sale.pin,
      button: "Ver mi pedido y pagar",
      onGo: openOrder,
    });
  }

  async function init() {
    initAuthToggle();
    initAuthForms();
    initNav();
    initNotifications();
    initCatalogClicks();
    initCheckoutModal();
    initProductDetailModal();
    initDashboardRenewals();
    initDashboardExpiredToggle();
    initComboBuilder();
    initCodesView();
    initEmailReminderModal();
    initEmailBanner();
    initChatModal();

    try {
      const me = await api("/auth/me");
      if (me.authenticated) { await onAuthenticated(); return; }
    } catch { /* sin sesión — sigue como invitado */ }
    await enterGuestMode();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
