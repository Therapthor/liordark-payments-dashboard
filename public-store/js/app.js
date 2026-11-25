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

  // liordark.com/codigos y liordark.com/soporte (los links que el admin
  // copia para WhatsApp) llegan como #codigos / #soporte.
  const LINK_PAGES = { "#codigos": "codes", "#soporte": "support" };
  const LINK_LOGIN_TEXTS = {
    codes: {
      title: "🔑 Tus códigos",
      subtitle: "Ingresa con tu celular y tu PIN para ver los códigos de tus cuentas. ¿Primera vez? Pon tu correo y crea tu PIN aquí mismo.",
      button: "Ver mis códigos",
    },
    support: {
      title: "🛟 Soporte",
      subtitle: "Ingresa con tu celular y tu PIN para reportar un problema con tu cuenta. ¿Primera vez? Pon tu correo y crea tu PIN aquí mismo.",
      button: "Ir a Soporte",
    },
  };

  function openAuthModal(context) {
    const sub = document.getElementById("quick-subtitle");
    // Links de Códigos/Soporte traen su propio título y botón; la compra usa
    // los de siempre.
    document.getElementById("start-title").textContent = (context && context.title) || "Para entregarte tu cuenta";
    document.getElementById("quick-submit").textContent = (context && context.button) || "Continuar al pago";
    sub.textContent = context && context.subtitle ? context.subtitle
      : context && context.label
      ? `${context.label}${context.price ? " · S/ " + context.price : ""} — déjanos tu celular y un PIN y pasas directo al pago.`
      : "Déjanos tu celular y tu PIN para continuar.";
    setFormError("quick-error", "");
    showAuthCard("start-card");
    document.getElementById("auth-modal").hidden = false;
    lastQuickDigits = "";
    checkQuickPhone();
    setTimeout(() => document.getElementById("quick-phone").focus(), 50);
  }

  // ── «Entrar»: celular y correo unidos ──
  // Apenas escribe su celular se sabe qué pedirle:
  //  · has_email  → ya tiene correo: solo su PIN.
  //  · need_email → cliente sin correo: lo agrega aquí y queda unido a su número.
  //  · new        → número nuevo: correo + crea su PIN.
  //  · activate   → compró por WhatsApp sin acceso web: se activa por WhatsApp.
  // Sin respuesta (red, número incompleto) se muestra todo como antes y el
  // servidor decide al enviar.
  let quickState = "";
  let lastQuickDigits = "";
  let quickCheckSeq = 0;
  let quickCheckTimer = null;

  function quickDigits() {
    return document.getElementById("quick-phone").value.replace(/\D/g, "");
  }

  function setQuickState(state) {
    quickState = state || "";
    const status = document.getElementById("quick-status");
    const emailWrap = document.getElementById("quick-email-wrap");
    const email = document.getElementById("quick-email");
    const pinWrap = document.getElementById("quick-pin-wrap");
    const pin = document.getElementById("quick-pin");
    const activate = document.getElementById("quick-activate");
    const submit = document.getElementById("quick-submit");
    const texts = {
      has_email: "✅ Ya eres cliente y tu correo está registrado. Solo pon tu PIN.",
      need_email: "👋 Ya eres cliente, pero tu cuenta aún no tiene correo. Agrégalo aquí: queda unido a tu número y ahí te llegan tus cuentas y tu PIN si lo olvidas.",
      new: "✨ ¡Bienvenido! Pon tu correo y crea tu PIN de 4 dígitos.",
    };
    status.textContent = texts[quickState] || "";
    status.hidden = !texts[quickState];
    status.className = "quick-status" + (quickState === "need_email" ? " quick-status--need" : "");
    const isActivate = quickState === "activate";
    emailWrap.hidden = quickState === "has_email" || isActivate;
    email.required = quickState === "need_email" || quickState === "new";
    pinWrap.hidden = isActivate;
    pin.required = !isActivate;
    submit.hidden = isActivate;
    activate.hidden = !isActivate;
    document.getElementById("quick-hint").hidden = !!quickState;
    document.getElementById("quick-pin-label").textContent =
      quickState === "new" ? "Crea tu PIN de 4 dígitos"
      : quickState === "has_email" || quickState === "need_email" ? "Tu PIN (el de siempre)"
      : "Tu PIN de 4 dígitos";
    if (isActivate) {
      const digits = quickDigits().slice(-9);
      document.getElementById("quick-activate-wa").href = "https://wa.me/" + SUPPORT_PHONE + "?text=" + encodeURIComponent(
        "Hola 👋, quiero activar mi acceso a la tienda web. Mi número: " + digits);
    }
  }

  async function checkQuickPhone() {
    const digits = quickDigits();
    if (digits === lastQuickDigits) return;
    lastQuickDigits = digits;
    const seq = ++quickCheckSeq;
    const valid = digits.length === 9 || (digits.length === 11 && digits.startsWith("51"));
    if (!valid) { setQuickState(""); return; }
    try {
      const { state } = await api("/auth/phone-status", { method: "POST", body: { phone: digits } });
      if (seq === quickCheckSeq) setQuickState(state);
    } catch {
      if (seq === quickCheckSeq) setQuickState("");
    }
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
    ["start-card", "login-card", "guest-card", "forgot-card"].forEach(id => {
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
    document.getElementById("band-auth-actions").hidden = !authed;
    refreshCourseVisibility();
  }

  // Curso: solo si está publicado (o, en borrador, para el celular de
  // prueba / quien ya lo tiene). La pestaña «Curso» del menú aparece recién
  // cuando el cliente lo compró; antes, solo el banner para comprarlo.
  async function refreshCourseVisibility() {
    let visible = false, owned = false;
    try {
      const res = await fetch("/api/course/info", { credentials: "include" });
      const info = await res.json();
      visible = !!info.visible;
      owned = visible && !!info.owned;
    } catch { /* sin red: se queda oculto */ }
    const link = document.getElementById("nav-course-link");
    const banner = document.getElementById("course-banner");
    if (link) link.hidden = !owned;
    if (banner) banner.hidden = !visible || owned;
    document.body.classList.toggle("course-visible", visible);
  }

  function initAuthToggle() {
    document.getElementById("show-login-btn").addEventListener("click", () => showAuthCard("login-card"));
    document.getElementById("show-guest-btn").addEventListener("click", () => showAuthCard("guest-card"));
    document.getElementById("back-to-start-from-login").addEventListener("click", () => showAuthCard("start-card"));
    document.getElementById("back-to-start-from-guest").addEventListener("click", () => showAuthCard("start-card"));
    const openForgot = () => {
      setFormError("forgot-error", "");
      document.getElementById("forgot-ok").hidden = true;
      document.getElementById("forgot-submit").hidden = false;
      document.getElementById("forgot-wa-box").hidden = true;
      const typed = document.getElementById("login-phone").value.trim() || document.getElementById("quick-email").value.trim() || document.getElementById("quick-phone").value.trim();
      document.getElementById("forgot-login").value = typed;
      showAuthCard("forgot-card");
      setTimeout(() => document.getElementById("forgot-login").focus(), 50);
    };
    document.getElementById("show-forgot-btn").addEventListener("click", openForgot);
    document.getElementById("show-forgot-btn-2").addEventListener("click", openForgot);
    document.getElementById("back-to-start-from-forgot").addEventListener("click", () => showAuthCard("start-card"));
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
    document.getElementById("quick-phone").addEventListener("input", () => {
      clearTimeout(quickCheckTimer);
      quickCheckTimer = setTimeout(checkQuickPhone, 350);
    });

    document.getElementById("quick-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      setFormError("quick-error", "");
      if (quickState === "activate") return;
      const phone = document.getElementById("quick-phone").value.trim();
      const email = document.getElementById("quick-email").value.trim();
      const pin   = document.getElementById("quick-pin").value;
      const btn   = document.getElementById("quick-submit");
      btn.disabled = true;
      try {
        const done = await api("/auth/quick", { method: "POST", body: { phone, email, password: pin } });
        if (done && done.created) adTrack("CompleteRegistration", {});
        await onAuthenticated();
      } catch (err) {
        setFormError("quick-error", err.message);
        if (/correo/i.test(err.message || "")) {
          document.getElementById("quick-email-wrap").hidden = false;
          document.getElementById("quick-email").focus();
        }
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
      const email = document.getElementById("guest-email").value.trim();
      const pin   = document.getElementById("guest-pin").value;
      if (!/^\d{4}$/.test(pin)) {
        setFormError("guest-error", "El PIN debe ser de 4 dígitos.");
        return;
      }
      try {
        await api("/auth/guest", { method: "POST", body: { phone, email, password: pin } });
        await onAuthenticated();
      } catch (err) {
        setFormError("guest-error", err.message);
      }
    });

    document.getElementById("forgot-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      setFormError("forgot-error", "");
      const login = document.getElementById("forgot-login").value.trim();
      const btn = document.getElementById("forgot-submit");
      btn.disabled = true;
      try {
        const r = await api("/auth/forgot", { method: "POST", body: { login } });
        const ok = document.getElementById("forgot-ok");
        ok.textContent = "✉️ " + (r.message || "Revisa tu correo.");
        ok.hidden = false;
        btn.hidden = true;
        // Sin correo registrado no le llega nada: que pueda pedirlo por WhatsApp.
        const digits = login.includes("@") ? "" : login.replace(/\D/g, "").slice(-9);
        document.getElementById("forgot-wa").href = "https://wa.me/" + SUPPORT_PHONE + "?text=" + encodeURIComponent(
          "Hola 👋, olvidé mi PIN de la tienda y mi cuenta no tiene correo registrado." + (digits ? " Mi número: " + digits : ""));
        document.getElementById("forgot-wa-box").hidden = false;
      } catch (err) {
        setFormError("forgot-error", err.message);
      } finally {
        btn.disabled = false;
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

    // Sin correo todavía: se le pide al entrar (una vez por visita).
    if (!customerHasEmail) askEmailOnEntry();

    // Se queda en la página donde estaba (Catálogo/Mis cuentas) al
    // actualizar, en vez de volver siempre al catálogo — los datos se
    // recargan igual (loadDashboardAccounts/loadCodesAccounts arriba),
    // solo no se pierde dónde estaba parado.
    // liordark.com/#codigos (botón «Volver a Códigos» del visor) y los links
    // liordark.com/codigos y /soporte que el admin manda por WhatsApp.
    const linkPage = LINK_PAGES[location.hash];
    if (linkPage) {
      history.replaceState(null, "", location.pathname + location.search);
      switchPage(linkPage);
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
      // Si el admin le asignó una cuenta con código mientras tenía la
      // página abierta, el botón «Códigos» aparece sin recargar.
      if (isAuthenticated) refreshCodesAvailability();
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
    // Llegó por liordark.com/codigos o /soporte sin sesión: primero inicia
    // sesión y después cae directo en esa sección.
    const linkPage = LINK_PAGES[location.hash];
    if (linkPage) {
      history.replaceState(null, "", location.pathname + location.search);
      pendingAfterAuth = () => switchPage(linkPage);
      openAuthModal(LINK_LOGIN_TEXTS[linkPage]);
      return;
    }
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
  }

  const STORE_PAGE_KEY = "ldp_store_page";
  const VALID_STORE_PAGES = ["catalog", "dashboard", "codes", "support"];

  function switchPage(view) {
    try { localStorage.setItem(STORE_PAGE_KEY, view); } catch { /* localStorage bloqueado — no crítico */ }

    document.querySelectorAll(".nav-btn[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === view));
    document.getElementById("page-catalog").hidden = view !== "catalog";
    document.getElementById("page-dashboard").hidden = view !== "dashboard";
    document.getElementById("page-codes").hidden = view !== "codes";
    document.getElementById("page-support").hidden = view !== "support";
    document.body.classList.toggle("theme-codes-dark", view === "codes");
    // Título de la banda mango y barra inferior según la sección (mango-store.css).
    document.body.dataset.page = view;
    if (view === "dashboard") { loadDashboardAccounts(); refreshEmailStatus(); if (isAuthenticated) refreshCodesAvailability(); }
    if (view === "codes") loadCodesAccounts();
    if (view === "support") loadSupportPage();
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

  // Ficha con las iniciales y el color de cada plataforma (NF rojo, D+
  // azul…) — mismo juego de colores que el panel mayorista (.plat-*).
  const PLATFORM_STYLES = [
    [/netflix/i, "NF", "nf"], [/disney/i, "D+", "dp"], [/hbo|^max$/i, "HBO", "hbo"],
    [/prime|amazon/i, "PV", "pv"], [/crunchy/i, "CR", "cr"], [/spotify/i, "SP", "sp"],
    [/youtube/i, "YT", "yt"], [/canva/i, "CA", "ca"], [/gemini/i, "GE", "ge"],
    [/chatgpt|openai|gpt/i, "AI", "ai"], [/paramount/i, "P+", "pp"], [/vix/i, "VX", "vx"],
    [/apple/i, "TV", "tv"], [/star/i, "S+", "st"],
  ];
  function platformStyle(platform) {
    const p = String(platform || "");
    const hit = PLATFORM_STYLES.find(([re]) => re.test(p));
    return {
      mono: hit ? hit[1] : (p.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?"),
      tone: hit ? "plat-" + hit[2] : "",
    };
  }
  function platformChip(platform, size) {
    const { mono, tone } = platformStyle(platform);
    return `<span class="plat${tone ? " " + tone : ""}${size ? " plat-" + size : ""}" aria-hidden="true">${escapeHtml(mono)}</span>`;
  }

  // Para js/compras-recientes.js (aviso «Alguien compró…»): misma ficha.
  // y para js/avisos.js (botón del aviso: abrir un producto o «Arma tu combo»).
  window.LiordarkStore = { platformChip, openProductDetail, openComboBuilder };

  // Imágenes guardadas en el servidor (/media/products/…​.webp): las tarjetas
  // y fichas usan la versión chica (-s, 360 px); el detalle, la grande.
  function imgSrc(url, big) {
    if (!big && /^\/media\/products\/[a-z0-9-]+\.webp$/.test(url || "")) return url.replace(/\.webp$/, "-s.webp");
    return url;
  }

  function productImgHtml(p, kind, big) {
    const { mono, tone } = kind === "combo" ? { mono: "COMBO", tone: "" } : platformStyle(p.platform);
    const fallback = `<span class="product-img-fallback ${tone}">${escapeHtml(mono)}</span>`;
    return p.imageUrl
      ? `<img src="${escapeHtml(imgSrc(p.imageUrl, big))}" alt="" ${big ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" onerror="this.parentElement.insertAdjacentHTML('afterbegin', this.dataset.fallback); this.remove()" data-fallback="${escapeHtml(fallback)}">`
      : fallback;
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
      ? `<span class="product-badge-overlay badge-exclusive">${annual ? "Anual" : "Exclusivo"}</span>`
      : (annual ? '<span class="product-badge-overlay badge-annual">Anual</span>' : "");

    // El precio se ve siempre, con o sin sesión — el registro rápido
    // (celular + PIN) se pide recién al tocar Comprar (ver requireAuth).
    // El «botón» es solo la cara visible: la card entera abre el detalle.
    const stockHtml = outOfStock
      ? '<span class="product-stock product-stock-out"><i></i>Agotado · se reserva</span>'
      : '<span class="product-stock"><i></i>Disponible</span>';

    return `
      <div class="product-card${cardClass ? " " + cardClass : ""}" ${detailAttr} role="button" tabindex="0" aria-label="${escapeHtml(title)} · S/ ${escapeHtml(p.price)}">
        <div class="product-img-wrap">
          ${productImgHtml(p, kind)}
          ${overlayBadge}
        </div>
        <div class="product-body">
          <span class="product-title">${escapeHtml(title)}</span>
          ${stockHtml}
          <div class="product-buy-row">
            <span class="product-price-big"><small>S/</small>${escapeHtml(p.price)}</span>
            <span class="product-cta${outOfStock ? " product-cta-reserve" : ""}" aria-hidden="true">${outOfStock ? "Reservar" : "Comprar"}</span>
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
      try { paintBandArt(); } catch { /* solo decorativo */ }

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
        html += `<div class="section-chip section-chip-exclusive">Exclusivos</div>`;
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
  // (2 = 5%, 3–4 = 15%, 5+ = 20%). El precio final SIEMPRE lo recalcula el servidor
  // en /checkout — acá solo se muestra una vista previa.
  // ─────────────────────────────────────────────────────────────

  const MIN_CUSTOM_COMBO_ITEMS = 2;
  let comboBuilderCart = []; // platforms elegidas, sin repetir

  // Propuestas de banner (vista previa con ?banner=1..5, sin tocar la
  // tienda real). 0 = el banner de siempre. Para dejar una fija, cambiar
  // COMBO_BANNER_DEFAULT; ?banner=0 siempre muestra el de siempre.
  const COMBO_BANNER_DEFAULT = 1; // elegido por el dueño: «Abanico mango»
  const COMBO_BANNER_VARIANT = (() => {
    const q = new URLSearchParams(location.search).get("banner");
    const n = q === null ? COMBO_BANNER_DEFAULT : Number(q);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 0;
  })();
  if (COMBO_BANNER_VARIANT && !document.querySelector('link[href$="combo-banner-variants.css"]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/css/combo-banner-variants.css";
    document.head.appendChild(link);
  }

  // Manguito: el mango pixel con lentes del curso (js/curso-common.js).
  function manguitoSvg(size) {
    const rows = ["....GG....", "...GG.....", "..OOOOOO..", ".OOOOOOOO.", "OKKKOOKKKO", "OKKKKKKKKO", "OOOOOOOOOO", ".OOOOOOOY.", "..OOOOYY..", "...OOOO..."];
    const col = { O: "#F5941E", G: "#3FA34D", K: "#241A10", Y: "#FFD373" };
    let rects = "";
    rows.forEach((row, y) => [...row].forEach((c, x) => {
      if (col[c]) rects += `<rect x="${x}" y="${y}" width="1.05" height="1.05" fill="${col[c]}"/>`;
    }));
    return `<svg width="${size}" height="${size}" viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
  }

  // Plataformas del banner: las que hay en stock, y si faltan, las de siempre.
  function comboBannerPlatforms(k) {
    const names = (cachedProducts || []).filter(p => !isOutOfStock(p, "platform")).map(p => p.platform)
      .concat(["Netflix", "Disney+", "HBO Max", "Prime Video", "Spotify", "Crunchyroll"]);
    const seen = new Set();
    const out = [];
    for (const n of names) {
      const { tone } = platformStyle(n);
      if (!tone || seen.has(tone)) continue;
      seen.add(tone);
      out.push(n);
      if (out.length >= k) break;
    }
    return out;
  }

  // Ficha con la imagen del producto del catálogo (así el banner y la portada
  // muestran lo mismo que se vende). Sin imagen o si falla al cargar: la
  // ficha de color con iniciales de siempre.
  function productTileHtml(p, size) {
    const chip = platformChip(p.platform, size);
    if (!p.imageUrl) return chip;
    return `<span class="plat plat-img${size ? " plat-" + size : ""}" aria-hidden="true"><img src="${escapeHtml(imgSrc(p.imageUrl))}" alt="" loading="lazy" decoding="async" onerror="this.parentElement.outerHTML = this.dataset.fallback" data-fallback="${escapeHtml(chip)}"></span>`;
  }
  // Productos para las fichas: primero los que tienen imagen y stock, luego
  // los que tienen imagen, y si faltan, fichas de plataforma.
  function productTiles(k, size) {
    const prods = (cachedProducts || []).filter(p => p && p.platform);
    const withImg = prods.filter(p => p.imageUrl);
    const ordered = withImg.filter(p => !isOutOfStock(p, "platform")).concat(withImg.filter(p => isOutOfStock(p, "platform")));
    const seen = new Set();
    const out = [];
    for (const p of ordered) {
      const key = String(p.platform).toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(productTileHtml(p, size));
      if (out.length >= k) return out;
    }
    for (const name of comboBannerPlatforms(k + seen.size)) {
      if (seen.has(String(name).toUpperCase())) continue;
      out.push(platformChip(name, size));
      if (out.length >= k) break;
    }
    return out;
  }
  // Portada (PC): las 6 fichas de la derecha también con las imágenes reales.
  function paintBandArt() {
    const art = document.querySelector(".band-art");
    if (!art || !(cachedProducts || []).some(p => p && p.imageUrl)) return;
    art.innerHTML = productTiles(6, "").join("");
  }

  function comboBannerVariantHtml(v) {
    const max = Math.round(comboDiscountRate(99) * 100);
    const two = Math.round(comboDiscountRate(2) * 100);
    const plats = comboBannerPlatforms(5);
    const chips = (n, size, cls) => plats.slice(0, n).map((p, i) => `<span class="${cls}" style="--i:${i}">${platformChip(p, size)}</span>`).join("");
    const arrow = `<svg class="cbv-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
    const btn = (label, cls = "") => `<button class="cbv-btn ${cls}" id="build-combo-btn" type="button">${label}${arrow}</button>`;
    const mid = Math.round(comboDiscountRate(3) * 100);
    const tiers = `<li><b>2</b> <em>−${two}%</em></li><li><b>3–4</b> <em>−${mid}%</em></li><li><b>5+</b> <em>−${max}%</em></li>`;

    if (v === 1) return `
      <section class="cbv cbv-1" aria-label="Arma tu combo">
        <div class="cbv1-art" aria-hidden="true">
          <div class="cbv1-fan">${productTiles(3, "").map((t, i) => `<span class="cbv1-tile" style="--i:${i}">${t}</span>`).join("")}</div>
          <div class="cbv1-badge"><small>hasta</small><b>−${max}%</b></div>
        </div>
        <div class="cbv1-body">
          <p class="cbv-kicker">Arma tu combo</p>
          <h2 class="cbv-title">Junta tus plataformas y paga menos</h2>
          <ul class="cbv1-tiers">${tiers}</ul>
        </div>
        ${btn("Armar mi combo")}
      </section>`;

    if (v === 2) return `
      <section class="cbv cbv-2" aria-label="Arma tu combo">
        <div class="cbv2-orbit" aria-hidden="true">
          <div class="cbv2-ring">${chips(5, "sm", "cbv2-sat")}</div>
          <div class="cbv2-core"><small>hasta</small><b>${max}%</b><small>menos</small></div>
        </div>
        <div class="cbv2-body">
          <p class="cbv-kicker">Combo a tu medida</p>
          <h2 class="cbv-title">Tus plataformas favoritas, juntas y más baratas</h2>
          <p class="cbv-desc">Elige 2 o más del catálogo y el descuento se aplica solo.</p>
        </div>
        ${btn("Armar mi combo", "cbv2-btn")}
      </section>`;

    if (v === 3) return `
      <section class="cbv cbv-3" aria-label="Arma tu combo">
        <div class="cbv3-ticket">
          <div class="cbv3-main">
            <p class="cbv-kicker">Cupón combo</p>
            <h2 class="cbv-title">Arma tu combo y paga menos</h2>
            <ul class="cbv3-tiers">${tiers}</ul>
            <div class="cbv3-chips" aria-hidden="true">${chips(4, "xs", "cbv3-chip")}</div>
          </div>
          <div class="cbv3-stub">
            <p class="cbv3-off"><small>Hasta</small><b>−${max}%</b><small>en tu combo</small></p>
            ${btn("Armar combo", "cbv3-btn")}
          </div>
        </div>
      </section>`;

    if (v === 4) return `
      <section class="cbv cbv-4" aria-label="Arma tu combo">
        <div class="cbv4-pill">
          <span class="cbv4-chips" aria-hidden="true">${chips(3, "xs", "cbv4-chip")}</span>
          <p class="cbv4-text"><b>Arma tu combo</b><span>Elige 2 o más y paga hasta ${max}% menos</span></p>
          <span class="cbv4-badge" aria-hidden="true">−${max}%</span>
          ${btn("Armar", "cbv4-btn")}
        </div>
      </section>`;

    return `
      <section class="cbv cbv-5" aria-label="Arma tu combo">
        <div class="cbv5-scene" aria-hidden="true">
          <span class="cbv5-spark s1"></span><span class="cbv5-spark s2"></span><span class="cbv5-spark s3"></span>
          <div class="cbv5-mango">${manguitoSvg(104)}</div>
          <span class="cbv5-shadow"></span>
          ${chips(3, "sm", "cbv5-pop")}
        </div>
        <div class="cbv5-body">
          <p class="cbv-kicker">Arma tu combo</p>
          <p class="cbv5-bubble">¡Psst! Junta <b>2 o más</b> plataformas y te hago hasta <b>${max}% de descuento</b>.</p>
          <div class="cbv5-row">${btn("Armar mi combo")}<ul class="cbv5-tiers">${tiers}</ul></div>
        </div>
        <p class="cbv5-stamp" aria-hidden="true">hasta<b>−${max}%</b></p>
      </section>`;
  }

  function buildComboPromptHtml() {
    if (COMBO_BANNER_VARIANT) return comboBannerVariantHtml(COMBO_BANNER_VARIANT);
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
          <span class="build-combo-prompt-badge-bottom">-20%</span>
        </div>
        <div class="build-combo-prompt-text-wrap">
          <p class="build-combo-prompt-title">Junta tus plataformas, paga menos</p>
          <p class="build-combo-prompt-desc">Elige 2 o más del catálogo y ahorra hasta 20% de descuento.</p>
        </div>
        <button class="build-combo-prompt-btn" id="build-combo-btn" type="button">🛒 Armar combo</button>
      </div>
    `;
  }

  function comboDiscountRate(count) {
    if (count >= 5) return 0.20;
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
          ${platformChip(p.platform, "sm")}
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
    } else if (rate < 0.20) {
      const falta = 5 - items.length;
      discountLabel.textContent = "15% de descuento — agrega " + falta + " más para 20%";
      totalEl.textContent = "S/ " + total.toFixed(2);
    } else {
      discountLabel.textContent = "🎉 20% de descuento aplicado";
      totalEl.textContent = "S/ " + total.toFixed(2);
    }

    buyBtn.disabled = items.length < MIN_CUSTOM_COMBO_ITEMS;

    // Barra de progreso del header — 1 seg prendido por cada producto
    // agregado: 1, 2 (5%), 3–4 (15%), 5+ (20%).
    const litSegs = items.length >= 5 ? 4 : Math.min(items.length, 3);
    for (let i = 1; i <= 4; i++) {
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

      adBeginCheckout("combo-armado", "Combo: " + platforms.join(" + "), order.amount, order.orderName);
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
      requireAuth(() => withEmail(() => startCustomComboCheckout(platforms, clientEmail, clientPassword)), { label: "tu combo" });
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
    adTrack("ViewContent", adContent(kind === "combo" ? "combo-" + id : id, title, item.price));
    const needsCanvaEmail = kind === "platform" && isManualActivationPlatform(item.platform);
    const needsPassword   = kind === "platform" && requiresPasswordPlatform(item.platform);
    const outOfStock = isOutOfStock(item, kind);

    document.getElementById("detail-img-wrap").innerHTML = productImgHtml(item, kind, true);
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
      requireAuth(() => withEmail(() => startCheckout({ kind, id, clientEmail, clientPassword, months, isReserve: outOfStock, platformLabel: label })),
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

  function closeEmailReminderModal(saved) {
    document.getElementById("email-reminder-modal").hidden = true;
    if (saved !== true) afterEmailSaved = null; // cerró sin guardar: no se sigue con la compra
  }

  // El mismo cuadro sirve para 3 cosas: recordatorios (desde Mis cuentas),
  // «antes de pagar» (el correo es obligatorio para comprar o renovar) y el
  // aviso al entrar a quien todavía no lo puso.
  const EMAIL_MODAL_TEXT = {
    reminder: { icon: "🔔", title: "Recordatorio de vencimiento", text: "Te avisamos a tu correo cuando tus cuentas estén por vencer." },
    required: { icon: "✉️", title: "Antes de pagar: tu correo", text: "Es obligatorio. Ahí te llegan tus datos de acceso, los cambios de tu cuenta y los recordatorios de vencimiento." },
    welcome:  { icon: "✉️", title: "Agrega tu correo", text: "Desde ahora lo pedimos a todos: ahí te llegan tus datos, los cambios de tu cuenta y los recordatorios. Lo necesitarás para tu próxima compra o renovación." },
  };
  let afterEmailSaved = null;

  function askEmailOnEntry() {
    try {
      if (sessionStorage.getItem("ldp_email_asked") === "1") return;
      sessionStorage.setItem("ldp_email_asked", "1");
    } catch { /* sin sessionStorage: se pide igual */ }
    setTimeout(() => { if (!customerHasEmail) openEmailReminderModal("welcome"); }, 900);
  }

  /** Corre la compra solo si el cliente ya tiene correo; si no, lo pide primero. */
  async function withEmail(action) {
    if (!customerHasEmail) {
      try {
        const { email } = await api("/account/email");
        if (email) { customerHasEmail = true; markEmailConfirmedLocally(currentPhone); }
      } catch { /* sin red: se le pide igual */ }
    }
    if (customerHasEmail) return action();
    afterEmailSaved = action;
    openEmailReminderModal("required");
  }

  async function openEmailReminderModal(mode) {
    const t = EMAIL_MODAL_TEXT[typeof mode === "string" ? mode : "reminder"] || EMAIL_MODAL_TEXT.reminder;
    if (typeof mode !== "string" || mode === "reminder") afterEmailSaved = null;
    document.getElementById("email-reminder-icon").textContent = t.icon;
    document.getElementById("email-reminder-title").textContent = t.title;
    document.getElementById("email-reminder-text").textContent = t.text;
    document.getElementById("email-reminder-save").textContent = mode === "required" ? "Guardar y continuar al pago" : "Guardar";
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
        closeEmailReminderModal(true);
        updateEmailBanner();
        showEmailToast("Listo: tus datos y avisos llegarán a " + email + ".");
        const next = afterEmailSaved;
        afterEmailSaved = null;
        if (next) next();
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
      adBeginCheckout(kind === "combo" ? "combo-" + id : id, platformLabel || id, order.amount, order.orderName);

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
      startPolling(beforeAccounts, targetNewAccounts, isReserve ? { platformLabel: platformLabel || id, amount: order.amount, orderName: order.orderName } : null);
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

  // Pantalla de reserva — dos casos, nunca «¡Reservado!» a ciegas:
  //  · paid: el servidor confirmó el pago de ESTA orden (GET
  //    /orders/:orderName/status) → «¡Pago aprobado!», con el look verde de
  //    éxito. La cuenta llega sola apenas se suba stock.
  //  · si no (reserveInfo.amount === null: la respuesta del checkout se
  //    perdió/tardó) → mensaje neutro «Procesando tu pedido».
  function showCheckoutReserved(reserveInfo, paid) {
    const isPaid = !!paid && reserveInfo.amount !== null;
    if (isPaid) adPurchaseDone();
    document.getElementById("checkout-reserved").classList.toggle("is-paid", isPaid);
    document.getElementById("checkout-reserved-icon").textContent = isPaid ? "✓" : "⏳";
    document.getElementById("checkout-reserved-title").textContent = isPaid ? "¡Pago aprobado!" : "Procesando tu pedido";
    document.getElementById("checkout-reserved-text").innerHTML = isPaid
      ? "Tu reserva está hecha. Estamos terminando de subir el stock: tu cuenta aparecerá sola en «Mis cuentas» y te avisaremos con la campanita."
      : `Tu pedido de <b>${escapeHtml(reserveInfo.platformLabel)}</b> se está procesando — puede tardar unos segundos más de lo normal. ` +
        `Si el pago ya se realizó, tu cuenta va a aparecer sola en "Mis cuentas" y te vamos a notificar. No necesitas hacer nada más 😊`;
    document.getElementById("checkout-reserved-order").hidden = reserveInfo.amount === null;
    if (reserveInfo.amount !== null) {
      document.getElementById("checkout-reserved-amount").textContent =
        reserveInfo.platformLabel + " · S/ " + reserveInfo.amount;
    }
    showCheckoutState("reserved");
  }

  // reserveInfo (pedido sin stock, con su orderName): mientras el pago no
  // esté confirmado se queda en «Esperando tu pago…»; en cuanto el servidor
  // confirma el pago de esa orden pasa a «¡Pago aprobado!». El polling de
  // cuentas sigue en segundo plano: apenas llegue la cuenta, «¡Listo!».
  let pollGeneration = 0;
  function startPolling(beforeAccounts, targetNewAccounts, reserveInfo) {
    stopPolling();
    pollExpiry = Date.now() + POLL_TIMEOUT_MS;
    const generation = ++pollGeneration;
    let paidShown = false;

    pollTimer = setInterval(async () => {
      try {
        const { accounts } = await api("/dashboard");
        if (generation !== pollGeneration || !pollTimer) return;
        cachedDashboard = accounts || [];
        if (cachedDashboard.length >= beforeAccounts.length + targetNewAccounts) {
          stopPolling();
          showCheckoutSuccess(diffNewAccounts(beforeAccounts, cachedDashboard));
          return;
        }
      } catch { /* red momentánea — sigue intentando */ }

      if (reserveInfo && reserveInfo.orderName && !paidShown) {
        try {
          const { paid } = await api("/orders/" + encodeURIComponent(reserveInfo.orderName) + "/status");
          if (paid && generation === pollGeneration && pollTimer) {
            paidShown = true;
            showCheckoutReserved(reserveInfo, true);
          }
        } catch { /* sin respuesta: se vuelve a preguntar en el próximo turno */ }
      }

      if (Date.now() > pollExpiry && !paidShown) {
        document.getElementById("checkout-waiting-text").textContent = "Seguimos esperando tu pago…";
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
    // Con un reporte abierto la tarjeta va en rojo y dice en qué va.
    const sup = a.support ? (a.support.status === "seen" ? "En revisión" : "Enviado") : "";
    return `
      <div class="success-account-card${a.support ? " in-support" : ""}" data-platform="${escapeHtml(a.platform)}" data-email="${escapeHtml(a.email)}">
        <div class="success-account-head ${headClass}">
          ${platformChip(a.platform, "sm")}
          <span class="success-account-platform">${escapeHtml(a.platform)}</span>
          ${expiryLabel ? `<span class="success-account-expiry-pill">${escapeHtml(expiryLabel)}</span>` : ""}
          <div class="success-account-actions">
            <button class="btn-secondary btn-sm success-copy-btn" data-idx="${idx}" type="button">📋 Copiar</button>
          </div>
        </div>
        ${a.support ? `<div class="success-account-support">🛠 En soporte · ${sup} — ${escapeHtml(a.support.problem || "")}<button type="button" class="success-support-go">Ver reporte</button></div>` : ""}
        <div class="success-account-body">
          ${expiryLabel ? `<div class="success-account-expiry">${escapeHtml(expiryLabel)}</div>` : ""}
          <div class="success-account-row"><b>Correo:</b> <span class="success-account-value">${escapeHtml(a.email)}</span></div>
          <div class="success-account-row"><b>Contraseña:</b> <span class="success-account-value">${escapeHtml(a.password)}</span></div>
          ${a.profileName ? `<div class="success-account-row"><b>Perfil:</b> <span class="success-account-value">${escapeHtml(a.profileName)}</span></div>` : ""}
          ${a.pin ? `<div class="success-account-row"><b>PIN del perfil:</b> <span class="success-account-value">🔐 ${escapeHtml(a.pin)}</span></div>` : ""}
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
      if (e.target.closest(".success-support-go")) {
        switchPage("support");
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

      withEmail(() => startRenewalCheckout(acc.platform, clientEmail, clientPassword));
    });
  }

  function accountCopyText(a) {
    return `Manguitope — ${a.platform}\nCorreo: ${a.email}\nContraseña: ${a.password}` +
      (a.profileName ? `\nPerfil: ${a.profileName}` : "") +
      (a.pin ? `\nPIN: ${a.pin}` : "");
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
    adPurchaseDone();
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
          ${platformChip(a.platform, "sm")}
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
        ${canOpen ? "" : a.resetRequested
          ? `<p class="codes-reset-note">⏳ Pediste restablecer tus intentos. Te avisamos en la campanita 🔔.</p>`
          : `<button class="btn-secondary codes-reset-btn" type="button">🔁 Pedir más intentos hoy</button>`}
      </div>`;
  }

  function requestCodesReset(accountId) {
    return api("/codes/" + encodeURIComponent(accountId) + "/reset-request", { method: "POST" });
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

  // Si el hash cambia a #codigos o #soporte sin recargar la página.
  window.addEventListener("hashchange", () => {
    const linkPage = LINK_PAGES[location.hash];
    if (!linkPage || !isAuthenticated) return;
    history.replaceState(null, "", location.pathname + location.search);
    switchPage(linkPage);
  });

  function initCodesView() {
    document.getElementById("codes-list").addEventListener("click", async (e) => {
      const resetBtn = e.target.closest(".codes-reset-btn");
      if (resetBtn && !resetBtn.disabled) {
        const card = resetBtn.closest("[data-account-id]");
        resetBtn.disabled = true;
        try {
          await requestCodesReset(card.dataset.accountId);
          alert("✅ Pedido enviado. Te avisamos en la campanita 🔔 apenas puedas volver a pedir tu código.");
        } catch (err) {
          alert(err.message || "No se pudo enviar el pedido.");
        }
        loadCodesAccounts();
        return;
      }
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
  // SOPORTE — sección propia (ya no es un chat): el cliente elige su
  // cuenta y qué le pasa (sin escribir mensajes), y sigue el estado de sus
  // reportes. Todo llega al panel › Soportes. WhatsApp queda solo para
  // problemas con la página web.
  // ─────────────────────────────────────────────────────────────

  const SUPPORT_WA_DISPLAY = "+51 963 081 436";
  const SUPPORT_STATUS = {
    pending:  { label: "Enviado",     cls: "pending" },
    seen:     { label: "En revisión", cls: "seen" },
    attended: { label: "Resuelto",    cls: "done" },
  };
  let spAccounts = [], spReasons = [], spCodes = [], spPick = null, spReason = null;

  function waSupportUrl(text) {
    return "https://wa.me/" + SUPPORT_PHONE + "?text=" + encodeURIComponent(text);
  }
  function localPhoneNumber() {
    return String(currentPhone || "").replace(/\D/g, "").slice(-9);
  }
  function spDate(sql) {
    if (!sql) return "";
    const d = new Date(String(sql).replace(" ", "T") + "Z");
    return d.toLocaleString("es-PE", { timeZone: "America/Lima", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  }
  function spMsg(kind, html) {
    document.getElementById("sp-msg").innerHTML = html ? `<div class="sp-note ${kind}">${html}</div>` : "";
  }

  async function loadSupportPage() {
    spPick = null; spReason = null;
    document.getElementById("sp-reason-wrap").hidden = true;
    spMsg("", "");
    document.getElementById("sp-wa").href = waSupportUrl(`Hola 👋, tengo un problema con la página web. Mi número: ${localPhoneNumber()}`);
    const box = document.getElementById("sp-accounts");
    box.innerHTML = `<p class="muted">Cargando tus cuentas…</p>`;
    try {
      const [acc, codes] = await Promise.all([
        api("/support/accounts"),
        hasCodesAccounts ? api("/codes").catch(() => ({ accounts: [] })) : Promise.resolve({ accounts: [] }),
      ]);
      spAccounts = acc.accounts || [];
      spReasons = acc.reasons || [];
      spCodes = codes.accounts || [];
    } catch (err) {
      box.innerHTML = `<p class="muted">${escapeHtml(err.message || "No se pudo cargar tus cuentas.")}</p>`;
      return;
    }
    renderSupportAccounts();
    loadSupportTickets();
  }

  function renderSupportAccounts() {
    const box = document.getElementById("sp-accounts");
    if (!spAccounts.length) {
      box.innerHTML = `<p class="muted">No tienes cuentas activas para reportar.</p>`;
      return;
    }
    box.innerHTML = spAccounts.map((a, i) => {
      const st = a.reported ? SUPPORT_STATUS[a.reportStatus] || SUPPORT_STATUS.pending : null;
      return `<button type="button" class="sp-account${a.reported ? " in-support" : ""}${spPick === i ? " picked" : ""}" data-sp-acc="${i}"${a.reported ? " disabled" : ""}>
          ${platformChip(a.platform, "sm")}
          <span class="sp-account-text"><b>${escapeHtml(a.platformTag)}</b><span>${escapeHtml(a.email)}${a.profileName ? " · " + escapeHtml(a.profileName) : ""}</span></span>
          ${st ? `<span class="sp-chip ${st.cls}">🛠 En soporte · ${st.label}</span>` : ""}
        </button>`;
    }).join("");
  }

  /** Cuenta de «Códigos» que corresponde a la elegida (para «sin intentos»). */
  function spCodesAccountFor(a) {
    const mail = String(a.email || "").toLowerCase();
    return spCodes.find(c => String(c.email || "").toLowerCase() === mail) || null;
  }

  function renderSupportReasons() {
    const a = spAccounts[spPick];
    const codes = a ? spCodesAccountFor(a) : null;
    const extra = codes && !codes.openUrl && codes.remaining <= 0 && !codes.resetRequested
      ? [{ id: "codes-reset", label: "Se acabaron mis intentos de códigos de hoy" }] : [];
    document.getElementById("sp-reasons").innerHTML = spReasons.concat(extra).map(r =>
      `<button type="button" class="sp-reason${spReason === r.id ? " picked" : ""}" data-sp-reason="${escapeHtml(r.id)}">${escapeHtml(r.label)}</button>`
    ).join("");
    const tip = document.getElementById("sp-reason-tip");
    tip.innerHTML = spReason === "code" && codes
      ? `💡 Esta cuenta tiene <b>Códigos</b>: pídelo ahí primero. Si igual no llega, envía el reporte.`
      : "";
    document.getElementById("sp-send").disabled = !spReason;
  }

  async function sendSupportReport() {
    const a = spAccounts[spPick];
    if (!a || !spReason) return;
    const btn = document.getElementById("sp-send");
    btn.disabled = true;
    try {
      if (spReason === "codes-reset") {
        const codes = spCodesAccountFor(a);
        await requestCodesReset(codes.accountId);
      } else {
        await api("/support/reports", { method: "POST", body: { platform: a.platform, email: a.email, reason: spReason } });
      }
      const done = `✅ ¡Listo! Tu reporte de <b>${escapeHtml(a.platformTag)}</b> ya nos llegó. Síguelo aquí abajo en «Mis reportes»; te avisamos en la campanita 🔔${customerHasEmail ? " y por correo" : ""} apenas haya novedades.`;
      await loadSupportPage();
      spMsg("ok", done);
    } catch (err) {
      spMsg("bad", escapeHtml(err.message || "No se pudo enviar el reporte."));
      btn.disabled = false;
    }
  }

  async function loadSupportTickets() {
    const box = document.getElementById("sp-tickets");
    try {
      const { tickets } = await api("/support/tickets");
      if (!tickets.length) { box.innerHTML = `<p class="muted">Todavía no tienes reportes.</p>`; return; }
      box.innerHTML = tickets.map(t => {
        const st = SUPPORT_STATUS[t.status] || SUPPORT_STATUS.pending;
        const steps = [
          { on: true, label: "Enviado", at: t.createdAt },
          { on: t.status !== "pending", label: "En revisión", at: t.reviewedAt },
          { on: t.status === "attended", label: "Resuelto", at: t.attendedAt },
        ];
        return `<article class="sp-ticket ${st.cls}">
            <header>
              ${platformChip(t.platform, "sm")}
              <span class="sp-ticket-who"><b>${escapeHtml(t.platformTag)}</b><span>${escapeHtml(t.accountEmail)}</span></span>
              <span class="sp-chip ${st.cls}">${st.label}</span>
            </header>
            <p class="sp-ticket-problem">${escapeHtml(t.problem)}</p>
            <ol class="sp-steps">${steps.map(s => `<li class="${s.on ? "on" : ""}"><span>${s.label}</span>${s.on && s.at ? `<small>${escapeHtml(spDate(s.at))}</small>` : ""}</li>`).join("")}</ol>
            ${t.resolutionLabel ? `<p class="sp-ticket-result">✅ ${escapeHtml(t.resolutionLabel)}${t.resolution === "replaced" ? ` · <button type="button" class="sp-link" data-sp-go="dashboard">Ver en Mis cuentas</button>` : ""}</p>` : ""}
          </article>`;
      }).join("");
    } catch (err) {
      box.innerHTML = `<p class="muted">${escapeHtml(err.message || "No se pudo cargar tus reportes.")}</p>`;
    }
  }

  function initSupportPage() {
    const page = document.getElementById("page-support");
    page.addEventListener("click", (e) => {
      const acc = e.target.closest("[data-sp-acc]");
      if (acc && !acc.disabled) {
        spPick = Number(acc.dataset.spAcc);
        spReason = null;
        spMsg("", "");
        renderSupportAccounts();
        document.getElementById("sp-reason-wrap").hidden = false;
        renderSupportReasons();
        document.getElementById("sp-reason-wrap").scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
      const reason = e.target.closest("[data-sp-reason]");
      if (reason) { spReason = reason.dataset.spReason; renderSupportReasons(); return; }
      const go = e.target.closest("[data-sp-go]");
      if (go) { switchPage(go.dataset.spGo); return; }
    });
    document.getElementById("sp-send").addEventListener("click", sendSupportReport);
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

  // ── Píxel de TikTok (publicidad) ──
  // Solo si el admin pegó el ID en el panel (Configuración › 📈 Publicidad).
  // Eventos: PageView (al cargar), ViewContent (abre un producto),
  // InitiateCheckout (se le muestra el monto a pagar), Purchase (pago
  // aprobado) y CompleteRegistration (cuenta nueva). Sin ID no carga nada.
  // Nunca se manda el celular, el correo ni el PIN del cliente.
  let adCheckout = null; // compra en curso: se reporta una sola vez al aprobarse
  function loadTikTokPixel(pixelId) {
    if (!pixelId || window.ttq) return;
    /* Código base oficial de TikTok (cola de eventos hasta que carga events.js). */
    !function (w, d, t) {
      w.TiktokAnalyticsObject = t; var ttq = w[t] = w[t] || [];
      ttq.methods = ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie", "holdConsent", "revokeConsent", "grantConsent"];
      ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); }; };
      for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
      ttq.instance = function (t) { for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]); return e; };
      ttq.load = function (e, n) {
        var r = "https://analytics.tiktok.com/i18n/pixel/events.js", o = n && n.partner;
        ttq._i = ttq._i || {}, ttq._i[e] = [], ttq._i[e]._u = r, ttq._t = ttq._t || {}, ttq._t[e] = +new Date, ttq._o = ttq._o || {}, ttq._o[e] = n || {};
        n = d.createElement("script"); n.type = "text/javascript", n.async = !0, n.src = r + "?sdkid=" + e + "&lib=" + t;
        e = d.getElementsByTagName("script")[0]; e.parentNode.insertBefore(n, e);
      };
      ttq.load(pixelId);
      ttq.page();
    }(window, document, "ttq");
  }
  async function initAdPixel() {
    try {
      const { tiktokPixelId } = await api("/tracking");
      loadTikTokPixel(tiktokPixelId);
    } catch { /* sin red: la tienda sigue igual */ }
  }
  function adTrack(event, params, eventId) {
    try {
      if (!window.ttq || typeof window.ttq.track !== "function") return;
      window.ttq.track(event, Object.assign({ currency: "PEN" }, params || {}), eventId ? { event_id: eventId } : undefined);
    } catch { /* la publicidad nunca rompe la tienda */ }
  }
  function adContent(id, name, price) {
    const value = Number(String(price ?? "").replace(",", "."));
    return {
      contents: [{ content_id: String(id), content_name: String(name || id), content_type: "product", quantity: 1, price: isFinite(value) ? value : undefined }],
      content_type: "product",
      value: isFinite(value) ? value : undefined,
    };
  }
  function adBeginCheckout(id, name, amount, orderName) {
    adCheckout = { params: adContent(id, name, amount), eventId: orderName ? "pay-" + orderName : undefined };
    adTrack("InitiateCheckout", adCheckout.params);
  }
  function adPurchaseDone() {
    if (!adCheckout) return;
    adTrack("Purchase", adCheckout.params, adCheckout.eventId);
    adCheckout = null;
  }

  // ── Tienda siempre al día ──
  // Una pestaña que quedó abierta desde antes de una actualización (pasa
  // mucho en el celular) seguía con el formulario viejo. Al volver a la
  // pestaña se compara la huella con el servidor y, si cambió, se recarga
  // sola — pero nunca en medio de algo: con una ventana abierta (pago,
  // registro, detalle) o escribiendo, espera a la próxima revisión.
  function watchStoreVersion() {
    let mine = null;
    let checking = false;
    function busy() {
      const el = document.activeElement;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
      return !!document.querySelector(".modal-backdrop:not([hidden])");
    }
    async function check() {
      if (checking || document.hidden) return;
      checking = true;
      try {
        const res = await fetch("/api/store-version", { cache: "no-store", credentials: "include" });
        const data = await res.json();
        if (data && data.v) {
          if (!mine) mine = data.v;
          else if (data.v !== mine && !busy()) location.reload();
        }
      } catch { /* sin red: se revisa después */ }
      checking = false;
    }
    check();
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", (e) => { if (e.persisted) check(); });
    setInterval(check, 5 * 60 * 1000);
  }

  async function init() {
    watchStoreVersion();
    initAdPixel();
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
    initSupportPage();

    try {
      const me = await api("/auth/me");
      if (me.authenticated) { await onAuthenticated(); return; }
    } catch { /* sin sesión — sigue como invitado */ }
    await enterGuestMode();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
