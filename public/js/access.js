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

  const STATUS_LABEL = { libre: "Libre", activo: "Activo", por_vencer: "Por vencer", vencido: "Vencido" };
  const STATUS_CLASS = { libre: "libre", activo: "matched", por_vencer: "pending", vencido: "expired" };

  function daysLabel(status, days) {
    if (status === "libre") return "—";
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
    return `✅ *${p.platform}*\n\n📧 Correo: *${p.email}*\n🔑 Contraseña: *${p.password}*\n👤 Perfil: *${p.profileName}*\n⏳ Vencimiento: *${fmtDateLong(p.expiresAt)}*`;
  }
  function msgReemplazo(p) {
    return `🔄 Reemplazo de cuenta\n\n✅ *${p.platform}*\n📧 Correo: *${p.email}*\n🔑 Contraseña: *${p.password}*\n👤 Perfil: *${p.profileName}*\n⏳ Días restantes: *${p.daysLeft}*\n\nCualquier inconveniente adicional, estoy atento. 😊`;
  }
  function msgPassword(p, newPassword) {
    return `🔄 *Cambio de contraseña*\n\n✅ *${p.platform}*\n📧 Correo: *${p.email}*\n🔑 Nueva contraseña: *${newPassword}*`;
  }
  function msgResumen(items) {
    const lines = items.map((it, i) =>
      `${i + 1}️⃣ *${it.platform}*\n👤 Perfil: ${it.profileName}\n⏳ Vence: ${fmtDateLong(it.expiresAt)} (${daysLabel(it.status, it.daysLeft)})`
    ).join("\n\n");
    return `📋 *Resumen de tus cuentas*\n\n${lines}`;
  }

  // ─────────────────────────────────────────────────────────────
  // ESTADO EN MEMORIA
  // ─────────────────────────────────────────────────────────────

  let currentProfileForModal = null; // { id, accountId } — perfil que se está editando
  let currentPasswordTarget  = null; // profile con datos de cuenta, para armar el link tras poner la nueva clave

  // ─────────────────────────────────────────────────────────────
  // CARGA Y RENDER — plataformas / cuentas / perfiles
  // ─────────────────────────────────────────────────────────────

  async function load() {
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
      }, { once: false });
    }
  }

  async function loadAccountsForPlatform(platform, target) {
    const { accounts } = await api("/platforms/" + encodeURIComponent(platform) + "/accounts");
    target.innerHTML = accounts.map(renderAccountCard).join("");
    wireAccountCardEvents(target);
  }

  /** Datos de perfil + cuenta combinados, tal como los necesitan los mensajes de WhatsApp. */
  function profileCtx(account, p) {
    return {
      id: p.id, accountId: account.id, platform: account.platform,
      email: account.email, password: account.password,
      profileName: p.profileName, expiresAt: p.expiresAt, daysLeft: p.daysLeft, status: p.status,
      clientName: p.clientName, clientPhone: p.clientPhone,
    };
  }

  function renderAccountCard(account) {
    const rows = account.profiles.map(p => renderProfileRow(account, p)).join("");
    const occupiedCount = account.profiles.filter(p => p.clientPhone && p.expiresAt).length;
    const accountAttr = JSON.stringify(account).replace(/"/g, "&quot;");

    return `
      <div class="access-account" data-account-id="${account.id}">
        <div class="access-account-head">
          <div class="access-account-email">
            📧 <span>${escapeHtml(account.email)}</span>
            <span class="access-pw-mask">🔑 ••••••••</span>
            <span class="access-pw-real" hidden>🔑 ${escapeHtml(account.password)}</span>
            <button class="icon-btn-sm access-toggle-pw" title="Mostrar/ocultar contraseña">👁</button>
          </div>
          <div class="access-account-actions">
            ${occupiedCount > 0 ? `<button class="btn-secondary btn-sm access-send-all" data-account="${accountAttr}">📤 Enviar a todos (${occupiedCount})</button>` : ""}
            <button class="btn-secondary btn-sm access-edit-account" data-account-id="${account.id}">✏️ Editar cuenta</button>
            <button class="btn-secondary btn-sm access-delete-account" data-account-id="${account.id}">🗑 Eliminar cuenta</button>
          </div>
        </div>
        <table class="access-table">
          <thead>
            <tr><th>Perfil</th><th>Cliente</th><th>Vence</th><th>Estado</th><th></th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderProfileRow(account, p) {
    const occupied = !!p.clientPhone && !!p.expiresAt;
    const ctx = JSON.stringify(profileCtx(account, p)).replace(/"/g, "&quot;");

    const actions = occupied ? `
        <button class="row-action" data-act="send" data-ctx="${ctx}" title="Enviar cuenta">📧</button>
        <button class="row-action" data-act="replace" data-ctx="${ctx}" title="Reemplazo">🔄</button>
        <button class="row-action" data-act="password" data-ctx="${ctx}" title="Cambiar contraseña">🔑</button>
        <button class="row-action" data-act="renew" data-ctx="${ctx}" title="+30 días">➕30</button>
        <button class="row-action" data-act="edit" data-ctx="${ctx}" title="Editar">✏️</button>
        <button class="row-action" data-act="release" data-ctx="${ctx}" title="Liberar perfil">🗑</button>
      ` : `
        <button class="row-action" data-act="edit" data-ctx="${ctx}" title="Asignar cliente">➕ Asignar</button>
      `;

    return `
      <tr>
        <td>${escapeHtml(p.profileName || ("Perfil " + p.slotNumber))}</td>
        <td>${occupied ? escapeHtml(p.clientName) + "<br><small>" + escapeHtml(p.clientPhone) + "</small>" : "<span class=\"text-muted\">Libre</span>"}</td>
        <td>${occupied ? fmtDateLong(p.expiresAt) + "<br><small>" + daysLabel(p.status, p.daysLeft) + "</small>" : "—"}</td>
        <td><span class="badge access-badge-${STATUS_CLASS[p.status]}">${STATUS_LABEL[p.status]}</span></td>
        <td class="access-row-actions">${actions}</td>
      </tr>
    `;
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

    target.querySelectorAll(".access-edit-account").forEach(btn => {
      btn.addEventListener("click", () => openAccountModal(Number(btn.dataset.accountId)));
    });
    target.querySelectorAll(".access-delete-account").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("¿Eliminar esta cuenta y todos sus perfiles? Esta acción no se puede deshacer.")) return;
        await api("/accounts/" + btn.dataset.accountId, { method: "DELETE" });
        refresh();
      });
    });

    target.querySelectorAll(".row-action").forEach(btn => {
      btn.addEventListener("click", () => handleRowAction(btn.dataset.act, JSON.parse(btn.dataset.ctx.replace(/&quot;/g, '"'))));
    });
  }

  function handleRowAction(act, ctx) {
    if (act === "send")    return window.open(waLink(ctx.clientPhone, msgEntrega(ctx)), "_blank");
    if (act === "replace") return window.open(waLink(ctx.clientPhone, msgReemplazo(ctx)), "_blank");
    if (act === "password") { currentPasswordTarget = ctx; openPasswordModal(); return; }
    if (act === "renew")   return renewProfile(ctx.id);
    if (act === "edit")    return openProfileModal(ctx);
    if (act === "release") return releaseProfile(ctx.id);
  }

  // ─────────────────────────────────────────────────────────────
  // ENVÍO EN MASIVO — un WhatsApp por cada perfil con cliente
  // asignado, de a uno, con 5s de por medio.
  //
  // Las ventanas se pre-abren TODAS en blanco durante el propio clic
  // (gesto real del usuario) y recién después, una por una con el
  // cooldown, se les asigna el link real. Si se abrieran una por una
  // tras cada espera, el navegador bloquearía como pop-up no
  // solicitado todo lo que se abra fuera del clic original.
  // ─────────────────────────────────────────────────────────────

  const SEND_ALL_COOLDOWN_MS = 5000;

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  async function sendAllForAccount(btn, account) {
    const occupied = account.profiles.filter(p => p.clientPhone && p.expiresAt);
    if (occupied.length === 0) return;

    const windows = occupied.map(() => window.open("", "_blank"));
    const somethingBlocked = windows.some(w => !w);

    const originalLabel = btn.textContent;
    btn.disabled = true;

    for (let i = 0; i < occupied.length; i++) {
      const link = waLink(occupied[i].clientPhone, msgEntrega(profileCtx(account, occupied[i])));
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

  async function renewProfile(profileId) {
    await api("/profiles/" + profileId + "/renew", { method: "POST" });
    refresh();
  }
  async function releaseProfile(profileId) {
    if (!confirm("¿Liberar este perfil? Se borrará el cliente y la fecha asignada.")) return;
    await api("/profiles/" + profileId + "/release", { method: "POST" });
    refresh();
  }

  // ─────────────────────────────────────────────────────────────
  // MODAL — nueva cuenta / editar cuenta
  // ─────────────────────────────────────────────────────────────

  let editingAccountId = null;

  function openAccountModal(accountId) {
    editingAccountId = accountId ?? null;
    document.getElementById("account-form").reset();
    document.getElementById("account-error").hidden = true;
    document.getElementById("account-slots").closest("label").style.display = accountId ? "none" : "flex";
    document.querySelector('#account-modal h3').textContent = accountId ? "Editar cuenta" : "Nueva cuenta";
    if (accountId) {
      api("/accounts/" + accountId).then(({ account }) => {
        document.getElementById("account-platform").value = account.platform;
        document.getElementById("account-email").value = account.email;
        document.getElementById("account-password").value = account.password;
      });
    }
    document.getElementById("account-modal").hidden = false;
  }

  function initAccountModal() {
    document.getElementById("access-new-account-btn").addEventListener("click", () => openAccountModal(null));
    document.getElementById("account-cancel").addEventListener("click", () => { document.getElementById("account-modal").hidden = true; });

    document.getElementById("account-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = {
        platform: document.getElementById("account-platform").value,
        email:    document.getElementById("account-email").value,
        password: document.getElementById("account-password").value,
        slots:    Number(document.getElementById("account-slots").value) || 5,
      };
      const errorEl = document.getElementById("account-error");
      errorEl.hidden = true;
      try {
        if (editingAccountId) {
          await api("/accounts/" + editingAccountId, { method: "PUT", body: JSON.stringify(body) });
        } else {
          await api("/accounts", { method: "POST", body: JSON.stringify(body) });
        }
        document.getElementById("account-modal").hidden = true;
        refresh();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // MODAL — asignar/editar cliente de un perfil
  // ─────────────────────────────────────────────────────────────

  function openProfileModal(ctx) {
    currentProfileForModal = ctx;
    document.getElementById("profile-form").reset();
    document.getElementById("profile-error").hidden = true;
    document.getElementById("profile-modal-title").textContent =
      ctx.clientPhone ? "Editar perfil" : "Asignar perfil";
    document.getElementById("profile-name").value = ctx.profileName || "";
    document.getElementById("profile-client-name").value = ctx.clientName || "";
    document.getElementById("profile-client-phone").value = ctx.clientPhone || "";
    document.getElementById("profile-expires").value = ctx.expiresAt || "";
    document.getElementById("profile-expires").min = todayISO();
    document.getElementById("profile-modal").hidden = false;
  }

  function initProfileModal() {
    document.getElementById("profile-cancel").addEventListener("click", () => { document.getElementById("profile-modal").hidden = true; });

    document.getElementById("profile-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = {
        profileName: document.getElementById("profile-name").value,
        clientName:  document.getElementById("profile-client-name").value,
        clientPhone: document.getElementById("profile-client-phone").value,
        expiresAt:   document.getElementById("profile-expires").value,
      };
      const errorEl = document.getElementById("profile-error");
      errorEl.hidden = true;
      try {
        await api("/profiles/" + currentProfileForModal.id, { method: "PUT", body: JSON.stringify(body) });
        document.getElementById("profile-modal").hidden = true;
        refresh();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // MODAL — cambio de contraseña (arma el link, no guarda nada
  // todavía — la contraseña real se actualiza editando la cuenta)
  // ─────────────────────────────────────────────────────────────

  function openPasswordModal() {
    document.getElementById("password-form").reset();
    document.getElementById("password-modal").hidden = false;
  }

  function initPasswordModal() {
    document.getElementById("password-cancel").addEventListener("click", () => { document.getElementById("password-modal").hidden = true; });

    document.getElementById("password-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const newPassword = document.getElementById("password-new").value;
      document.getElementById("password-modal").hidden = true;
      window.open(waLink(currentPasswordTarget.clientPhone, msgPassword(currentPasswordTarget, newPassword)), "_blank");
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
          <b>${escapeHtml(p.platform)}</b> — ${escapeHtml(p.profileName)}
          <div class="text-muted">${escapeHtml(p.clientName)} · ${escapeHtml(p.clientPhone)}</div>
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

  let initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    initAccountModal();
    initProfileModal();
    initPasswordModal();
    initSearch();
    initClientSummarySend();
  }

  window.LiordarkAccess = { init, load };
})();
