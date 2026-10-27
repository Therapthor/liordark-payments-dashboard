(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // HELPERS (propios — este archivo no depende de app.js)
  // ─────────────────────────────────────────────────────────────

  async function api(path, options = {}) {
    const res = await fetch("/api/access" + path, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (res.status === 401) { location.reload(); throw new Error("No autenticado"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "Error de red");
    return data;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }


  function fmtDateLong(ymd) {
    if (!ymd) return "—";
    const [y, m, d] = ymd.split("-");
    return `${d}/${m}/${y}`;
  }

  function todayISO() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
  }

  function addDaysISO(dateISO, days) {
    const [y, m, d] = dateISO.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }

  // Estado de la CUENTA — compartido por todos sus clientes/perfiles.
  const STATUS_LABEL = { activo: "Activo", por_vencer: "Por vencer", vencido: "Vencido", sin_fecha: "Sin fecha" };
  const STATUS_CLASS = { activo: "matched", por_vencer: "pending", vencido: "expired", sin_fecha: "libre" };

  function daysLabel(status, days) {
    if (status === "sin_fecha" || days == null) return "—";
    if (days === 0) return "Vence hoy";
    if (days < 0) return Math.abs(days) + "d vencido";
    return days + "d restantes";
  }

  // ─────────────────────────────────────────────────────────────
  // MENSAJES DE WHATSAPP — mismo formato/emojis que las fórmulas
  // de Google Sheets, para no romper la costumbre de los clientes.
  // ─────────────────────────────────────────────────────────────

  // Celulares de Perú son siempre 9 dígitos — si viene sin el prefijo "51"
  // (dato guardado antes del fix, o cargado a mano sin el prefijo),
  // WhatsApp no puede abrir el chat correcto con solo esos 9 dígitos. Se
  // agrega acá para que los links funcionen ya mismo, sin esperar a
  // corregir el dato guardado.
  function waLink(phone, text) {
    let digits = String(phone).replace(/\D/g, "");
    if (digits.length === 9) digits = "51" + digits;
    return "https://api.whatsapp.com/send?phone=" + digits + "&text=" + encodeURIComponent(text);
  }

  function msgEntrega(p) {
    const perfilLine = p.profileName ? `\n👤 Perfil: *${p.profileName}*` : "";
    return `✅ *${p.platform}*\n\n📧 Correo: *${p.email}*\n🔑 Contraseña: *${p.password}*${perfilLine}\n⏳ Vencimiento: *${fmtDateLong(p.expiresAt)}*`;
  }
  function msgResumen(items) {
    const lines = items.map((it, i) => {
      const perfilLine = it.profileName ? `\n👤 Perfil: ${it.profileName}` : "";
      return `${i + 1}️⃣ *${it.platform}*${perfilLine}\n📧 Correo: ${it.email}\n🔑 Contraseña: ${it.password}\n⏳ Vence: ${fmtDateLong(it.expiresAt)} (${daysLabel(it.status, it.daysLeft)})`;
    }).join("\n\n");
    return `📋 *Resumen de tus cuentas*\n\n${lines}`;
  }

  /** Datos de perfil + cuenta combinados, tal como los necesitan los mensajes de WhatsApp. */
  function profileCtx(account, p) {
    return {
      id: p.id, accountId: account.id, platform: account.platform,
      email: account.email, password: account.password,
      profileName: p.profileName || "", clientPhone: p.clientPhone,
      expiresAt: account.expiresAt, daysLeft: account.daysLeft, status: account.status,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // ESTADO EN MEMORIA
  // ─────────────────────────────────────────────────────────────

  let currentProfileForModal   = null;
  let editingAccountId         = null;
  let editingAccountPlatform   = null;
  let platformCatalog          = [];
  let providerCatalog          = [];

  async function loadCatalog() {
    if (platformCatalog.length) return platformCatalog;
    try {
      const { platforms } = await api("/platforms-catalog");
      platformCatalog = platforms;
    } catch {
      platformCatalog = [];
    }
    return platformCatalog;
  }

  async function loadProviderCatalog() {
    if (providerCatalog.length) return providerCatalog;
    try {
      const { providers } = await api("/providers-catalog");
      providerCatalog = providers;
    } catch {
      providerCatalog = [];
    }
    return providerCatalog;
  }

  function populateProviderSelect(select, selected) {
    const options = providerCatalog.map(p =>
      `<option value="${escapeHtml(p.name)}" ${p.name === selected ? "selected" : ""}>${escapeHtml(p.name)}</option>`
    ).join("");
    select.innerHTML = `<option value="">— Sin proveedor —</option>` + options;
    if (selected && !providerCatalog.some(p => p.name === selected)) {
      select.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>`);
    }
  }

  function providerWhatsapp(name) {
    const found = providerCatalog.find(p => p.name.trim().toUpperCase() === String(name).trim().toUpperCase());
    return found?.whatsapp || "";
  }

  function populatePlatformSelect(select, selected) {
    select.innerHTML = platformCatalog.length
      ? platformCatalog.map(p =>
          `<option value="${escapeHtml(p.platform)}" ${p.platform === selected ? "selected" : ""}>${escapeHtml(p.platform)}</option>`
        ).join("")
      : `<option value="">No se pudo cargar el catálogo del bot</option>`;
  }

  // ─────────────────────────────────────────────────────────────
  // CARGA Y RENDER — plataformas / cuentas / perfiles
  // ─────────────────────────────────────────────────────────────

  let activePlatformDetail   = null; // plataforma cuyo detalle está abierto (o null)
  let activePlatformAccounts  = [];   // últimas cuentas cargadas para esa plataforma, para poder reordenar sin pedir de nuevo
  let platformSortDir        = "desc"; // "asc" = vencen primero, "desc" = más nuevas primero — se resetea a "desc" en openPlatformDetail()
  let openPlatformAccountIds = new Set(); // qué cuentas están abiertas — independiente del orden en que se dibujen
  let cachedPlatformSummaries = [];

  async function load() {
    loadProviderCatalog(); // se necesita para el botón 🔑 de soporte — no bloquea el render
    document.getElementById("access-client-summary").hidden = true;
    document.getElementById("access-search-results").hidden = true;
    document.getElementById("access-platform-detail").hidden = true;
    document.getElementById("access-platforms").hidden = false;
    activePlatformDetail = null;

    const { platforms } = await api("/platforms");
    cachedPlatformSummaries = platforms;
    const container = document.getElementById("access-platforms");
    const empty = document.getElementById("access-empty");

    if (platforms.length === 0) {
      container.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    container.innerHTML = platforms.map(p => renderPlatformCard(p)).join("");
    container.querySelectorAll(".access-platform-card").forEach(card => {
      card.addEventListener("click", () => openPlatformDetail(card.dataset.platform));
    });
  }

  function renderPlatformCard(p) {
    const free = p.sellableCount;
    return `
      <button type="button" class="access-platform-card" data-platform="${escapeHtml(p.platform)}">
        <span class="access-platform-card-name">${escapeHtml(p.platform)}</span>
        <span class="access-platform-count ${free > 0 ? "has-stock" : "no-stock"}">${free} disponible(s)</span>
        <span class="access-platform-card-stats">
          <span class="access-platform-card-stat">${p.accountCount} cuenta(s)</span>
          <span class="access-platform-card-stat">${p.occupiedCount} cliente(s)</span>
        </span>
      </button>
    `;
  }

  // Detalle de UNA plataforma — todas sus cuentas y clientes, ya abiertos
  // (antes había que ir abriendo cuenta por cuenta), con un botón para
  // compactar todo de nuevo y ver más de un vistazo.
  async function openPlatformDetail(platform) {
    activePlatformDetail = platform;
    platformSortDir = "desc";
    document.getElementById("access-platforms").hidden = true;
    document.getElementById("access-platform-detail").hidden = false;
    document.getElementById("access-platform-detail-title").textContent = platform;
    document.getElementById("access-platform-compact-toggle").textContent = "🗜 Compactar todo";
    updateSortToggleLabel();

    const target = document.getElementById("access-platform-detail-accounts");
    target.innerHTML = `<p class="feed-empty">Cargando…</p>`;
    const { accounts } = await api("/platforms/" + encodeURIComponent(platform) + "/accounts");
    activePlatformAccounts = accounts;
    openPlatformAccountIds = new Set(accounts.map(a => String(a.id))); // abiertas por defecto, como antes
    renderPlatformAccounts();
  }

  // Vencen primero (asc) = las que hay que atender ya; más nuevas primero
  // (desc) = las que se acaban de agregar (suelen ser las que vencen más
  // lejos, por eso sirve el mismo orden invertido para las dos vistas).
  function sortedPlatformAccounts() {
    const sign = platformSortDir === "asc" ? 1 : -1;
    return [...activePlatformAccounts].sort((a, b) => {
      if (!a.expiresAt && !b.expiresAt) return 0;
      if (!a.expiresAt) return 1;
      if (!b.expiresAt) return -1;
      return sign * a.expiresAt.localeCompare(b.expiresAt);
    });
  }

  function updateSortToggleLabel() {
    const btn = document.getElementById("access-platform-sort-toggle");
    if (!btn) return;
    btn.textContent = platformSortDir === "asc" ? "↓ Vencen primero" : "↑ Más nuevas primero";
  }

  // Qué tarjetas quedan abiertas/cerradas es independiente del orden —
  // se guarda en openPlatformAccountIds (no se infiere del DOM) para que
  // reordenar no las vuelva a abrir ni las cierre solas.
  function renderPlatformAccounts() {
    const target = document.getElementById("access-platform-detail-accounts");
    target.innerHTML = sortedPlatformAccounts()
      .map(a => renderAccountCard(a, { open: openPlatformAccountIds.has(String(a.id)) }))
      .join("");
    target.querySelectorAll(".access-account").forEach(details => {
      details.addEventListener("toggle", () => {
        const id = details.dataset.accountId;
        if (details.open) openPlatformAccountIds.add(id);
        else openPlatformAccountIds.delete(id);
      });
    });
    wireAccountCardEvents(target);
  }

  function togglePlatformSort() {
    platformSortDir = platformSortDir === "asc" ? "desc" : "asc";
    updateSortToggleLabel();
    renderPlatformAccounts();
  }

  function closePlatformDetail() {
    load();
  }

  function togglePlatformCompact() {
    const target = document.getElementById("access-platform-detail-accounts");
    const items  = target.querySelectorAll(".access-account");
    const anyOpen = Array.from(items).some(d => d.open);
    items.forEach(d => {
      d.open = !anyOpen;
      if (d.open) openPlatformAccountIds.add(d.dataset.accountId);
      else openPlatformAccountIds.delete(d.dataset.accountId);
    });
    document.getElementById("access-platform-compact-toggle").textContent =
      anyOpen ? "⬜ Expandir todo" : "🗜 Compactar todo";
  }

  // Reemplaza en el DOM solo la tarjeta de esta cuenta, sin recargar todo
  // el acordeón — recargar todo cerraba las plataformas que el admin tenía
  // abiertas cada vez que asignaba un cliente, liberaba un perfil, etc.
  async function refreshAccountInPlace(accountId, platformHint) {
    const container = activeQuery
      ? document.getElementById("access-search-results")
      : document.getElementById("access-platform-detail-accounts");
    const el = container.querySelector(`.access-account[data-account-id="${accountId}"]`);
    if (!el) { await refresh(); return; }
    const wasOpen = el.open;

    const { account } = await api("/accounts/" + accountId);
    const wrapper = document.createElement("div");
    wrapper.innerHTML = renderAccountCard(account, { open: wasOpen }).trim();
    const newEl = wrapper.firstElementChild;
    el.replaceWith(newEl);
    wireAccountCardEvents(newEl);

    refreshPlatformSummaryText(platformHint || account.platform);
  }

  // Actualiza solo la tarjeta de la plataforma en la grilla (stock/cuentas/
  // clientes) sin recargar ni cerrar el detalle que esté abierto.
  async function refreshPlatformSummaryText(platform) {
    try {
      const { platforms } = await api("/platforms");
      cachedPlatformSummaries = platforms;
      const info = platforms.find(p => p.platform === platform);
      if (!info) return;
      const card = document.querySelector(`.access-platform-card[data-platform="${CSS.escape(platform)}"]`);
      if (card) card.outerHTML = renderPlatformCard(info);
      const newCard = document.querySelector(`.access-platform-card[data-platform="${CSS.escape(platform)}"]`);
      if (newCard) newCard.addEventListener("click", () => openPlatformDetail(newCard.dataset.platform));
    } catch { /* no crítico */ }
  }

  // Cada cuenta es un <details> propio, cerrado por defecto — antes se
  // mostraban todas las tarjetas completas (con tabla y botones) de una
  // vez, y con varias cuentas por plataforma eso llenaba la pantalla de
  // scroll. Ahora solo se ve una línea resumen por cuenta hasta que se
  // abre la que interesa.
  // Renovar en dos pasos: "Renovar" solo marca pendiente de pago; recién
  // "Confirmar pago" suma los 30 días de verdad. Así queda registro de que
  // el cliente pagó antes de extender la cuenta, en vez de fiarse del clic.
  function renderRenewControls(account) {
    if (account.renewalPendingAt) {
      return `
        <button class="btn-primary btn-sm access-renew-confirm" data-account-id="${account.id}">✅ Confirmar pago</button>
        <button class="btn-secondary btn-sm access-renew-cancel" data-account-id="${account.id}">✕ Cancelar</button>
      `;
    }
    return `<button class="btn-secondary btn-sm access-renew-account" data-account-id="${account.id}">🔄 Renovar</button>`;
  }

  function renderAccountCard(account, opts) {
    const open = !!(opts && opts.open);
    const rows = account.profiles.map(p => renderProfileRow(account, p)).join("");
    const occupiedCount = account.profiles.filter(p => p.clientPhone).length;
    const renewingCount = account.profiles.filter(p => p.clientPhone && p.renewalStatus === "yes").length;
    const accountAttr = JSON.stringify(account).replace(/"/g, "&quot;");
    const occupancyLabel = account.hasProfiles
      ? `${occupiedCount}/${account.profiles.length} ocupado(s)`
      : (occupiedCount > 0 ? "🔒 Ocupada" : "🟢 Libre");

    return `
      <details class="access-account" data-account-id="${account.id}" data-platform="${escapeHtml(account.platform)}"${open ? " open" : ""}>
        <summary class="access-account-summary">
          <span class="access-account-summary-email">📧 ${escapeHtml(account.email)}</span>
          <span class="access-account-meta">
            ${account.provider ? `<span>🏷 ${escapeHtml(account.provider)}</span>` : ""}
            <span class="badge access-badge-${STATUS_CLASS[account.status]}">${STATUS_LABEL[account.status]}</span>
            ${account.renewalPendingAt ? `<span class="badge access-badge-pending" title="Renovar: pendiente de pago">⏳ Pendiente de pago</span>` : ""}
            <span>${fmtDateLong(account.expiresAt)} · ${daysLabel(account.status, account.daysLeft)}</span>
            <span class="access-occupancy">${occupancyLabel}</span>
          </span>
          <span class="access-account-summary-actions">
            <button type="button" class="btn-secondary btn-sm access-provider-support" data-account="${accountAttr}" title="Pedir soporte al proveedor por WhatsApp">🔑 Soporte</button>
            <button type="button" class="btn-secondary btn-sm access-provider-renew-request" data-account="${accountAttr}" title="Pedir al proveedor que renueve esta cuenta">🔁 Renovar proveedor</button>
          </span>
        </summary>
        <div class="access-account-body">
          <div class="access-account-head">
            <div class="access-account-info">
              <div class="access-account-email">
                🔑 <span class="access-pw-mask">••••••••</span>
                <span class="access-pw-real" hidden>${escapeHtml(account.password)}</span>
                <button class="icon-btn-sm access-toggle-pw" title="Mostrar/ocultar contraseña">👁</button>
              </div>
            </div>
            <div class="access-account-actions">
              ${occupiedCount > 0 ? `<button class="btn-secondary btn-sm access-send-all" data-account="${accountAttr}">🔄 Enviar reemplazo a todos (${occupiedCount})</button>` : ""}
              ${occupiedCount > 0 ? `<button class="btn-secondary btn-sm access-password-all" data-account="${accountAttr}">🔑 Cambiar contraseña a todos</button>` : ""}
              ${account.link ? `<button class="btn-secondary btn-sm access-open-link" data-link="${escapeHtml(account.link)}">🔗 Abrir enlace</button>` : ""}
              <button class="btn-secondary btn-sm access-copy-account" data-account="${accountAttr}">📋 Copiar datos</button>
              <button class="btn-secondary btn-sm access-copy-credentials" data-account="${accountAttr}">📋 Copiar cuenta</button>
              ${renderRenewControls(account)}
              ${renewingCount > 0 ? `<button class="btn-secondary btn-sm access-renew-new" data-account-id="${account.id}" data-renewing-count="${renewingCount}">🆕 Renovar (cuenta nueva) — ${renewingCount}</button>` : ""}
              <button class="btn-secondary btn-sm access-edit-account" data-account-id="${account.id}">✏️ Editar cuenta</button>
              <button class="btn-secondary btn-sm access-delete-account" data-account-id="${account.id}">🗑 Eliminar cuenta</button>
            </div>
          </div>
          <table class="access-table">
            <thead><tr>${account.hasProfiles ? "<th>Perfil</th>" : ""}<th>Teléfono</th><th title="¿Confirmó que renueva?">Renueva</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </details>
    `;
  }

  // Marcador de renovación — informativo, no toca el vencimiento. Cicla
  // sin marcar → renueva → no renueva → sin marcar, con un solo botón
  // chico para no ensuciar la fila.
  const RENEWAL_ICON = { "": "➖", yes: "✅", no: "❌" };
  const RENEWAL_NEXT = { "": "yes", yes: "no", no: "" };
  const RENEWAL_TITLE = { "": "Marcar si renueva", yes: "Renueva — clic para marcar que no", no: "No renueva — clic para dejar sin marcar" };

  function renderRenewalButton(p) {
    const status = p.renewalStatus || "";
    return `<button class="row-renewal renewal-${status || "unset"}" data-profile-id="${p.id}" data-status="${status}" title="${RENEWAL_TITLE[status]}">${RENEWAL_ICON[status]}</button>`;
  }

  function renderProfileRow(account, p) {
    const occupied       = !!p.clientPhone;
    // wholesalerId != null = ya es stock de un mayorista (ver
    // assignProfilesToWholesaler) — no se vende como retail aunque esté
    // "libre" de cliente todavía.
    const wholesaleOwned = p.wholesalerId != null;
    const ctx = JSON.stringify(profileCtx(account, p)).replace(/"/g, "&quot;");

    let actions;
    if (occupied) {
      actions = `
        <button class="row-action" data-act="send" data-ctx="${ctx}" title="Enviar cuenta">📧</button>
        <button class="row-action" data-act="edit" data-ctx="${ctx}" title="Cambiar teléfono">✏️</button>
        <button class="row-action" data-act="release" data-ctx="${ctx}" title="Liberar perfil">🗑</button>
      `;
    } else if (wholesaleOwned) {
      actions = `<span class="profile-wholesale-tag">🏪 Stock mayorista</span>`;
    } else {
      actions = `<button class="row-action" data-act="edit" data-ctx="${ctx}" title="Asignar cliente">➕ Asignar</button>`;
    }

    const cells = [];
    if (account.hasProfiles) cells.push(`<td>${escapeHtml(p.profileName || ("Perfil " + p.slotNumber))}</td>`);
    cells.push(`<td>${occupied ? escapeHtml(p.clientPhone) : "<span class=\"text-muted\">Libre</span>"}</td>`);
    cells.push(`<td>${occupied ? renderRenewalButton(p) : ""}</td>`);
    cells.push(`<td class="access-row-actions">${actions}</td>`);

    const rowClass = wholesaleOwned ? ` class="profile-row-wholesale"` : "";
    return `<tr data-profile-id="${p.id}"${rowClass}>${cells.join("")}</tr>`;
  }

  function wireAccountCardEvents(target) {
    target.querySelectorAll(".access-toggle-pw").forEach(btn => {
      btn.addEventListener("click", () => {
        const cell = btn.closest(".access-account-email");
        const mask = cell.querySelector(".access-pw-mask");
        const real = cell.querySelector(".access-pw-real");
        const showing = !real.hidden;
        real.hidden = showing;
        mask.hidden = !showing;
        btn.textContent = showing ? "👁" : "🙈";
      });
    });

    target.querySelectorAll(".access-send-all").forEach(btn => {
      btn.addEventListener("click", () => notifyReplacementAll(btn, JSON.parse(btn.dataset.account.replace(/&quot;/g, '"'))));
    });

    target.querySelectorAll(".access-password-all").forEach(btn => {
      btn.addEventListener("click", () => notifyPasswordChangeAll(btn, JSON.parse(btn.dataset.account.replace(/&quot;/g, '"'))));
    });

    target.querySelectorAll(".access-open-link").forEach(btn => {
      btn.addEventListener("click", () => window.open(btn.dataset.link, "_blank"));
    });

    target.querySelectorAll(".row-renewal").forEach(btn => {
      btn.addEventListener("click", async () => {
        const next = RENEWAL_NEXT[btn.dataset.status || ""];
        await api("/profiles/" + btn.dataset.profileId + "/renewal", { method: "POST", body: JSON.stringify({ status: next }) });
        btn.dataset.status = next;
        btn.className = "row-renewal renewal-" + (next || "unset");
        btn.title = RENEWAL_TITLE[next];
        btn.textContent = RENEWAL_ICON[next];
      });
    });

    target.querySelectorAll(".access-copy-account").forEach(btn => {
      btn.addEventListener("click", () => copyAccountData(btn, JSON.parse(btn.dataset.account.replace(/&quot;/g, '"'))));
    });

    target.querySelectorAll(".access-copy-credentials").forEach(btn => {
      btn.addEventListener("click", () => copyAccountCredentials(btn, JSON.parse(btn.dataset.account.replace(/&quot;/g, '"'))));
    });

    // Soporte / renovación con proveedor viven en el <summary>, que no se
    // cierra al compactar — sin esto, el clic en el botón también
    // dispararía el toggle nativo de abrir/cerrar la tarjeta.
    target.querySelectorAll(".access-provider-support").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const account = JSON.parse(btn.dataset.account.replace(/&quot;/g, '"'));
        await loadProviderCatalog();
        if (!account.provider) {
          alert("Esta cuenta no tiene proveedor asignado. Edítala y elige uno primero.");
          return;
        }
        const phone = providerWhatsapp(account.provider);
        if (!phone) {
          alert(`No hay WhatsApp guardado para "${account.provider}". Agrégalo en Configuración > Proveedores.`);
          return;
        }
        const msg = `Hola! Necesito soporte con una cuenta de *${account.platform}*.\n📧 Correo: ${account.email}`;
        window.open(waLink(phone, msg), "_blank");
      });
    });

    target.querySelectorAll(".access-provider-renew-request").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const account = JSON.parse(btn.dataset.account.replace(/&quot;/g, '"'));
        await loadProviderCatalog();
        if (!account.provider) {
          alert("Esta cuenta no tiene proveedor asignado. Edítala y elige uno primero.");
          return;
        }
        const phone = providerWhatsapp(account.provider);
        if (!phone) {
          alert(`No hay WhatsApp guardado para "${account.provider}". Agrégalo en Configuración > Proveedores.`);
          return;
        }
        const msg = `Hola! Necesito que renueves esta cuenta de *${account.platform}*.\n📧 Correo: ${account.email}\n🔑 Contraseña: ${account.password}`;
        window.open(waLink(phone, msg), "_blank");
      });
    });

    target.querySelectorAll(".access-renew-account").forEach(btn => {
      btn.addEventListener("click", async () => {
        const accountId = Number(btn.dataset.accountId);
        await api("/accounts/" + accountId + "/renewal-pending", { method: "POST" });
        refreshAccountInPlace(accountId);
      });
    });

    target.querySelectorAll(".access-renew-confirm").forEach(btn => {
      btn.addEventListener("click", async () => {
        const accountId = Number(btn.dataset.accountId);
        await api("/accounts/" + accountId + "/renew", { method: "POST" });
        refreshAccountInPlace(accountId);
      });
    });

    target.querySelectorAll(".access-renew-cancel").forEach(btn => {
      btn.addEventListener("click", async () => {
        const accountId = Number(btn.dataset.accountId);
        await api("/accounts/" + accountId + "/renewal-pending/cancel", { method: "POST" });
        refreshAccountInPlace(accountId);
      });
    });

    target.querySelectorAll(".access-renew-new").forEach(btn => {
      btn.addEventListener("click", () => openRenewNewModal(Number(btn.dataset.accountId), Number(btn.dataset.renewingCount)));
    });

    target.querySelectorAll(".access-edit-account").forEach(btn => {
      btn.addEventListener("click", () => openEditModal(Number(btn.dataset.accountId)));
    });
    target.querySelectorAll(".access-delete-account").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("¿Eliminar esta cuenta y todos sus perfiles? Esta acción no se puede deshacer.")) return;
        const el = btn.closest(".access-account");
        const platform = el?.dataset.platform;
        await api("/accounts/" + btn.dataset.accountId, { method: "DELETE" });
        // Se quita solo esa tarjeta del DOM — recargar todo el acordeón
        // lo cerraba de nuevo, igual que pasaba con las otras acciones.
        el?.remove();
        if (platform) refreshPlatformSummaryText(platform);
      });
    });

    target.querySelectorAll(".row-action").forEach(btn => {
      btn.addEventListener("click", () => handleRowAction(btn.dataset.act, JSON.parse(btn.dataset.ctx.replace(/&quot;/g, '"'))));
    });
  }

  function handleRowAction(act, ctx) {
    if (act === "send")    return window.open(waLink(ctx.clientPhone, msgEntrega(ctx)), "_blank");
    if (act === "edit")    return openProfileModal(ctx);
    if (act === "release") return releaseProfile(ctx.id, ctx.accountId);
  }

  async function releaseProfile(profileId, accountId) {
    await api("/profiles/" + profileId + "/release", { method: "POST" });
    refreshAccountInPlace(accountId);
  }

  // ─────────────────────────────────────────────────────────────
  // COPIAR DATOS DE CUENTA — para reportar al proveedor
  // ─────────────────────────────────────────────────────────────

  function accountDataText(account) {
    return `🛒 *${account.platform}*\n📧 Correo: ${account.email}\n🔑 Contraseña: ${account.password}\n⏳ Vencimiento: ${fmtDateLong(account.expiresAt)}`;
  }

  // Solo correo:contraseña — para pegar directo donde haga falta ese
  // formato (ej. un login), sin el resto de datos de accountDataText.
  function accountCredentialsText(account) {
    return `${account.email}:${account.password}`;
  }

  function copyToClipboard(btn, text) {
    const done = () => {
      const original = btn.textContent;
      btn.textContent = "✅ Copiado";
      setTimeout(() => { btn.textContent = original; }, 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => alert("No se pudo copiar:\n\n" + text));
    } else {
      alert("Copia manualmente:\n\n" + text);
    }
  }

  function copyAccountData(btn, account) {
    copyToClipboard(btn, accountDataText(account));
  }

  function copyAccountCredentials(btn, account) {
    copyToClipboard(btn, accountCredentialsText(account));
  }

  // ─────────────────────────────────────────────────────────────
  // REEMPLAZO — SOLO masivo (a todos los perfiles con cliente asignado),
  // y SOLO por la campanita de notificaciones, nunca por WhatsApp (mismo
  // criterio que notifyPasswordChangeAll). El correo/contraseña nuevos ya
  // están guardados en la cuenta (se editan aparte, en "✏️ Editar
  // cuenta") — acá solo se avisa.
  // ─────────────────────────────────────────────────────────────

  async function notifyReplacementAll(btn, account) {
    const occupiedCount = account.profiles.filter(p => p.clientPhone).length;
    if (occupiedCount === 0) return;
    if (!confirm(
      `¿Avisar el reemplazo de ${account.platform} (${account.email}) a los ${occupiedCount} cliente(s) con esta cuenta?\n\n` +
      `Se les llega por su campanita de notificaciones, no por WhatsApp.`
    )) return;

    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Avisando…";
    try {
      await api("/accounts/" + account.id + "/notify-replacement", { method: "POST" });
    } catch (err) {
      alert(err.message || "No se pudo avisar el reemplazo.");
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // MODAL — agregar cuentas en lote (correo:contraseña)
  // ─────────────────────────────────────────────────────────────

  async function openBulkModal() {
    await Promise.all([loadCatalog(), loadProviderCatalog()]);
    document.getElementById("bulk-form").reset();
    document.getElementById("bulk-error").hidden = true;
    populatePlatformSelect(document.getElementById("bulk-platform"));
    populateProviderSelect(document.getElementById("bulk-provider"));
    document.getElementById("bulk-expires").value = addDaysISO(todayISO(), 30);
    document.getElementById("bulk-expires").min = todayISO();
    document.getElementById("bulk-renewal-fields").hidden = true;
    document.getElementById("bulk-modal").hidden = false;
  }

  function initBulkModal() {
    document.getElementById("access-new-account-btn").addEventListener("click", openBulkModal);
    document.getElementById("bulk-cancel").addEventListener("click", () => { document.getElementById("bulk-modal").hidden = true; });

    document.getElementById("bulk-renewal-enabled").addEventListener("change", (e) => {
      document.getElementById("bulk-renewal-fields").hidden = !e.target.checked;
    });

    document.getElementById("bulk-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const renewalEnabled = document.getElementById("bulk-renewal-enabled").checked;
      const body = {
        platform:  document.getElementById("bulk-platform").value,
        provider:  document.getElementById("bulk-provider").value,
        expiresAt: document.getElementById("bulk-expires").value,
        lines:     document.getElementById("bulk-lines").value,
        providerRenewalEnabled:    renewalEnabled,
        providerRenewalCost:       renewalEnabled ? document.getElementById("bulk-renewal-cost").value : "",
        providerRenewalCurrency:   document.getElementById("bulk-renewal-currency").value,
        providerRenewalNextDate:   renewalEnabled ? document.getElementById("bulk-renewal-next-date").value : null,
      };
      const errorEl = document.getElementById("bulk-error");
      errorEl.hidden = true;
      try {
        await api("/accounts/bulk", { method: "POST", body: JSON.stringify(body) });
        document.getElementById("bulk-modal").hidden = true;
        refresh();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // MODAL — editar cuenta existente
  // ─────────────────────────────────────────────────────────────

  async function openEditModal(accountId) {
    await Promise.all([loadCatalog(), loadProviderCatalog()]);
    editingAccountId = accountId;
    document.getElementById("account-edit-form").reset();
    document.getElementById("account-edit-error").hidden = true;

    const { account } = await api("/accounts/" + accountId);
    editingAccountPlatform = account.platform;
    populatePlatformSelect(document.getElementById("account-edit-platform"), account.platform);
    document.getElementById("account-edit-email").value = account.email;
    document.getElementById("account-edit-password").value = account.password;
    populateProviderSelect(document.getElementById("account-edit-provider"), account.provider);
    document.getElementById("account-edit-expires").value = account.expiresAt || "";
    document.getElementById("account-edit-link").value = account.link || "";
    document.getElementById("account-edit-renewal-enabled").checked = !!account.providerRenewalEnabled;
    document.getElementById("account-edit-renewal-fields").hidden = !account.providerRenewalEnabled;
    document.getElementById("account-edit-renewal-cost").value = account.providerRenewalCost || "";
    document.getElementById("account-edit-renewal-currency").value = account.providerRenewalCurrency || "USDT";
    document.getElementById("account-edit-renewal-next-date").value = account.providerRenewalNextDate || "";
    document.getElementById("account-edit-modal").hidden = false;
  }

  function initEditModal() {
    document.getElementById("account-edit-cancel").addEventListener("click", () => { document.getElementById("account-edit-modal").hidden = true; });

    document.getElementById("account-edit-renewal-enabled").addEventListener("change", (e) => {
      document.getElementById("account-edit-renewal-fields").hidden = !e.target.checked;
    });

    document.getElementById("account-edit-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const renewalEnabled = document.getElementById("account-edit-renewal-enabled").checked;
      const body = {
        platform:  document.getElementById("account-edit-platform").value,
        email:     document.getElementById("account-edit-email").value,
        password:  document.getElementById("account-edit-password").value,
        provider:  document.getElementById("account-edit-provider").value,
        expiresAt: document.getElementById("account-edit-expires").value,
        link:      document.getElementById("account-edit-link").value,
        providerRenewalEnabled:  renewalEnabled,
        providerRenewalCost:     renewalEnabled ? document.getElementById("account-edit-renewal-cost").value : "",
        providerRenewalCurrency: document.getElementById("account-edit-renewal-currency").value,
        providerRenewalNextDate: renewalEnabled ? document.getElementById("account-edit-renewal-next-date").value : null,
      };
      const errorEl = document.getElementById("account-edit-error");
      errorEl.hidden = true;
      try {
        await api("/accounts/" + editingAccountId, { method: "PUT", body: JSON.stringify(body) });
        document.getElementById("account-edit-modal").hidden = true;
        // Si cambió de plataforma, la tarjeta se mueve de acordeón — ahí sí
        // hace falta recargar todo. Si no, se actualiza sin cerrar nada.
        if (body.platform === editingAccountPlatform) {
          await refreshAccountInPlace(editingAccountId, editingAccountPlatform);
        } else {
          await refresh();
        }
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // MODAL — asignar/cambiar el teléfono de un perfil
  // ─────────────────────────────────────────────────────────────

  function openProfileModal(ctx) {
    currentProfileForModal = ctx;
    document.getElementById("profile-form").reset();
    document.getElementById("profile-error").hidden = true;
    document.getElementById("profile-modal-title").textContent = ctx.clientPhone ? "Cambiar teléfono" : "Asignar cliente";
    document.getElementById("profile-client-phone").value = ctx.clientPhone || "";
    document.getElementById("profile-modal").hidden = false;
  }

  function initProfileModal() {
    document.getElementById("profile-cancel").addEventListener("click", () => { document.getElementById("profile-modal").hidden = true; });

    document.getElementById("profile-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = { clientPhone: document.getElementById("profile-client-phone").value };
      const errorEl = document.getElementById("profile-error");
      errorEl.hidden = true;
      try {
        await api("/profiles/" + currentProfileForModal.id, { method: "PUT", body: JSON.stringify(body) });
        document.getElementById("profile-modal").hidden = true;
        refreshAccountInPlace(currentProfileForModal.accountId);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // CAMBIO DE CONTRASEÑA — SOLO masivo (a todos los perfiles con cliente
  // asignado). Usa la contraseña que la cuenta YA tiene guardada (se edita
  // aparte, en "✏️ Editar cuenta", ANTES de tocar este botón) — ya no pide
  // escribirla de nuevo acá. Avisa por la campanita de notificaciones de
  // cada cliente/mayorista, no por WhatsApp.
  // ─────────────────────────────────────────────────────────────

  async function notifyPasswordChangeAll(btn, account) {
    const occupiedCount = account.profiles.filter(p => p.clientPhone).length;
    if (occupiedCount === 0) return;
    if (!confirm(
      `¿Avisar la contraseña actual de ${account.platform} (${account.email}) a los ${occupiedCount} cliente(s) con esta cuenta?\n\n` +
      `Se les llega por su campanita de notificaciones, no por WhatsApp.`
    )) return;

    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Avisando…";
    try {
      await api("/accounts/" + account.id + "/notify-password-change", { method: "POST" });
    } catch (err) {
      alert(err.message || "No se pudo avisar el cambio de contraseña.");
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // MODAL — renovar con cuenta nueva
  //
  // Crea una cuenta aparte y le pasa solo los clientes de la cuenta vieja
  // marcados "✅ Renueva". No manda WhatsApp ni toca el bot todavía — es
  // la base para cuando se traspase todo al panel/bot más adelante.
  // ─────────────────────────────────────────────────────────────

  let renewNewAccountId = null;

  function openRenewNewModal(accountId, renewingCount) {
    renewNewAccountId = accountId;

    document.getElementById("renew-new-hint").textContent =
      `Se creará una cuenta nueva y se le pasarán los ${renewingCount} cliente(s) marcados "✅ Renueva" de esta cuenta. El resto se queda como está.`;
    document.getElementById("renew-new-email").value    = "";
    document.getElementById("renew-new-password").value = "";
    document.getElementById("renew-new-expires").value  = addDaysISO(todayISO(), 30);
    document.getElementById("renew-new-error").hidden = true;
    document.getElementById("renew-new-modal").hidden = false;
  }

  function initRenewNewModal() {
    document.getElementById("renew-new-cancel").addEventListener("click", () => {
      document.getElementById("renew-new-modal").hidden = true;
    });

    document.getElementById("renew-new-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById("renew-new-error");
      errorEl.hidden = true;

      const body = {
        email:     document.getElementById("renew-new-email").value.trim(),
        password:  document.getElementById("renew-new-password").value.trim(),
        expiresAt: document.getElementById("renew-new-expires").value,
      };

      try {
        await api("/accounts/" + renewNewAccountId + "/renew-new", { method: "POST", body: JSON.stringify(body) });
        document.getElementById("renew-new-modal").hidden = true;
        await refresh();
      } catch (err) {
        errorEl.textContent = err.message || "No se pudo crear la cuenta nueva.";
        errorEl.hidden = false;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // BUSCADOR — cuenta por correo / cliente por teléfono
  // ─────────────────────────────────────────────────────────────

  let searchDebounce = null;
  let lastClientProfiles = [];
  let activeQuery = "";

  /** Refresca la vista actual (búsqueda activa, o el acordeón completo). */
  function refresh() {
    return activeQuery ? runSearch(activeQuery) : load();
  }

  function initSearch() {
    const input = document.getElementById("access-search-input");
    const clearBtn = document.getElementById("access-search-clear");

    input.addEventListener("input", () => {
      clearTimeout(searchDebounce);
      const q = input.value.trim();
      clearBtn.hidden = !q;
      if (!q) { resetSearch(); return; }
      searchDebounce = setTimeout(() => runSearch(q), 300);
    });

    clearBtn.addEventListener("click", () => {
      input.value = "";
      clearBtn.hidden = true;
      resetSearch();
    });
  }

  function resetSearch() {
    activeQuery = "";
    document.getElementById("access-client-summary").hidden = true;
    document.getElementById("access-search-results").hidden = true;
    document.getElementById("access-platform-detail").hidden = true;
    document.getElementById("access-platforms").hidden = false;
    activePlatformDetail = null;
  }

  async function runSearch(q) {
    activeQuery = q;
    activePlatformDetail = null;
    document.getElementById("access-platform-detail").hidden = true;
    const result = await api("/search?q=" + encodeURIComponent(q));
    const summaryBox = document.getElementById("access-client-summary");
    const resultsBox = document.getElementById("access-search-results");
    const platformsBox = document.getElementById("access-platforms");

    if (result.mode === "phone") {
      lastClientProfiles = result.profiles.filter(p => p.clientPhone);
      renderClientSummary(lastClientProfiles);
      summaryBox.hidden = false;
      resultsBox.hidden = true;
      platformsBox.hidden = true;
      return;
    }

    // mode === "email" — cuentas que coinciden, con la misma tarjeta
    // que en el acordeón por plataforma (mismos botones de acción).
    summaryBox.hidden = true;
    platformsBox.hidden = true;
    resultsBox.hidden = false;

    if (result.accounts.length === 0) {
      resultsBox.innerHTML = `<p class="feed-empty">No se encontraron cuentas con ese correo.</p>`;
      return;
    }
    resultsBox.innerHTML = result.accounts.map(a =>
      `<div class="access-search-platform-label">${escapeHtml(a.platform)}</div>${renderAccountCard(a, { open: true })}`
    ).join("");
    wireAccountCardEvents(resultsBox);
  }

  function renderClientSummary(profiles) {
    const box = document.getElementById("access-client-summary");
    const list = document.getElementById("access-client-list");
    box.hidden = false;

    if (profiles.length === 0) {
      list.innerHTML = `<li class="access-client-empty">No se encontraron cuentas para ese número.</li>`;
      return;
    }

    list.innerHTML = profiles.map((p, idx) => `
      <li class="access-client-item">
        <div>
          <b>${escapeHtml(p.platform)}</b>${p.profileName ? " — " + escapeHtml(p.profileName) : ""}
          <div class="text-muted">📧 ${escapeHtml(p.email)}</div>
          <div class="text-muted">${escapeHtml(p.clientPhone)}${p.provider ? " · " + escapeHtml(p.provider) : ""}</div>
        </div>
        <div class="access-client-item-right">
          <span class="badge access-badge-${STATUS_CLASS[p.status]}">${STATUS_LABEL[p.status]}</span>
          <span>${fmtDateLong(p.expiresAt)} · ${daysLabel(p.status, p.daysLeft)}</span>
          <div class="access-client-item-actions">
            <button class="btn-secondary btn-sm client-view-account" data-idx="${idx}">👁 Ver cuenta</button>
            <button class="btn-secondary btn-sm client-send-account" data-idx="${idx}">📧 Enviar cuenta</button>
            ${renderRenewalButton(p)}
            <button class="btn-secondary btn-sm client-release-profile" data-profile-id="${p.id}">🗑 Eliminar</button>
          </div>
        </div>
      </li>
    `).join("");
  }

  // Abre el detalle de la plataforma (todas sus cuentas ya expandidas) y
  // resalta en amarillo la fila puntual de este cliente por 4 segundos,
  // para encontrarla de un vistazo entre todos los perfiles de la cuenta.
  async function viewClientAccountRow(p) {
    document.getElementById("access-search-input").value = "";
    document.getElementById("access-search-clear").hidden = true;
    resetSearch();
    await openPlatformDetail(p.platform);

    const row = document.querySelector(
      `#access-platform-detail-accounts tr[data-profile-id="${p.id}"]`
    );
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.classList.add("row-highlight-yellow");
      setTimeout(() => row.classList.remove("row-highlight-yellow"), 4000);
    }
  }

  // Delegado en la lista (se re-dibuja entera en cada búsqueda) — vuelve a
  // correr la misma búsqueda después de cada acción para reflejar el
  // cambio, en vez de tratar de actualizar la fila a mano.
  function initClientSummaryActions() {
    document.getElementById("access-client-list").addEventListener("click", async (e) => {
      const viewBtn    = e.target.closest(".client-view-account");
      const sendBtn    = e.target.closest(".client-send-account");
      const renewalBtn = e.target.closest(".row-renewal");
      const releaseBtn = e.target.closest(".client-release-profile");

      if (viewBtn) {
        const p = lastClientProfiles[Number(viewBtn.dataset.idx)];
        if (p) viewClientAccountRow(p);
        return;
      }
      if (sendBtn) {
        const p = lastClientProfiles[Number(sendBtn.dataset.idx)];
        if (p) window.open(waLink(p.clientPhone, msgEntrega(p)), "_blank");
        return;
      }
      // Solo marca el check (renewal_status) — NO toca el vencimiento de
      // la cuenta. Renovar la cuenta de verdad es un proceso aparte que
      // hace el admin a mano (Accesos > la cuenta > 🔄 Renovar).
      if (renewalBtn) {
        const next = RENEWAL_NEXT[renewalBtn.dataset.status || ""];
        await api("/profiles/" + renewalBtn.dataset.profileId + "/renewal", { method: "POST", body: JSON.stringify({ status: next }) });
      } else if (releaseBtn) {
        await api("/profiles/" + releaseBtn.dataset.profileId + "/release", { method: "POST" });
      } else {
        return;
      }

      runSearch(activeQuery);
    });
  }

  function initClientSummarySend() {
    document.getElementById("access-summary-send-btn").addEventListener("click", () => {
      if (lastClientProfiles.length === 0) return;
      const phone = lastClientProfiles[0].clientPhone;
      window.open(waLink(phone, msgResumen(lastClientProfiles)), "_blank");
    });
  }

  // ─────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────
  // MODAL — historial de cuentas vencidas (solo lectura)
  // ─────────────────────────────────────────────────────────────

  function renderArchivedAccount(a) {
    const clients = a.profiles.filter(p => p.clientPhone);
    const clientsHtml = clients.length
      ? clients.map(p => `<li>${escapeHtml(p.clientPhone)}${p.profileName ? " · " + escapeHtml(p.profileName) : ""}</li>`).join("")
      : `<li class="text-muted">Sin clientes asignados al vencer</li>`;

    return `
      <details class="access-history-item">
        <summary>
          <span class="access-history-platform">${escapeHtml(a.platform)}</span>
          <span class="text-muted">${escapeHtml(a.email)}</span>
          <span class="text-muted">Venció: ${fmtDateLong(a.expiresAt)}</span>
        </summary>
        <div class="access-history-detail">
          <div>🔑 ${escapeHtml(a.password)}</div>
          ${a.provider ? `<div>🏷 ${escapeHtml(a.provider)}</div>` : ""}
          <div class="text-muted">Archivada: ${fmtDateLong(a.archivedAt.slice(0, 10))}</div>
          <div class="access-history-clients">
            <b>Clientes al momento de vencer:</b>
            <ul>${clientsHtml}</ul>
          </div>
        </div>
      </details>
    `;
  }

  function renderHistoryList(accounts) {
    const body  = document.getElementById("access-history-body");
    const empty = document.getElementById("access-history-empty");
    body.innerHTML = accounts.map(renderArchivedAccount).join("");
    empty.hidden = accounts.length > 0;
    empty.textContent = "No hay cuentas archivadas todavía.";
  }

  async function loadHistory(query) {
    const body  = document.getElementById("access-history-body");
    const empty = document.getElementById("access-history-empty");
    try {
      const { accounts } = await api("/history" + (query ? "?q=" + encodeURIComponent(query) : ""));
      renderHistoryList(accounts);
    } catch (err) {
      body.innerHTML = "";
      empty.hidden = false;
      empty.textContent = "⚠️ No se pudo cargar el historial: " + (err?.message || "error desconocido");
    }
  }

  let historyDebounce = null;

  function initHistoryModal() {
    document.getElementById("access-history-btn").addEventListener("click", () => {
      document.getElementById("access-history-search").value = "";
      document.getElementById("access-history-search-clear").hidden = true;
      document.getElementById("access-history-modal").hidden = false;
      loadHistory("");
    });

    const input    = document.getElementById("access-history-search");
    const clearBtn = document.getElementById("access-history-search-clear");

    input.addEventListener("input", () => {
      clearTimeout(historyDebounce);
      clearBtn.hidden = !input.value;
      historyDebounce = setTimeout(() => loadHistory(input.value.trim()), 300);
    });

    clearBtn.addEventListener("click", () => {
      input.value = "";
      clearBtn.hidden = true;
      loadHistory("");
    });
  }

  // ─────────────────────────────────────────────────────────────
  // RENOVADOS — todos los clientes marcados "✅ Renueva", de cualquier
  // cuenta, para ver de un vistazo a quién hay que pasarle a la cuenta
  // nueva sin abrir cada plataforma por separado.
  // ─────────────────────────────────────────────────────────────

  let cachedRenewingProfiles = [];

  function renderRenewingItem(p, idx) {
    return `
      <div class="access-history-item access-renewing-item">
        <span class="access-history-platform">${escapeHtml(p.platformTag || p.platform)}</span>
        <span class="text-muted">${escapeHtml(p.clientPhone)}</span>
        <span class="text-muted">Vence: ${fmtDateLong(p.expiresAt)}</span>
        <button class="btn-secondary btn-sm renewing-view-btn" data-idx="${idx}" type="button">👁 Ver</button>
      </div>
    `;
  }

  async function loadRenewing() {
    const body  = document.getElementById("access-renewing-body");
    const empty = document.getElementById("access-renewing-empty");
    try {
      const { profiles } = await api("/profiles/renewing");
      cachedRenewingProfiles = profiles;
      body.innerHTML = profiles.map(renderRenewingItem).join("");
      empty.hidden = profiles.length > 0;
    } catch (err) {
      body.innerHTML = "";
      empty.hidden = false;
      empty.textContent = "⚠️ No se pudo cargar: " + (err?.message || "error desconocido");
    }
  }

  // Cierra el modal, abre el detalle de la plataforma (todas sus cuentas
  // ya expandidas, como en la vista normal de Accesos) y resalta/lleva la
  // vista hasta la cuenta puntual de este cliente.
  async function viewRenewingAccount(p) {
    document.getElementById("access-renewing-modal").hidden = true;
    document.getElementById("access-search-input").value = "";
    document.getElementById("access-search-clear").hidden = true;
    resetSearch();
    await openPlatformDetail(p.platform);

    const el = document.querySelector(
      `#access-platform-detail-accounts .access-account[data-account-id="${p.accountId}"]`
    );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("access-account-highlight");
      setTimeout(() => el.classList.remove("access-account-highlight"), 2000);
    }
  }

  function initRenewingModal() {
    document.getElementById("access-renewing-btn").addEventListener("click", () => {
      document.getElementById("access-renewing-modal").hidden = false;
      loadRenewing();
    });
    document.getElementById("access-renewing-body").addEventListener("click", (e) => {
      const btn = e.target.closest(".renewing-view-btn");
      if (!btn) return;
      const p = cachedRenewingProfiles[Number(btn.dataset.idx)];
      if (p) viewRenewingAccount(p);
    });
    document.getElementById("access-renewing-export-txt").addEventListener("click", exportRenewingTxt);
    document.getElementById("access-renewing-export-pdf").addEventListener("click", exportRenewingPdf);
  }

  // ─────────────────────────────────────────────────────────────
  // EXPORTAR — resúmenes en .txt o PDF. El PDF no usa ninguna librería:
  // abre una pestaña imprimible y dispara el diálogo de impresión del
  // navegador, donde "Guardar como PDF" es una opción nativa.
  // ─────────────────────────────────────────────────────────────

  function downloadTextFile(filename, text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openPrintableSummary(title, tableHtml) {
    const win = window.open("", "_blank");
    if (!win) {
      alert("El navegador bloqueó la ventana — habilita los popups para generar el PDF.");
      return;
    }
    win.document.write(`
      <!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
      <style>
        body { font-family: -apple-system, Arial, sans-serif; padding: 24px; color: #222; }
        h1 { font-size: 18px; margin-bottom: 4px; }
        .muted { color: #777; font-size: 12px; margin-bottom: 18px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #ddd; }
        th { color: #777; font-weight: 600; text-transform: uppercase; font-size: 11px; }
      </style></head><body>
        <h1>${title}</h1>
        <p class="muted">Generado el ${new Date().toLocaleString("es-PE")}</p>
        <table>${tableHtml}</table>
      </body></html>
    `);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
  }

  function fmtDateTime(sqliteTs) {
    try {
      const iso = /[Zz]|[+-]\d\d:?\d\d$/.test(sqliteTs) ? sqliteTs : sqliteTs.replace(" ", "T") + "Z";
      return new Date(iso).toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return sqliteTs;
    }
  }

  function exportRenewingTxt() {
    const lines = [
      "RESUMEN — Clientes marcados para renovar",
      "Generado: " + new Date().toLocaleString("es-PE"),
      "Total: " + cachedRenewingProfiles.length,
      "",
      ...cachedRenewingProfiles.map(p =>
        `${p.platformTag || p.platform} · ${p.clientPhone} · Vence: ${fmtDateLong(p.expiresAt)}`
      ),
    ];
    downloadTextFile("clientes-a-renovar.txt", lines.join("\n"));
  }

  function exportRenewingPdf() {
    const rows = cachedRenewingProfiles.map(p => `
      <tr><td>${escapeHtml(p.platformTag || p.platform)}</td><td>${escapeHtml(p.clientPhone)}</td><td>${escapeHtml(fmtDateLong(p.expiresAt))}</td></tr>
    `).join("");
    openPrintableSummary("Clientes marcados para renovar",
      `<thead><tr><th>Plataforma</th><th>Celular</th><th>Vence</th></tr></thead><tbody>${rows}</tbody>`);
  }

  // ─────────────────────────────────────────────────────────────
  // REGISTRO DE RENOVADOS — historial permanente de renovaciones ya
  // hechas (distinto de "marcado para renovar", que se borra apenas se
  // renueva de verdad). Para llevar un control de quién renovó qué.
  // ─────────────────────────────────────────────────────────────

  let cachedRenewalHistory = [];

  function renderRenewalHistoryItem(e) {
    return `
      <div class="access-history-item access-renewing-item">
        <span class="access-history-platform">${escapeHtml(e.platformTag || e.platform)}</span>
        <span class="text-muted">${escapeHtml(e.clientPhone)}</span>
        <span class="text-muted">Renovado: ${fmtDateTime(e.renewedAt)}</span>
      </div>
    `;
  }

  async function loadRenewalHistory() {
    const body  = document.getElementById("access-renewal-history-body");
    const empty = document.getElementById("access-renewal-history-empty");
    try {
      const { entries } = await api("/renewal-history");
      cachedRenewalHistory = entries;
      body.innerHTML = entries.map(renderRenewalHistoryItem).join("");
      empty.hidden = entries.length > 0;
    } catch (err) {
      body.innerHTML = "";
      empty.hidden = false;
      empty.textContent = "⚠️ No se pudo cargar: " + (err?.message || "error desconocido");
    }
  }

  function exportRenewalHistoryTxt() {
    const lines = [
      "REGISTRO — Clientes que ya renovaron",
      "Generado: " + new Date().toLocaleString("es-PE"),
      "Total: " + cachedRenewalHistory.length,
      "",
      ...cachedRenewalHistory.map(e =>
        `${e.platformTag || e.platform} · ${e.clientPhone} · Renovado: ${fmtDateTime(e.renewedAt)}`
      ),
    ];
    downloadTextFile("renovados-registro.txt", lines.join("\n"));
  }

  function exportRenewalHistoryPdf() {
    const rows = cachedRenewalHistory.map(e => `
      <tr><td>${escapeHtml(e.platformTag || e.platform)}</td><td>${escapeHtml(e.clientPhone)}</td><td>${escapeHtml(fmtDateTime(e.renewedAt))}</td></tr>
    `).join("");
    openPrintableSummary("Clientes que ya renovaron",
      `<thead><tr><th>Plataforma</th><th>Celular</th><th>Renovado</th></tr></thead><tbody>${rows}</tbody>`);
  }

  function initRenewalHistoryModal() {
    document.getElementById("access-renewal-history-btn").addEventListener("click", () => {
      document.getElementById("access-renewal-history-modal").hidden = false;
      loadRenewalHistory();
    });
    document.getElementById("access-renewal-history-export-txt").addEventListener("click", exportRenewalHistoryTxt);
    document.getElementById("access-renewal-history-export-pdf").addEventListener("click", exportRenewalHistoryPdf);
  }

  // ─────────────────────────────────────────────────────────────
  // PEDIDO (combo) — vender varias plataformas de una vez al mismo
  // cliente y armar un solo mensaje de WhatsApp con todo, para no tener
  // que enviar cada cuenta por separado en pedidos combo.
  // ─────────────────────────────────────────────────────────────

  async function openComboOrderModal() {
    document.getElementById("combo-order-form").reset();
    document.getElementById("combo-order-error").hidden = true;

    const list = document.getElementById("combo-order-platforms");
    list.innerHTML = `<li>Cargando plataformas…</li>`;
    document.getElementById("combo-order-modal").hidden = false;

    const { platforms } = await api("/platforms");
    if (platforms.length === 0) {
      list.innerHTML = `<li>No hay plataformas cargadas en Accesos.</li>`;
      return;
    }

    list.innerHTML = platforms.map(p => {
      const free = p.sellableCount;
      const disabled = free > 0 ? "" : "disabled";
      return `
        <li>
          <label>
            <input type="checkbox" value="${escapeHtml(p.platform)}" ${disabled} />
            ${escapeHtml(p.platform)}
          </label>
          <span class="access-platform-count ${free > 0 ? "has-stock" : "no-stock"}">${free} disponible(s)</span>
        </li>
      `;
    }).join("");
  }

  function buildComboMessage(sold) {
    const bloques = sold.map(p => msgEntrega(p)).join("\n\n———————————————\n\n");
    return bloques + "\n\n———————————————\n\n💜 *¡Gracias por tu compra!* <3";
  }

  function initComboOrderModal() {
    document.getElementById("access-combo-order-btn").addEventListener("click", openComboOrderModal);
    document.getElementById("combo-order-cancel").addEventListener("click", () => {
      document.getElementById("combo-order-modal").hidden = true;
    });

    document.getElementById("combo-order-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById("combo-order-error");
      errorEl.hidden = true;

      const phone = document.getElementById("combo-order-phone").value.trim();
      const platforms = Array.from(
        document.querySelectorAll("#combo-order-platforms input[type=checkbox]:checked")
      ).map(cb => cb.value);

      if (!phone) { errorEl.textContent = "Falta el teléfono del cliente."; errorEl.hidden = false; return; }
      if (platforms.length === 0) { errorEl.textContent = "Elige al menos una plataforma."; errorEl.hidden = false; return; }

      try {
        const { sold, failed } = await api("/combo-order", {
          method: "POST",
          body: JSON.stringify({ phone, platforms }),
        });

        if (sold.length === 0) {
          errorEl.textContent = "No se pudo vender ninguna plataforma (sin stock).";
          errorEl.hidden = false;
          return;
        }

        document.getElementById("combo-order-modal").hidden = true;
        window.open(waLink(phone, buildComboMessage(sold)), "_blank");

        if (failed.length > 0) {
          alert("Se vendieron " + sold.length + " plataforma(s). Sin stock para: " + failed.join(", ") + ".");
        }

        await refresh();
      } catch (err) {
        errorEl.textContent = err.message || "No se pudo crear el pedido.";
        errorEl.hidden = false;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // RENOVACIÓN CON PROVEEDOR (Pagos > Renovaciones)
  // Cuentas de Accesos marcadas con "avisar renovación con proveedor" —
  // se venden como plan anual pero se pagan mes a mes. Solo lectura acá;
  // se activa/edita desde el modal de la cuenta en Accesos.
  // ─────────────────────────────────────────────────────────────

  let cachedProviderRenewals = [];

  // Mismo umbral que accountStatus() del backend (WARNING_THRESHOLD_DAYS=3)
  // — para que el color acá signifique lo mismo que en el resto del panel.
  function providerRenewalDaysInfo(nextDate) {
    if (!nextDate) return { cls: "", text: "" };
    const days = Math.round((new Date(nextDate + "T00:00:00Z") - new Date(todayISO() + "T00:00:00Z")) / 86_400_000);
    if (days < 0) return { cls: "expired", text: Math.abs(days) + "d vencido" };
    if (days <= 3) return { cls: "pending", text: days === 0 ? "Vence hoy" : days + "d restantes" };
    return { cls: "matched", text: days + "d restantes" };
  }

  function renderProviderRenewal(a) {
    const li = document.createElement("li");
    li.className = "catalog-item";
    li.dataset.id = a.id;
    const daysInfo = providerRenewalDaysInfo(a.providerRenewalNextDate);
    li.innerHTML = `
      <div class="catalog-thumb catalog-thumb-empty">🔁</div>
      <div class="catalog-main">
        <div class="catalog-name">${escapeHtml(a.platform)} — ${escapeHtml(a.email)}</div>
        <div class="catalog-desc">
          💰 ${escapeHtml(a.providerRenewalCost)} ${escapeHtml(a.providerRenewalCurrency)} ·
          📅 Próxima renovación: ${a.providerRenewalNextDate ? fmtDateLong(a.providerRenewalNextDate) : "—"}
          ${daysInfo.text ? ` · <span class="feed-status ${daysInfo.cls}">${escapeHtml(daysInfo.text)}</span>` : ""}
        </div>
      </div>
      <div class="catalog-actions">
        <button class="icon-btn-sm provider-renewal-done-btn" title="Marcar como renovado (+1 mes)">✅</button>
      </div>
    `;
    return li;
  }

  function renderProviderRenewalList() {
    const list  = document.getElementById("provider-renewal-list");
    const empty = document.getElementById("provider-renewal-empty");
    if (!list) return;
    list.innerHTML = "";
    if (cachedProviderRenewals.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;
    for (const a of cachedProviderRenewals) list.appendChild(renderProviderRenewal(a));
  }

  async function loadProviderRenewals() {
    const { accounts } = await api("/provider-renewals");
    cachedProviderRenewals = accounts;
    renderProviderRenewalList();
  }

  function initProviderRenewalListActions() {
    const list = document.getElementById("provider-renewal-list");
    if (!list) return;
    list.addEventListener("click", async (e) => {
      if (!e.target.closest(".provider-renewal-done-btn")) return;
      const li = e.target.closest(".catalog-item");
      const id = Number(li.dataset.id);
      const account = cachedProviderRenewals.find(a => a.id === id);
      if (!account) return;
      if (!confirm(`¿Marcar "${account.platform} — ${account.email}" como renovado? La próxima fecha se adelanta un mes.`)) return;
      try {
        await api("/accounts/" + id + "/provider-renewal/mark-renewed", { method: "POST" });
        await loadProviderRenewals();
      } catch (err) { alert(err.message || "No se pudo marcar como renovado."); }
    });
  }

  let initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    initBulkModal();
    initEditModal();
    initProfileModal();
    initRenewNewModal();
    initHistoryModal();
    initRenewingModal();
    initRenewalHistoryModal();
    initSearch();
    initClientSummarySend();
    initClientSummaryActions();
    initProviderRenewalListActions();
    initComboOrderModal();
    document.getElementById("access-platform-back").addEventListener("click", closePlatformDetail);
    document.getElementById("access-platform-compact-toggle").addEventListener("click", togglePlatformCompact);
    document.getElementById("access-platform-sort-toggle").addEventListener("click", togglePlatformSort);
  }

  window.LiordarkAccess = { init, load, loadProviderRenewals, openComboOrderModal };
})();
