(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // SOPORTES — reportes «sin suscripción» que mandan los clientes desde
  // liordark.com (ya no hay chat). 🔎 En revisión, ✅ Tiene suscripción y
  // 🎉 Listo le avisan al cliente solo en su campanita de la web;
  // 🔁 Reemplazar cuenta además da el mensaje con los datos para WhatsApp.
  // ─────────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);
  let tickets = [];
  let filter = "open";
  let current = null;     // reporte abierto en el modal de reemplazo
  let replaceMode = "fresh";
  let replaceData = { fresh: [], shared: [] };
  let pickedAccountId = null;

  async function api(path, options) {
    const res = await fetch("/api/support" + path, {
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
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function localPhone(phone) {
    const d = String(phone ?? "").replace(/\D/g, "");
    return d.length === 11 && d.startsWith("51") ? d.slice(2) : d;
  }

  function waUrl(phone, text) {
    let digits = String(phone).replace(/\D/g, "");
    if (digits.length === 9) digits = "51" + digits;
    return "https://api.whatsapp.com/send?phone=" + digits + (text ? "&text=" + encodeURIComponent(text) : "");
  }

  function fmtDateTime(sqlite) {
    if (!sqlite) return "";
    try {
      const iso = /[Zz]$/.test(sqlite) ? sqlite : String(sqlite).replace(" ", "T") + "Z";
      return new Date(iso).toLocaleString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", hour: "numeric", minute: "2-digit" });
    } catch { return sqlite; }
  }

  function fmtDay(iso) {
    if (!iso) return "—";
    const [y, m, d] = String(iso).slice(0, 10).split("-");
    return d && m && y ? `${d}/${m}/${y}` : iso;
  }

  function statusBadge(t) {
    if (t.status === "pending") return `<span class="soporte-badge soporte-badge-new">🆕 Nuevo</span>`;
    if (t.status === "seen") return `<span class="soporte-badge soporte-badge-review">🔎 En revisión</span>`;
    if (t.resolution === "replaced") return `<span class="soporte-badge soporte-badge-done">🔁 Cuenta reemplazada</span>`;
    if (t.resolution === "solved") return `<span class="soporte-badge soporte-badge-done">🎉 Solucionado</span>`;
    return `<span class="soporte-badge soporte-badge-done">✅ Tenía suscripción</span>`;
  }

  function renderCard(t) {
    const open = t.status !== "attended";
    const codes = t.kind === "codes";
    // Reportes del panel mayorista: se le escribe al mayorista, no al cliente final.
    const waPhone = t.wholesalerId ? (t.wholesalerPhone || t.clientPhone) : t.clientPhone;
    const when = open
      ? `Reportado ${escapeHtml(fmtDateTime(t.createdAt))}`
      : `Resuelto ${escapeHtml(fmtDateTime(t.attendedAt))} · reportado ${escapeHtml(fmtDateTime(t.createdAt))}`;
    const actions = !open ? "" : codes ? `
            <button class="btn-primary btn-sm" data-act="reset-codes" type="button">🔑 Restablecer límite de hoy</button>` : `
            <button class="btn-secondary btn-sm" data-act="review" type="button"${t.status === "seen" ? " disabled" : ""}>${t.status === "seen" ? "🔎 En revisión ✓" : "🔎 En revisión"}</button>
            <button class="btn-secondary btn-sm" data-act="active" type="button">✅ Tiene suscripción</button>
            <button class="btn-secondary btn-sm" data-act="solved" type="button">🎉 Listo</button>
            <button class="btn-primary btn-sm" data-act="replace" type="button">🔁 Reemplazar cuenta</button>`;
    return `
      <div class="soporte-card${open ? "" : " is-done"}" data-id="${t.id}">
        <div class="soporte-card-head">
          <b class="soporte-platform">${codes ? "🔑" : "📺"} ${escapeHtml(t.platformTag)}</b>
          <span class="soporte-problem">${escapeHtml(t.problem || "Sin suscripción")}</span>
          ${statusBadge(t)}
          ${t.wholesalerId ? `<span class="soporte-badge">🏪 ${escapeHtml(t.wholesalerName || "Mayorista")}</span>` : ""}
        </div>
        <div class="soporte-card-sub">📱 ${t.wholesalerId ? "Cliente del mayorista: " : ""}<b>${escapeHtml(localPhone(t.clientPhone))}</b> · ${when}</div>
        <div class="soporte-account">
          <div><span>Correo</span><code>${escapeHtml(t.accountEmail)}</code></div>
          <div><span>Contraseña</span><code>${escapeHtml(t.accountPassword)}</code></div>
          ${t.profileName ? `<div><span>Perfil</span><code>${escapeHtml(t.profileName)}</code></div>` : ""}
          ${t.provider ? `<div><span>Proveedor</span><code>${escapeHtml(t.provider)}</code></div>` : ""}
        </div>
        <div class="soporte-actions">
          ${actions}
          <a class="btn-secondary btn-sm" href="${escapeHtml(waUrl(waPhone, ""))}" target="_blank" rel="noopener">💬 WhatsApp${t.wholesalerId ? " al mayorista" : ""}</a>
        </div>
      </div>`;
  }

  // Tira de números (Mango Pro): nuevos, en revisión, resueltos.
  function renderKpis() {
    const box = $("soportes-kpis");
    if (!box) return;
    const n = (fn) => tickets.filter(fn).length;
    const fresh = n(t => t.status === "pending");
    const seen = n(t => t.status === "seen");
    const done = n(t => t.status === "attended");
    box.innerHTML = `
      <div class="mp-kpi ${fresh ? "is-peach" : "is-soft"}"><b>${fresh}</b><span>Nuevos</span></div>
      <div class="mp-kpi ${seen ? "is-warn" : "is-soft"}"><b>${seen}</b><span>En revisión</span></div>
      <div class="mp-kpi is-green"><b>${done}</b><span>Resueltos</span></div>`;
  }

  function render() {
    renderKpis();
    const list = $("soportes-list");
    const shown = tickets.filter(t => filter === "all" || (filter === "open" ? t.status !== "attended" : t.status === "attended"));
    list.innerHTML = shown.map(renderCard).join("");
    $("soportes-empty").hidden = shown.length > 0;
    $("soportes-empty").textContent = filter === "open" ? "No hay reportes pendientes 🎉" : "Todavía no hay reportes aquí.";
  }

  function setBadge(count) {
    const badge = $("soportes-badge");
    badge.textContent = String(count);
    badge.hidden = !count;
    $("soportes-open-count").textContent = count ? `(${count})` : "";
  }

  async function load() {
    try {
      const data = await api("/tickets");
      tickets = data.tickets || [];
      setBadge(data.pendingCount || 0);
      render();
    } catch (err) {
      $("soportes-list").innerHTML = `<p class="feed-empty">${escapeHtml(err.message)}</p>`;
    }
  }

  // Avisos solo por la web (campanita del cliente en liordark.com).
  const QUICK_CONFIRM = {
    active: "¿Avisarle que su cuenta SÍ tiene suscripción y cerrar el reporte?",
    solved: "¿Avisarle que su problema ya está solucionado y cerrar el reporte?",
    "reset-codes": "¿Restablecer las consultas de códigos de hoy de esta cuenta? El mayorista podrá volver a consultar.",
  };
  const QUICK_DONE = {
    review: "🔎 Le avisamos que su cuenta está en revisión.",
    active: "✅ Le avisamos que su cuenta tiene suscripción.",
    solved: "🎉 Le avisamos que su problema está solucionado.",
    "reset-codes": "🔑 Límite de códigos restablecido.",
  };

  function toast(text) {
    const el = document.createElement("div");
    el.className = "soporte-toast";
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  async function quickAction(t, act, btn) {
    if (QUICK_CONFIRM[act] && !confirm(QUICK_CONFIRM[act])) return;
    btn.disabled = true;
    try {
      await api(`/tickets/${t.id}/${act}`, { method: "POST" });
      toast(QUICK_DONE[act] + (t.wholesalerId ? " (en su campanita del panel mayorista)" : " (en su campanita de liordark.com)"));
    } catch (err) {
      btn.disabled = false;
      alert(err.message || "No se pudo guardar.");
    }
    load();
  }

  // ── Reemplazo ──

  function renderReplaceOptions() {
    const box = $("soporte-replace-options");
    const items = replaceMode === "fresh" ? replaceData.fresh : replaceData.shared;
    $("soporte-replace-hint").textContent = replaceMode === "fresh"
      ? "El cliente pasa a un perfil libre de la cuenta que elijas y conserva su fecha de vencimiento."
      : "Uso temporal: se le pasan los datos de una cuenta que ya usan otros clientes (no ocupa perfil) y conserva su fecha.";
    $("soporte-replace-profile-wrap").hidden = replaceMode !== "shared";
    if (!items.length) {
      box.innerHTML = `<p class="feed-empty">${replaceMode === "fresh"
        ? "No hay cuentas de esta plataforma con perfiles libres. Prueba «Compartida» o agrega una en Accesos."
        : "No hay otras cuentas vigentes de esta plataforma."}</p>`;
      return;
    }
    box.innerHTML = items.map(a => `
      <label class="soporte-replace-option">
        <input type="radio" name="soporte-replace-target" value="${a.id}"${pickedAccountId === a.id ? " checked" : ""}>
        <span><b>${escapeHtml(a.email)}</b><br>
          <small>Vence ${escapeHtml(fmtDay(a.expiresAt))} · ${a.usedCount}/${a.totalCount || a.usedCount} en uso${a.freeCount ? ` · ${a.freeCount} libre${a.freeCount === 1 ? "" : "s"}` : ""}</small>
        </span>
      </label>`).join("");
  }

  function setReplaceMode(mode) {
    replaceMode = mode;
    pickedAccountId = null;
    $("soporte-replace-confirm").disabled = true;
    document.querySelectorAll("[data-replace-mode]").forEach(b => b.classList.toggle("active", b.dataset.replaceMode === mode));
    renderReplaceOptions();
  }

  async function openReplace(t) {
    current = t;
    $("soporte-replace-info").textContent = `${t.platformTag} · ${t.accountEmail} · cliente ${localPhone(t.clientPhone)}`;
    $("soporte-replace-error").hidden = true;
    $("soporte-replace-result").hidden = true;
    $("soporte-replace-result").innerHTML = "";
    $("soporte-replace-options").innerHTML = `<p class="feed-empty">Cargando cuentas…</p>`;
    $("soporte-replace-profile").value = "";
    $("soporte-replace-confirm").hidden = false;
    $("soporte-replace-cancel").textContent = "Cancelar";
    document.querySelector("#soporte-replace-modal .config-subnav").hidden = false;
    $("soporte-replace-hint").hidden = false;
    $("soporte-replace-modal").hidden = false;
    try {
      replaceData = await api(`/tickets/${t.id}/replace-options`);
    } catch (err) {
      replaceData = { fresh: [], shared: [] };
      $("soporte-replace-error").textContent = err.message;
      $("soporte-replace-error").hidden = false;
    }
    setReplaceMode(replaceData.fresh.length ? "fresh" : "shared");
  }

  function closeReplace() {
    $("soporte-replace-modal").hidden = true;
    current = null;
  }

  async function confirmReplace() {
    if (!current || !pickedAccountId) return;
    const btn = $("soporte-replace-confirm");
    btn.disabled = true;
    btn.textContent = "Reemplazando…";
    $("soporte-replace-error").hidden = true;
    try {
      const data = await api(`/tickets/${current.id}/replace`, {
        method: "POST",
        body: JSON.stringify({ mode: replaceMode, targetAccountId: pickedAccountId, profileName: $("soporte-replace-profile").value }),
      });
      const url = waUrl(current.clientPhone, data.message);
      $("soporte-replace-options").innerHTML = "";
      $("soporte-replace-profile-wrap").hidden = true;
      document.querySelector("#soporte-replace-modal .config-subnav").hidden = true;
      $("soporte-replace-hint").hidden = true;
      $("soporte-replace-result").innerHTML = `
        <p>✅ Listo. Ahora mándale sus datos nuevos:</p>
        <pre class="soporte-replace-msg">${escapeHtml(data.message)}</pre>
        <a class="btn-primary" href="${escapeHtml(url)}" target="_blank" rel="noopener">📲 Enviar por WhatsApp</a>`;
      $("soporte-replace-result").hidden = false;
      btn.hidden = true;
      $("soporte-replace-cancel").textContent = "Cerrar";
      load();
    } catch (err) {
      $("soporte-replace-error").textContent = err.message;
      $("soporte-replace-error").hidden = false;
      btn.disabled = false;
    } finally {
      btn.textContent = "Reemplazar";
    }
  }

  function init() {
    document.querySelectorAll("[data-soportes-filter]").forEach(btn => {
      btn.addEventListener("click", () => {
        filter = btn.dataset.soportesFilter;
        document.querySelectorAll("[data-soportes-filter]").forEach(b => b.classList.toggle("active", b === btn));
        render();
      });
    });
    $("soportes-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const t = tickets.find(x => String(x.id) === btn.closest(".soporte-card").dataset.id);
      if (!t) return;
      if (btn.dataset.act === "replace") openReplace(t);
      else quickAction(t, btn.dataset.act, btn);
    });
    document.querySelectorAll("[data-replace-mode]").forEach(b => {
      b.addEventListener("click", () => setReplaceMode(b.dataset.replaceMode));
    });
    $("soporte-replace-options").addEventListener("change", (e) => {
      if (e.target.name !== "soporte-replace-target") return;
      pickedAccountId = Number(e.target.value);
      $("soporte-replace-confirm").disabled = !pickedAccountId;
    });
    $("soporte-replace-confirm").addEventListener("click", confirmReplace);
    $("soporte-replace-cancel").addEventListener("click", closeReplace);
    $("soporte-replace-close").addEventListener("click", closeReplace);
    $("soporte-replace-modal").addEventListener("click", (e) => { if (e.target.id === "soporte-replace-modal") closeReplace(); });
    load();
    setInterval(load, 60_000);
  }

  window.LiordarkSoportes = { init, load };
})();
