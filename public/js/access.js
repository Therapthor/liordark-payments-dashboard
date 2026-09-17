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

  function waLink(phone, text) {
    const digits = String(phone).replace(/\D/g, "");
    return "https://api.whatsapp.com/send?phone=" + digits + "&text=" + encodeURIComponent(text);
  }

  function msgEntrega(p) {
    const perfilLine = p.profileName ? `\n👤 Perfil: *${p.profileName}*` : "";
    return `✅ *${p.platform}*\n\n📧 Correo: *${p.email}*\n🔑 Contraseña: *${p.password}*${perfilLine}\n⏳ Vencimiento: *${fmtDateLong(p.expiresAt)}*`;
  }
  function msgReemplazo(p) {
    const perfilLine = p.profileName ? `\n👤 Perfil: *${p.profileName}*` : "";
    return `🔄 Reemplazo de cuenta\n\n✅ *${p.platform}*\n📧 Correo: *${p.email}*\n🔑 Contraseña: *${p.password}*${perfilLine}\n⏳ Días restantes: *${p.daysLeft}*\n\nCualquier inconveniente adicional, estoy atento. 😊`;
  }
  function msgPassword(p, newPassword) {
    return `🔄 *Cambio de contraseña*\n\n✅ *${p.platform}*\n📧 Correo: *${p.email}*\n🔑 Nueva contraseña: *${newPassword}*`;
  }
  function msgResumen(items) {
    const lines = items.map((it, i) => {
      const perfilLine = it.profileName ? `\n👤 Perfil: ${it.profileName}` : "";
      return `${i + 1}️⃣ *${it.platform}*${perfilLine}\n⏳ Vence: ${fmtDateLong(it.expiresAt)} (${daysLabel(it.status, it.daysLeft)})`;
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

  async function load() {
    loadProviderCatalog(); // se necesita para el botón 🔑 de soporte — no bloquea el render
    document.getElementById("access-client-summary").hidden = true;
    document.getElementById("access-search-results").hidden = true;
    document.getElementById("access-platforms").hidden = false;
    const { platforms } = await api("/platforms");
    const container = document.getElementById("access-platforms");
    const empty = document.getElementById("access-empty");

    if (platforms.length === 0) {
      container.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    container.innerHTML = "";
    for (const p of platforms) {
      const details = document.createElement("details");
      details.className = "access-platform";
      details.innerHTML = `
        <summary>
          <span class="access-platform-name">${escapeHtml(p.platform)}</span>
          <span class="access-platform-count">${p.accountCount} cuenta(s) · ${p.occupiedCount}/${p.profileCount} perfiles ocupados</span>
        </summary>
        <div class="access-accounts" data-platform="${escapeHtml(p.platform)}"></div>
      `;
      container.appendChild(details);
      details.addEventListener("toggle", () => {
        if (details.open) loadAccountsForPlatform(p.platform, details.querySelector(".access-accounts"));
      });
    }
  }

  async function loadAccountsForPlatform(platform, target) {
    const { accounts } = await api("/platforms/" + encodeURIComponent(platform) + "/accounts");
    target.innerHTML = accounts.map(renderAccountCard).join("");
    wireAccountCardEvents(target);
  }

  // Reemplaza en el DOM solo la tarjeta de esta cuenta, sin recargar todo
  // el acordeón — recargar todo cerraba las plataformas que el admin tenía
  // abiertas cada vez que asignaba un cliente, liberaba un perfil, etc.
  async function refreshAccountInPlace(accountId, platformHint) {
    const container = activeQuery
      ? document.getElementById("access-search-results")
      : document.getElementById("access-platforms");
    const el = container.querySelector(`.access-account[data-account-id="${accountId}"]`);
    if (!el) { await refresh(); return; }

    const { account } = await api("/accounts/" + accountId);
    const wrapper = document.createElement("div");
    wrapper.innerHTML = renderAccountCard(account).trim();
    const newEl = wrapper.firstElementChild;
    el.replaceWith(newEl);
    wireAccountCardEvents(newEl);

    refreshPlatformSummaryText(platformHint || account.platform);
  }

  // Actualiza solo el contador de la cabecera de la plataforma (cuentas /
  // perfiles ocupados) sin tocar qué acordeones están abiertos.
  async function refreshPlatformSummaryText(platform) {
    try {
      const { platforms } = await api("/platforms");
      const info = platforms.find(p => p.platform === platform);
      if (!info) return;
      document.querySelectorAll(".access-platform").forEach(details => {
        const nameEl = details.querySelector(".access-platform-name");
        if (nameEl && nameEl.textContent === platform) {
          details.querySelector(".access-platform-count").textContent =
            `${info.accountCount} cuenta(s) · ${info.occupiedCount}/${info.profileCount} perfiles ocupados`;
        }
      });
    } catch { /* no crítico */ }
  }

  function renderAccountCard(account) {
    const rows = account.profiles.map(p => renderProfileRow(account, p)).join("");
    const occupiedCount = account.profiles.filter(p => p.clientPhone).length;
    const renewingCount = account.profiles.filter(p => p.clientPhone && p.renewalStatus === "yes").length;
    const accountAttr = JSON.stringify(account).replace(/"/g, "&quot;");

    return `
      <div class="access-account" data-account-id="${account.id}" data-platform="${escapeHtml(account.platform)}">
        <div class="access-account-head">
          <div class="access-account-info">
            <div class="access-account-email">
              📧 <span>${escapeHtml(account.email)}</span>
              <span class="access-pw-mask">🔑 ••••••••</span>
              <span class="access-pw-real" hidden>🔑 ${escapeHtml(account.password)}</span>
              <button class="icon-btn-sm access-toggle-pw" title="Mostrar/ocultar contraseña">👁</button>
            </div>
            <div class="access-account-meta">
              ${account.provider ? `<span>🏷 ${escapeHtml(account.provider)}</span>` : ""}
              <span class="badge access-badge-${STATUS_CLASS[account.status]}">${STATUS_LABEL[account.status]}</span>
              <span>${fmtDateLong(account.expiresAt)} · ${daysLabel(account.status, account.daysLeft)}</span>
            </div>
          </div>
          <div class="access-account-actions">
            ${occupiedCount > 0 ? `<button class="btn-secondary btn-sm access-send-all" data-account="${accountAttr}">🔄 Enviar reemplazo a todos (${occupiedCount})</button>` : ""}
            ${occupiedCount > 0 ? `<button class="btn-secondary btn-sm access-password-all" data-account="${accountAttr}">🔑 Cambiar contraseña a todos</button>` : ""}
            ${account.link ? `<button class="btn-secondary btn-sm access-open-link" data-link="${escapeHtml(account.link)}">🔗 Abrir enlace</button>` : ""}
            <button class="btn-secondary btn-sm access-copy-account" data-account="${accountAttr}">📋 Copiar datos</button>
            <button class="btn-secondary btn-sm access-provider-support" data-account="${accountAttr}" title="Pedir soporte al proveedor por WhatsApp">🔑 Soporte proveedor</button>
            <button class="btn-secondary btn-sm access-renew-account" data-account-id="${account.id}">➕30 días</button>
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
    const occupied = !!p.clientPhone;
    const ctx = JSON.stringify(profileCtx(account, p)).replace(/"/g, "&quot;");

    const actions = occupied ? `
        <button class="row-action" data-act="send" data-ctx="${ctx}" title="Enviar cuenta">📧</button>
        <button class="row-action" data-act="edit" data-ctx="${ctx}" title="Cambiar teléfono">✏️</button>
        <button class="row-action" data-act="release" data-ctx="${ctx}" title="Liberar perfil">🗑</button>
      ` : `
        <button class="row-action" data-act="edit" data-ctx="${ctx}" title="Asignar cliente">➕ Asignar</button>
      `;

    const cells = [];
    if (account.hasProfiles) cells.push(`<td>${escapeHtml(p.profileName || ("Perfil " + p.slotNumber))}</td>`);
    cells.push(`<td>${occupied ? escapeHtml(p.clientPhone) : "<span class=\"text-muted\">Libre</span>"}</td>`);
    cells.push(`<td>${occupied ? renderRenewalButton(p) : ""}</td>`);
    cells.push(`<td class="access-row-actions">${actions}</td>`);

    return `<tr>${cells.join("")}</tr>`;
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
      btn.addEventListener("click", () => sendAllForAccount(btn, JSON.parse(btn.dataset.account.replace(/&quot;/g, '"'))));
    });

    target.querySelectorAll(".access-password-all").forEach(btn => {
      btn.addEventListener("click", () => openPasswordModalBulk(btn, JSON.parse(btn.dataset.account.replace(/&quot;/g, '"'))));
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

    target.querySelectorAll(".access-provider-support").forEach(btn => {
      btn.addEventListener("click", async () => {
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

    target.querySelectorAll(".access-renew-account").forEach(btn => {
      btn.addEventListener("click", async () => {
        const accountId = Number(btn.dataset.accountId);
        await api("/accounts/" + accountId + "/renew", { method: "POST" });
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
    if (!confirm("¿Liberar este perfil? Se borrará el cliente asignado.")) return;
    await api("/profiles/" + profileId + "/release", { method: "POST" });
    refreshAccountInPlace(accountId);
  }

  // ─────────────────────────────────────────────────────────────
  // COPIAR DATOS DE CUENTA — para reportar al proveedor
  // ─────────────────────────────────────────────────────────────

  function accountDataText(account) {
    const linkLine = account.link ? `\n🔗 Enlace: ${account.link}` : "";
    return `🛒 *${account.platform}*\n📧 Correo: ${account.email}\n🔑 Contraseña: ${account.password}\n🏷 Proveedor: ${account.provider || "—"}\n⏳ Vencimiento: ${fmtDateLong(account.expiresAt)}\n👥 ${account.hasProfiles ? "Cuenta con perfiles (5)" : "Cuenta única"}${linkLine}`;
  }

  function copyAccountData(btn, account) {
    const text = accountDataText(account);
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

  // ─────────────────────────────────────────────────────────────
  // ENVÍO EN MASIVO — reemplazo y cambio de contraseña son SOLO
  // masivos (uno por uno, con cooldown); "enviar cuenta" individual
  // sigue estando por perfil, en la fila.
  //
  // Las ventanas se pre-abren TODAS en blanco durante el propio clic
  // (gesto real del usuario) y recién después, una por una con el
  // cooldown, se les asigna el link real — si se abrieran una por una
  // tras cada espera, el navegador bloquearía como pop-up no
  // solicitado todo lo que se abra fuera del clic original.
  // ─────────────────────────────────────────────────────────────

  const SEND_ALL_COOLDOWN_MS = 5000;

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  async function bulkSendToOccupied(btn, account, buildMessage) {
    const occupied = account.profiles.filter(p => p.clientPhone);
    if (occupied.length === 0) return;

    const windows = occupied.map(() => window.open("", "_blank"));
    const somethingBlocked = windows.some(w => !w);

    const originalLabel = btn.textContent;
    btn.disabled = true;

    for (let i = 0; i < occupied.length; i++) {
      const link = waLink(occupied[i].clientPhone, buildMessage(occupied[i]));
      if (windows[i]) windows[i].location = link;
      btn.textContent = `Enviando ${i + 1}/${occupied.length}…`;
      if (i < occupied.length - 1) await sleep(SEND_ALL_COOLDOWN_MS);
    }

    btn.disabled = false;
    btn.textContent = originalLabel;

    if (somethingBlocked) {
      alert("El navegador bloqueó una o más ventanas. Permite las ventanas emergentes para este sitio e inténtalo de nuevo.");
    }
  }

  function sendAllForAccount(btn, account) {
    return bulkSendToOccupied(btn, account, p => msgReemplazo(profileCtx(account, p)));
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
    document.getElementById("bulk-modal").hidden = false;
  }

  function initBulkModal() {
    document.getElementById("access-new-account-btn").addEventListener("click", openBulkModal);
    document.getElementById("bulk-cancel").addEventListener("click", () => { document.getElementById("bulk-modal").hidden = true; });

    document.getElementById("bulk-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = {
        platform:  document.getElementById("bulk-platform").value,
        provider:  document.getElementById("bulk-provider").value,
        expiresAt: document.getElementById("bulk-expires").value,
        lines:     document.getElementById("bulk-lines").value,
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
    document.getElementById("account-edit-modal").hidden = false;
  }

  function initEditModal() {
    document.getElementById("account-edit-cancel").addEventListener("click", () => { document.getElementById("account-edit-modal").hidden = true; });

    document.getElementById("account-edit-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = {
        platform:  document.getElementById("account-edit-platform").value,
        email:     document.getElementById("account-edit-email").value,
        password:  document.getElementById("account-edit-password").value,
        provider:  document.getElementById("account-edit-provider").value,
        expiresAt: document.getElementById("account-edit-expires").value,
        link:      document.getElementById("account-edit-link").value,
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
  // MODAL — cambio de contraseña, SOLO masivo (a todos los perfiles
  // con cliente asignado). No guarda nada — la contraseña real se
  // actualiza aparte, editando la cuenta.
  // ─────────────────────────────────────────────────────────────

  let passwordBulkTarget = null; // { btn, account }

  function openPasswordModalBulk(btn, account) {
    passwordBulkTarget = { btn, account };
    document.getElementById("password-form").reset();
    document.getElementById("password-modal").hidden = false;
  }

  function initPasswordModal() {
    document.getElementById("password-cancel").addEventListener("click", () => { document.getElementById("password-modal").hidden = true; });

    document.getElementById("password-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const newPassword = document.getElementById("password-new").value;
      document.getElementById("password-modal").hidden = true;
      if (!passwordBulkTarget) return;
      const { btn, account } = passwordBulkTarget;
      passwordBulkTarget = null;
      await bulkSendToOccupied(btn, account, p => msgPassword(profileCtx(account, p), newPassword));
    });
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
    document.getElementById("access-platforms").hidden = false;
  }

  async function runSearch(q) {
    activeQuery = q;
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
      `<div class="access-search-platform-label">${escapeHtml(a.platform)}</div>${renderAccountCard(a)}`
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

    list.innerHTML = profiles.map(p => `
      <li class="access-client-item">
        <div>
          <b>${escapeHtml(p.platform)}</b>${p.profileName ? " — " + escapeHtml(p.profileName) : ""}
          <div class="text-muted">${escapeHtml(p.clientPhone)}${p.provider ? " · " + escapeHtml(p.provider) : ""}</div>
        </div>
        <div class="access-client-item-right">
          <span class="badge access-badge-${STATUS_CLASS[p.status]}">${STATUS_LABEL[p.status]}</span>
          <span>${fmtDateLong(p.expiresAt)} · ${daysLabel(p.status, p.daysLeft)}</span>
        </div>
      </li>
    `).join("");
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
  }

  let historyDebounce = null;

  function initHistoryModal() {
    document.getElementById("access-history-btn").addEventListener("click", async () => {
      document.getElementById("access-history-search").value = "";
      document.getElementById("access-history-search-clear").hidden = true;
      document.getElementById("access-history-modal").hidden = false;
      const { accounts } = await api("/history");
      renderHistoryList(accounts);
    });

    const input    = document.getElementById("access-history-search");
    const clearBtn = document.getElementById("access-history-search-clear");

    input.addEventListener("input", () => {
      clearTimeout(historyDebounce);
      clearBtn.hidden = !input.value;
      historyDebounce = setTimeout(async () => {
        const { accounts } = await api("/history?q=" + encodeURIComponent(input.value.trim()));
        renderHistoryList(accounts);
      }, 300);
    });

    clearBtn.addEventListener("click", async () => {
      input.value = "";
      clearBtn.hidden = true;
      const { accounts } = await api("/history");
      renderHistoryList(accounts);
    });
  }

  let initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    initBulkModal();
    initEditModal();
    initProfileModal();
    initPasswordModal();
    initRenewNewModal();
    initHistoryModal();
    initSearch();
    initClientSummarySend();
  }

  window.LiordarkAccess = { init, load };
})();
