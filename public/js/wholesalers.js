(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // HELPERS (propios — este archivo no depende de app.js)
  // ─────────────────────────────────────────────────────────────

  async function api(path, options = {}) {
    const res = await fetch("/api/wholesalers" + path, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (res.status === 401) { location.reload(); throw new Error("No autenticado"); }
    if (res.status === 204) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "Error de red");
    return data;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Mismo helper que public/js/access.js (sin bundler acá, no se puede
  // importar) — celulares de Perú son 9 dígitos, wa.me necesita el 51 antes.
  function waLink(phone, text) {
    let digits = String(phone).replace(/\D/g, "");
    if (digits.length === 9) digits = "51" + digits;
    return "https://api.whatsapp.com/send?phone=" + digits + "&text=" + encodeURIComponent(text);
  }

  function fmtMoney(cents) {
    const num = (Number(cents) || 0) / 100;
    return "S/ " + num.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // SQLite guarda datetime('now') en UTC sin decirlo — mismo fix que app.js
  // (toUtcISOString/fmtDateTime), duplicado acá por ser un archivo aparte.
  function toUtcISOString(s) {
    if (typeof s !== "string") return s;
    if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) return s;
    return s.replace(" ", "T") + "Z";
  }

  function fmtDateTime(iso) {
    if (!iso) return "—";
    try {
      return new Date(toUtcISOString(iso)).toLocaleString("es-PE", {
        timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
    } catch { return "—"; }
  }

  const STATUS_LABEL = { active: "Activo", disabled: "Deshabilitado" };
  const STATUS_CLASS = { active: "matched", disabled: "expired" }; // reusa .access-badge-*

  const LEDGER_TYPE_LABEL = {
    topup_yape:            "Recarga Yape",
    topup_manual_admin:    "Ajuste manual (+)",
    debit_manual_admin:    "Ajuste manual (-)",
    purchase_profile:      "Compra de perfil",
    purchase_full_account: "Cuenta completa",
    renewal:               "Renovación",
    wipe_inactive:         "Saldo borrado (inactividad)",
  };

  const QUEUE_STATUS_LABEL = { queued: "En cola", prepared: "Preparado", delivered: "Entregado", cancelled: "Cancelado" };

  // ─────────────────────────────────────────────────────────────
  // MENSAJES DE WHATSAPP — mismo tono informal que reminderMessage() en
  // app.js y los mensajes de access.js (emojis, negrita con asteriscos).
  // ─────────────────────────────────────────────────────────────

  function welcomeMessage(phone, password) {
    return `¡Bienvenido a la familia Manguitope! 🎉\n\n` +
      `Ya tienes tu acceso mayorista:\n` +
      `📱 Celular: *${phone}*\n` +
      `🔑 Contraseña: *${password}*\n\n` +
      `Entra a *mayorista.liordark.com* para comprar perfiles y cuentas completas con tu saldo.\n\n` +
      `¿Necesitas soporte? Escríbenos indicando la plataforma, qué cuenta es, y una captura del problema — así te ayudamos más rápido. 📸\n\n` +
      `⚠️ Importante: si pasa 1 mes sin ninguna compra o recarga, la cuenta se deshabilita y el saldo se borra. ¡No dejes que se te pase! 😉`;
  }

  function deliverMessage(order) {
    return `✅ *${order.platform}*\n\n📧 Correo: *${order.deliveredAccountEmail}*\n🔑 Contraseña: *${order.deliveredAccountPassword}*\n\n¡Disfruta tu cuenta! 🎉`;
  }

  // ─────────────────────────────────────────────────────────────
  // ESTADO EN MEMORIA
  // ─────────────────────────────────────────────────────────────

  let cachedWholesalers = [];
  let cachedQueue       = [];

  // ─────────────────────────────────────────────────────────────
  // LISTA DE MAYORISTAS
  // ─────────────────────────────────────────────────────────────

  function renderWholesalerRow(w) {
    const tr = document.createElement("tr");
    tr.dataset.id = w.id;
    tr.innerHTML = `
      <td>${escapeHtml(w.phone)}</td>
      <td>${escapeHtml(w.displayName)}</td>
      <td class="wholesaler-balance">${fmtMoney(w.balanceCents)}</td>
      <td><span class="badge access-badge-${STATUS_CLASS[w.status]}">${STATUS_LABEL[w.status]}</span></td>
      <td>${fmtDateTime(w.lastActivityAt)}</td>
      <td>
        <div class="table-actions">
          <button class="btn-secondary btn-sm ws-toggle-status-btn">${w.status === "active" ? "✏️ Deshabilitar" : "✏️ Habilitar"}</button>
          <button class="btn-secondary btn-sm ws-reset-password-btn">🔄 Resetear contraseña</button>
          <button class="btn-secondary btn-sm ws-adjust-btn">💰 Ajustar saldo</button>
          <button class="btn-secondary btn-sm ws-assign-btn">🎁 Asignar cuenta</button>
          <button class="btn-secondary btn-sm ws-clients-btn">👥 Ver cuentas</button>
          <button class="btn-secondary btn-sm ws-ledger-btn">📋 Ver historial</button>
        </div>
      </td>
    `;
    return tr;
  }

  function renderWholesalersList() {
    const tbody = document.getElementById("wholesalers-tbody");
    const empty = document.getElementById("wholesalers-empty");
    tbody.innerHTML = "";
    if (cachedWholesalers.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;
    for (const w of cachedWholesalers) tbody.appendChild(renderWholesalerRow(w));
  }

  function initWholesalersListActions() {
    document.getElementById("wholesalers-tbody").addEventListener("click", async (e) => {
      const tr = e.target.closest("tr");
      if (!tr) return;
      const w = cachedWholesalers.find(x => x.id === Number(tr.dataset.id));
      if (!w) return;

      if (e.target.closest(".ws-toggle-status-btn")) {
        const next = w.status === "active" ? "disabled" : "active";
        const verb = next === "disabled" ? "deshabilitar" : "habilitar";
        if (!confirm(`¿${verb.charAt(0).toUpperCase() + verb.slice(1)} a "${w.displayName}"?`)) return;
        try {
          await api("/" + w.id + "/status", { method: "PATCH", body: JSON.stringify({ status: next }) });
          await loadAll();
        } catch (err) { alert(err.message || "No se pudo cambiar el estado."); }
        return;
      }

      if (e.target.closest(".ws-reset-password-btn")) {
        if (!confirm(`¿Resetear la contraseña de "${w.displayName}"? La anterior deja de funcionar de inmediato.`)) return;
        try {
          const { password } = await api("/" + w.id + "/reset-password", { method: "POST" });
          openCredentialsModal(w, password, "Contraseña reseteada");
        } catch (err) { alert(err.message || "No se pudo resetear la contraseña."); }
        return;
      }

      if (e.target.closest(".ws-adjust-btn")) { openAdjustModal(w); return; }
      if (e.target.closest(".ws-assign-btn")) { openAssignModal(w); return; }
      if (e.target.closest(".ws-clients-btn")) { openClientsModal(w); return; }
      if (e.target.closest(".ws-ledger-btn"))  { openLedgerModal(w); return; }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // MODAL — nuevo mayorista
  // ─────────────────────────────────────────────────────────────

  function openNewModal() {
    document.getElementById("wholesaler-new-form").reset();
    document.getElementById("wholesaler-new-error").hidden = true;
    document.getElementById("wholesaler-new-modal").hidden = false;
  }

  function initNewModal() {
    document.getElementById("wholesaler-new-btn").addEventListener("click", openNewModal);
    document.getElementById("wholesaler-new-cancel").addEventListener("click", () => {
      document.getElementById("wholesaler-new-modal").hidden = true;
    });

    document.getElementById("wholesaler-new-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById("wholesaler-new-error");
      errorEl.hidden = true;
      const body = {
        phone:       document.getElementById("wholesaler-new-phone").value.trim(),
        displayName: document.getElementById("wholesaler-new-name").value.trim(),
      };
      try {
        const { wholesaler, password } = await api("/", { method: "POST", body: JSON.stringify(body) });
        document.getElementById("wholesaler-new-modal").hidden = true;
        await loadAll();
        openCredentialsModal(wholesaler, password, "Mayorista creado");
      } catch (err) {
        errorEl.textContent = err.message || "No se pudo crear el mayorista.";
        errorEl.hidden = false;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // MODAL — credenciales generadas (alta o reseteo, comparten modal)
  // ─────────────────────────────────────────────────────────────

  let credentialsCtx = null; // { phone, password }

  function openCredentialsModal(wholesaler, password, title) {
    credentialsCtx = { phone: wholesaler.phone, password };
    document.getElementById("wholesaler-credentials-title").textContent = title;
    document.getElementById("wholesaler-credentials-phone").textContent = wholesaler.phone;
    document.getElementById("wholesaler-credentials-password").textContent = password;
    document.getElementById("wholesaler-credentials-modal").hidden = false;
  }

  function initCredentialsModal() {
    document.getElementById("wholesaler-credentials-send-btn").addEventListener("click", () => {
      if (!credentialsCtx) return;
      window.open(waLink(credentialsCtx.phone, welcomeMessage(credentialsCtx.phone, credentialsCtx.password)), "_blank");
    });
  }

  // ─────────────────────────────────────────────────────────────
  // MODAL — ajustar saldo (+/-)
  // ─────────────────────────────────────────────────────────────

  let adjustTarget = null;

  function openAdjustModal(w) {
    adjustTarget = w;
    document.getElementById("wholesaler-adjust-title").textContent = `Ajustar saldo — ${w.displayName}`;
    document.getElementById("wholesaler-adjust-form").reset();
    document.getElementById("wholesaler-adjust-error").hidden = true;
    document.getElementById("wholesaler-adjust-modal").hidden = false;
  }

  function initAdjustModal() {
    document.getElementById("wholesaler-adjust-cancel").addEventListener("click", () => {
      document.getElementById("wholesaler-adjust-modal").hidden = true;
    });

    document.getElementById("wholesaler-adjust-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById("wholesaler-adjust-error");
      errorEl.hidden = true;
      if (!adjustTarget) return;

      const sign   = Number(document.getElementById("wholesaler-adjust-sign").value);
      const soles  = Number(document.getElementById("wholesaler-adjust-amount").value);
      const note   = document.getElementById("wholesaler-adjust-note").value.trim();
      const amountCents = sign * Math.round(soles * 100);

      try {
        await api("/" + adjustTarget.id + "/adjust-balance", {
          method: "POST", body: JSON.stringify({ amountCents, note }),
        });
        document.getElementById("wholesaler-adjust-modal").hidden = true;
        await loadAll();
      } catch (err) {
        errorEl.textContent = err.message || "No se pudo ajustar el saldo.";
        errorEl.hidden = false;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // MODAL — asignar cuenta a un cliente (venta ya cobrada por WhatsApp,
  // no descuenta saldo). "Desde stock" reusa el mismo criterio de
  // activación manual que la compra real (CANVA/GEMINI/YOUTUBE piden
  // correo a mano); "Cuenta completa" deja escribir cualquier plataforma.
  // ─────────────────────────────────────────────────────────────

  function isManualActivationPlatform(platform) {
    return /canva|gemini|youtube/i.test(platform);
  }
  function requiresPasswordPlatform(platform) {
    return /youtube/i.test(platform);
  }

  // Fecha por defecto para "Vence el" — hoy + N días, en formato yyyy-mm-dd
  // (el admin la ajusta a mano según cuándo compró realmente el cliente).
  function todayPlusDaysISO(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  let assignTarget = null;
  let platformCatalog = [];

  async function loadPlatformCatalog() {
    if (platformCatalog.length) return platformCatalog;
    try {
      const res = await fetch("/api/access/platforms-catalog", { credentials: "include" });
      const data = await res.json().catch(() => ({}));
      platformCatalog = data.platforms || [];
    } catch { platformCatalog = []; }
    return platformCatalog;
  }

  function populateAssignPlatformSelect() {
    const select = document.getElementById("wholesaler-assign-platform");
    select.innerHTML = platformCatalog
      .map(p => `<option value="${escapeHtml(p.platform)}">${escapeHtml(p.platform)}</option>`)
      .join("");
  }

  function updateAssignFieldsVisibility() {
    const mode = document.getElementById("wholesaler-assign-mode").value;
    const platform = document.getElementById("wholesaler-assign-platform").value;
    const forSelf = document.getElementById("wholesaler-assign-for-self").checked;
    const manualFields = document.getElementById("wholesaler-assign-manual-fields");
    const stockManualFields = document.getElementById("wholesaler-assign-stock-manual-fields");
    const stockPasswordLabel = document.getElementById("wholesaler-assign-stock-password-label");
    const stockExpiresWrap = document.getElementById("wholesaler-assign-stock-expires-wrap");
    const phoneWrap = document.getElementById("wholesaler-assign-phone-wrap");

    phoneWrap.hidden = forSelf;
    manualFields.hidden = mode !== "manual";
    stockManualFields.hidden = !(mode === "stock" && isManualActivationPlatform(platform));
    stockExpiresWrap.hidden = mode !== "stock";
    stockPasswordLabel.hidden = !requiresPasswordPlatform(platform);
  }

  // Precarga "Vence el" con hoy + el plazo típico de esa plataforma —
  // el admin la corrige si la compra fue hace unos días.
  function updateAssignExpiryDefaults() {
    const platform = document.getElementById("wholesaler-assign-platform").value;
    const days = /canva/i.test(platform) ? 365 : 30;
    document.getElementById("wholesaler-assign-expires").value = todayPlusDaysISO(days);
    document.getElementById("wholesaler-assign-stock-expires").value = todayPlusDaysISO(days);
  }

  async function openAssignModal(w) {
    assignTarget = w;
    document.getElementById("wholesaler-assign-title").textContent = `Asignar cuenta — ${w.displayName}`;
    document.getElementById("wholesaler-assign-form").reset();
    document.getElementById("wholesaler-assign-error").hidden = true;
    await loadPlatformCatalog();
    populateAssignPlatformSelect();
    updateAssignFieldsVisibility();
    updateAssignExpiryDefaults();
    document.getElementById("wholesaler-assign-modal").hidden = false;
  }

  function initAssignModal() {
    document.getElementById("wholesaler-assign-cancel").addEventListener("click", () => {
      document.getElementById("wholesaler-assign-modal").hidden = true;
    });
    document.getElementById("wholesaler-assign-mode").addEventListener("change", updateAssignFieldsVisibility);
    document.getElementById("wholesaler-assign-platform").addEventListener("change", () => {
      updateAssignFieldsVisibility();
      updateAssignExpiryDefaults();
    });
    document.getElementById("wholesaler-assign-for-self").addEventListener("change", updateAssignFieldsVisibility);

    document.getElementById("wholesaler-assign-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById("wholesaler-assign-error");
      errorEl.hidden = true;
      if (!assignTarget) return;

      const mode = document.getElementById("wholesaler-assign-mode").value;
      const platform = document.getElementById("wholesaler-assign-platform").value;
      const forSelf = document.getElementById("wholesaler-assign-for-self").checked;
      const body = { mode, platform, forSelf };
      if (!forSelf) {
        body.clientPhone = document.getElementById("wholesaler-assign-phone").value.trim();
      }

      if (mode === "manual") {
        body.email = document.getElementById("wholesaler-assign-email").value.trim();
        body.password = document.getElementById("wholesaler-assign-password").value.trim();
        body.expiresAt = document.getElementById("wholesaler-assign-expires").value;
      } else {
        // mode === "stock" — siempre manda la fecha (aplica incluso
        // sacando de stock: pisa el vencimiento heredado del pool con el
        // real de la compra). Si además es plataforma de activación
        // manual, también manda correo/contraseña.
        body.expiresAt = document.getElementById("wholesaler-assign-stock-expires").value;
        if (isManualActivationPlatform(platform)) {
          body.email = document.getElementById("wholesaler-assign-stock-email").value.trim();
          body.password = document.getElementById("wholesaler-assign-stock-password").value.trim();
        }
      }

      try {
        await api("/" + assignTarget.id + "/assign-account", { method: "POST", body: JSON.stringify(body) });
        document.getElementById("wholesaler-assign-modal").hidden = true;
        await loadAll();
      } catch (err) {
        errorEl.textContent = err.message || "No se pudo asignar la cuenta.";
        errorEl.hidden = false;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // MODAL — cuentas asignadas a los clientes de un mayorista (+ Renovar,
  // gratis — distinto del renovar del propio panel mayorista, que sí
  // descuenta saldo). Diferencia cuenta PROPIA del mayorista (clientPhone
  // == su mismo celular, ver "Es para el propio mayorista" en Asignar
  // cuenta) de una cuenta de un cliente suyo.
  // ─────────────────────────────────────────────────────────────

  function normalizePeruPhoneClient(raw) {
    const digits = String(raw ?? "").replace(/\D/g, "");
    return digits.length === 9 ? "51" + digits : digits;
  }

  let clientsTarget = null;

  function renderClientsRow(w, c) {
    const isOwn = normalizePeruPhoneClient(c.clientPhone) === normalizePeruPhoneClient(w.phone);
    const nonRenewable = /youtube/i.test(c.platform);
    const tr = document.createElement("tr");
    tr.dataset.profileId = c.id;
    tr.innerHTML = `
      <td>${escapeHtml(c.platform)}</td>
      <td>${isOwn ? `<span class="badge access-badge-matched">🧑‍💼 Cuenta propia</span>` : escapeHtml(c.clientPhone)}</td>
      <td>${fmtDateTime(c.expiresAt)}</td>
      <td>${nonRenewable ? "" : `<button class="btn-secondary btn-sm wc-renew-btn">🔄 Renovar</button>`}</td>
    `;
    return tr;
  }

  function renderClientsList(clients) {
    const tbody = document.getElementById("wholesaler-clients-tbody");
    const empty = document.getElementById("wholesaler-clients-empty");
    tbody.innerHTML = "";
    if (clients.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;
    for (const c of clients) tbody.appendChild(renderClientsRow(clientsTarget, c));
  }

  async function openClientsModal(w) {
    clientsTarget = w;
    document.getElementById("wholesaler-clients-title").textContent = `Cuentas asignadas — ${w.displayName}`;
    const tbody = document.getElementById("wholesaler-clients-tbody");
    const empty = document.getElementById("wholesaler-clients-empty");
    tbody.innerHTML = "";
    empty.hidden = true;
    document.getElementById("wholesaler-clients-modal").hidden = false;

    try {
      const { clients } = await api("/" + w.id + "/clients");
      renderClientsList(clients);
    } catch (err) {
      alert(err.message || "No se pudo cargar las cuentas.");
    }
  }

  function initClientsModal() {
    document.getElementById("wholesaler-clients-tbody").addEventListener("click", async (e) => {
      const btn = e.target.closest(".wc-renew-btn");
      if (!btn || !clientsTarget) return;
      const tr = btn.closest("tr");
      const profileId = tr.dataset.profileId;
      btn.disabled = true;
      try {
        await api("/" + clientsTarget.id + "/clients/" + profileId + "/renew", { method: "POST" });
        await openClientsModal(clientsTarget);
      } catch (err) {
        alert(err.message || "No se pudo renovar.");
        btn.disabled = false;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // MODAL — historial de saldo (ledger)
  // ─────────────────────────────────────────────────────────────

  function renderLedgerRow(entry) {
    const positive = entry.amountCents >= 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtDateTime(entry.createdAt)}</td>
      <td>${escapeHtml(LEDGER_TYPE_LABEL[entry.type] || entry.type)}</td>
      <td style="color: ${positive ? "var(--good)" : "var(--critical)"}">${positive ? "+" : ""}${fmtMoney(entry.amountCents)}</td>
      <td>${fmtMoney(entry.balanceAfterCents)}</td>
      <td class="text-muted">${escapeHtml(entry.reference || "—")}</td>
    `;
    return tr;
  }

  async function openLedgerModal(w) {
    document.getElementById("wholesaler-ledger-title").textContent = `Historial de saldo — ${w.displayName}`;
    const tbody = document.getElementById("wholesaler-ledger-tbody");
    const empty = document.getElementById("wholesaler-ledger-empty");
    tbody.innerHTML = "";
    empty.hidden = true;
    document.getElementById("wholesaler-ledger-modal").hidden = false;

    try {
      const { entries } = await api("/" + w.id + "/ledger");
      if (entries.length === 0) { empty.hidden = false; return; }
      for (const entry of entries) tbody.appendChild(renderLedgerRow(entry));
    } catch (err) {
      alert(err.message || "No se pudo cargar el historial.");
    }
  }

  // ─────────────────────────────────────────────────────────────
  // COLA DE CUENTAS COMPLETAS
  // ─────────────────────────────────────────────────────────────

  // "Vence" — cuenta regresiva desde dueBy (5h desde el pedido, ver
  // wholesale-full-account.repository.ts). Rojo si ya pasó, naranja si
  // falta menos de 1h, para que salte a la vista antes de incumplir.
  function dueInfo(dueBy) {
    const diffMs = new Date(dueBy).getTime() - Date.now();
    const absMin = Math.round(Math.abs(diffMs) / 60000);
    const h = Math.floor(absMin / 60);
    const m = absMin % 60;
    const hm = h > 0 ? `${h}h ${m}m` : `${m}m`;
    if (diffMs < 0) return { text: `Vencido hace ${hm}`, cls: "due-over" };
    if (diffMs < 60 * 60000) return { text: `Vence en ${hm}`, cls: "due-soon" };
    return { text: `Vence en ${hm}`, cls: "" };
  }

  function renderQueueRow(o) {
    const due = dueInfo(o.dueBy);
    const tr = document.createElement("tr");
    tr.dataset.id = o.id;

    let actions = "";
    if (o.status === "queued")   actions = `<button class="btn-secondary btn-sm wq-prepare-btn">✅ Preparar</button>`;
    if (o.status === "prepared") actions = `<button class="btn-secondary btn-sm wq-deliver-btn">📨 Entregar</button>`;

    tr.innerHTML = `
      <td>${escapeHtml(o.platform)}</td>
      <td>${o.quantity}</td>
      <td>${fmtMoney(o.totalCents)}</td>
      <td>${escapeHtml(o.endClientPhone)}</td>
      <td>${QUEUE_STATUS_LABEL[o.status] || o.status}</td>
      <td class="${due.cls}">${due.text}</td>
      <td>${actions}</td>
    `;
    return tr;
  }

  function renderQueueList() {
    const tbody = document.getElementById("wholesalers-queue-tbody");
    const empty = document.getElementById("wholesalers-queue-empty");
    tbody.innerHTML = "";
    if (cachedQueue.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;
    for (const o of cachedQueue) tbody.appendChild(renderQueueRow(o));
  }

  function initQueueActions() {
    document.getElementById("wholesalers-queue-tbody").addEventListener("click", (e) => {
      const tr = e.target.closest("tr");
      if (!tr) return;
      const order = cachedQueue.find(o => o.id === Number(tr.dataset.id));
      if (!order) return;

      if (e.target.closest(".wq-prepare-btn")) { openPrepareModal(order); return; }
      if (e.target.closest(".wq-deliver-btn")) { deliverOrder(order); return; }
    });
  }

  // ── preparar ──

  let prepareTarget = null;

  function openPrepareModal(order) {
    prepareTarget = order;
    document.getElementById("wholesaler-prepare-form").reset();
    document.getElementById("wholesaler-prepare-error").hidden = true;
    document.getElementById("wholesaler-prepare-modal").hidden = false;
  }

  function initPrepareModal() {
    document.getElementById("wholesaler-prepare-cancel").addEventListener("click", () => {
      document.getElementById("wholesaler-prepare-modal").hidden = true;
    });

    document.getElementById("wholesaler-prepare-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById("wholesaler-prepare-error");
      errorEl.hidden = true;
      if (!prepareTarget) return;

      const body = {
        email:    document.getElementById("wholesaler-prepare-email").value.trim(),
        password: document.getElementById("wholesaler-prepare-password").value.trim(),
      };
      try {
        await api("/full-account-queue/" + prepareTarget.id + "/prepare", { method: "POST", body: JSON.stringify(body) });
        document.getElementById("wholesaler-prepare-modal").hidden = true;
        await loadAll();
      } catch (err) {
        errorEl.textContent = err.message || "No se pudo preparar el pedido.";
        errorEl.hidden = false;
      }
    });
  }

  // ── entregar ──

  let deliverCtx = null; // { endClientPhone, order }

  async function deliverOrder(order) {
    if (!confirm(`¿Entregar la cuenta de "${order.platform}" al cliente ${order.endClientPhone}?`)) return;
    try {
      const { order: delivered } = await api("/full-account-queue/" + order.id + "/deliver", { method: "POST" });
      await loadAll();
      openDeliverModal(delivered);
    } catch (err) {
      alert(err.message || "No se pudo entregar el pedido.");
    }
  }

  function openDeliverModal(order) {
    deliverCtx = order;
    document.getElementById("wholesaler-deliver-platform").textContent = "✅ " + order.platform;
    document.getElementById("wholesaler-deliver-email").textContent = order.deliveredAccountEmail;
    document.getElementById("wholesaler-deliver-password").textContent = order.deliveredAccountPassword;
    document.getElementById("wholesaler-deliver-modal").hidden = false;
  }

  function initDeliverModal() {
    document.getElementById("wholesaler-deliver-send-btn").addEventListener("click", () => {
      if (!deliverCtx) return;
      window.open(waLink(deliverCtx.endClientPhone, deliverMessage(deliverCtx)), "_blank");
    });
  }

  // ─────────────────────────────────────────────────────────────
  // CARGA + INIT
  // ─────────────────────────────────────────────────────────────

  async function loadAll() {
    const [{ wholesalers }, { queue }] = await Promise.all([api("/"), api("/full-account-queue")]);
    cachedWholesalers = wholesalers;
    cachedQueue        = queue;
    renderWholesalersList();
    renderQueueList();
    updateQueueBadge();
  }

  // Número rojo en la pestaña "Mayoristas" — cuántas cuentas completas
  // pidieron y todavía no se preparan. Se revisa aparte de loadAll()
  // (más liviano, solo trae la cola) para que el admin lo vea sin tener
  // que entrar a la pestaña.
  function updateQueueBadge() {
    const badge = document.getElementById("wholesalers-pending-badge");
    if (!badge) return;
    const pending = cachedQueue.filter(o => o.status === "queued").length;
    badge.textContent = pending;
    badge.hidden = pending === 0;
  }

  const QUEUE_BADGE_POLL_MS = 20_000;

  async function pollQueueBadge() {
    try {
      const { queue } = await api("/full-account-queue");
      cachedQueue = queue;
      updateQueueBadge();
      const view = document.getElementById("view-wholesalers");
      if (view && !view.hidden) renderQueueList();
    } catch { /* red momentánea — se reintenta en el próximo tick */ }
  }

  let initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    initNewModal();
    initCredentialsModal();
    initAdjustModal();
    initAssignModal();
    initClientsModal();
    initWholesalersListActions();
    initPrepareModal();
    initDeliverModal();
    initQueueActions();

    pollQueueBadge();
    setInterval(pollQueueBadge, QUEUE_BADGE_POLL_MS);
  }

  window.LiordarkWholesalers = { init, load: loadAll };
})();
