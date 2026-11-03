(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // "🔑 Códigos" — pestaña propia del panel (ya no vive dentro de
  // Accesos). Un solo buscador por correo, sin elegir plataforma (ver
  // services/codes-lookup.service.ts: prueba todas las fuentes
  // configuradas solo) + la lista de todas las cuentas con código
  // habilitado debajo. Sin el filtro de 6 dígitos que sí aplica del
  // lado del cliente (ver store.routes.ts) — el admin ve todo.
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

  function fmtDateTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso.includes("Z") || iso.includes("+") ? iso : iso + "Z");
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("es-PE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  async function copyToClipboard(text, triggerEl) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    if (!triggerEl) return;
    const original = triggerEl.textContent;
    triggerEl.classList.add("copied");
    triggerEl.textContent = "¡Copiado!";
    setTimeout(() => {
      triggerEl.textContent = original;
      triggerEl.classList.remove("copied");
    }, 1200);
  }

  // ── Temporizador circular — cuenta regresiva mientras se consulta
  // (la página del proveedor puede tardar hasta ~1 minuto, ver
  // RETRY_ATTEMPTS/RETRY_DELAY_MS en codes-lookup.service.ts). Si el
  // resultado llega antes, se corta solo — nunca espera el minuto entero.
  const RETRY_TOTAL_SECONDS = 60;

  function createTimerEl() {
    const el = document.createElement("span");
    el.className = "codes-timer";
    el.innerHTML = `<span class="codes-timer-num"></span>`;
    return el;
  }

  function startTimer(el, remainingSeconds = RETRY_TOTAL_SECONDS, totalSeconds = remainingSeconds) {
    let remaining = remainingSeconds;
    const numEl = el.querySelector(".codes-timer-num");
    const tick = () => {
      el.style.setProperty("--pct", String(Math.max(0, (remaining / totalSeconds) * 100)));
      numEl.textContent = remaining + "s";
    };
    tick();
    const interval = setInterval(() => {
      remaining = Math.max(0, remaining - 1);
      tick();
      if (remaining <= 0) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }

  // Un resultado (código o enlace) listo para mostrar, con su acción.
  function resultHtml(kind, value) {
    if (kind === "link") {
      return `<button type="button" class="codes-open-btn" data-link="${escapeHtml(value)}">🔗 Abrir enlace</button>`;
    }
    return `<span class="codes-code" data-code="${escapeHtml(value)}" title="Clic para copiar">${escapeHtml(value)}</span>`;
  }

  // ── Buscador libre (correo → prueba todas las fuentes) ──

  function initSearchForm() {
    const form   = document.getElementById("codes-search-form");
    const banner = document.getElementById("codes-search-banner");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("codes-search-email").value.trim();
      const btn   = form.querySelector("button[type='submit']");

      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = "Buscando…";
      const timerEl = createTimerEl();
      btn.insertAdjacentElement("beforebegin", timerEl);
      const stopTimer = startTimer(timerEl);
      try {
        const result = await api("/codes/lookup", { method: "POST", body: JSON.stringify({ email }) });
        banner.hidden = false;
        if (!result.found) {
          banner.className = "codes-banner not-found";
          banner.innerHTML = `<span class="codes-banner-icon">✕</span><span>No se encontró ningún código reciente para <b>${escapeHtml(email)}</b>.</span>`;
          return;
        }
        banner.className = "codes-banner" + (result.kind === "link" ? " link" : "");
        banner.innerHTML = `
          <span class="codes-banner-icon">${result.kind === "link" ? "🔗" : "✓"}</span>
          <span class="codes-banner-info">
            <span class="codes-banner-email">${escapeHtml(email)}</span>
            <span class="codes-banner-source">${escapeHtml(result.sourceLabel || "")}${result.receivedAt ? " · Recibido: " + escapeHtml(result.receivedAt) : ""}</span>
          </span>
          <span class="codes-banner-result">${resultHtml(result.kind, result.value)}</span>
        `;
      } catch (err) {
        banner.hidden = false;
        banner.className = "codes-banner not-found";
        banner.textContent = err.message || "No se pudo buscar.";
      } finally {
        stopTimer();
        timerEl.remove();
        btn.disabled = false;
        btn.textContent = original;
      }
    });

    banner.addEventListener("click", (e) => {
      const codeEl = e.target.closest(".codes-code");
      if (codeEl) { copyToClipboard(codeEl.dataset.code, codeEl); return; }
      const linkBtn = e.target.closest(".codes-open-btn");
      if (linkBtn) window.open(linkBtn.dataset.link, "_blank", "noopener");
    });
  }

  // ── Lista de todas las cuentas con código habilitado ──

  let cachedAccounts = [];

  const TOTP_PERIOD_SECONDS = 30;

  // "correo · 13 cuentas" cuando varias cuentas comparten el mismo login.
  function accountSubHtml(a) {
    const count = a.accountCount > 1 ? ` · ${a.accountCount} cuentas` : "";
    return `<span class="codes-account-sub">${escapeHtml(a.email)}${count}</span>`;
  }

  function renderAccountRow(a) {
    const row = document.createElement("div");
    row.className = "codes-account-row";
    row.dataset.id = a.id;

    // 2FA por TOTP — se calcula solo, sin "Consultar": siempre hay un
    // código vigente, solo rota cada 30s (ver utils/totp.util.ts).
    if (a.totp) {
      row.innerHTML = `
        <span class="codes-account-icon">🔑</span>
        <span class="codes-account-info">
          <span class="codes-account-name">${escapeHtml(a.platform)}</span>
          ${accountSubHtml(a)}
        </span>
        <span class="codes-account-result">
          <span class="codes-code" data-code="${escapeHtml(a.totp.code)}" title="Clic para copiar">${escapeHtml(a.totp.code)}</span>
          <span class="codes-timer" data-role="totp-ring"><span class="codes-timer-num"></span></span>
        </span>
      `;
      startTimer(row.querySelector("[data-role='totp-ring']"), a.totp.secondsRemaining, TOTP_PERIOD_SECONDS);
      return row;
    }

    const latest = a.latestCode
      ? resultHtml(a.latestCode.code.startsWith("http") ? "link" : "code", a.latestCode.code) +
        `<span class="codes-account-received">${a.latestCode.snippet ? escapeHtml(a.latestCode.snippet) : fmtDateTime(a.latestCode.receivedAt)}</span>`
      : "";

    // Fuentes con sub-acciones (ej. "PallyStore con opciones") — el admin
    // elige puntualmente qué consultar en vez de probarlas todas a ciegas.
    const actionSelect = a.sourceActions
      ? `<select class="codes-action-select">${a.sourceActions.map(act => `<option value="${escapeHtml(act.id)}">${escapeHtml(act.label)}</option>`).join("")}</select>`
      : "";

    row.innerHTML = `
      <span class="codes-account-icon">🔑</span>
      <span class="codes-account-info">
        <span class="codes-account-name">${escapeHtml(a.platform)}</span>
        ${accountSubHtml(a)}
      </span>
      <span class="codes-account-result">
        ${latest}
        ${actionSelect}
        <button type="button" class="codes-consult-btn" ${a.codeSource ? "" : "disabled title='Sin fuente configurada'"}>Consultar</button>
      </span>
    `;
    return row;
  }

  // Cuando el TOTP más próximo rote, recarga sola la lista para mostrar
  // el código nuevo — sin esto se quedaría pegada en el código viejo.
  let totpRefreshTimeout = null;

  function scheduleTotpRefresh() {
    if (totpRefreshTimeout) { clearTimeout(totpRefreshTimeout); totpRefreshTimeout = null; }
    const totpAccounts = cachedAccounts.filter(a => a.totp);
    if (totpAccounts.length === 0) return;
    const soonest = Math.min(...totpAccounts.map(a => a.totp.secondsRemaining));
    totpRefreshTimeout = setTimeout(load, (soonest + 1) * 1000);
  }

  function renderAccountsList() {
    const list  = document.getElementById("codes-accounts-list");
    const empty = document.getElementById("codes-accounts-empty");
    list.innerHTML = "";
    if (cachedAccounts.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;
    for (const a of cachedAccounts) list.appendChild(renderAccountRow(a));
    scheduleTotpRefresh();
  }

  async function load() {
    try {
      const { accounts } = await api("/codes");
      cachedAccounts = accounts;
      renderAccountsList();
    } catch { /* se reintenta al volver a entrar a la vista */ }
  }

  function initAccountsListActions() {
    const list = document.getElementById("codes-accounts-list");
    list.addEventListener("click", async (e) => {
      const codeEl = e.target.closest(".codes-code");
      if (codeEl) { copyToClipboard(codeEl.dataset.code, codeEl); return; }

      const linkBtn = e.target.closest(".codes-open-btn");
      if (linkBtn) { window.open(linkBtn.dataset.link, "_blank", "noopener"); return; }

      const btn = e.target.closest(".codes-consult-btn");
      if (!btn || btn.disabled) return;
      const row = btn.closest(".codes-account-row");
      const id = Number(row.dataset.id);
      const actionSelect = row.querySelector(".codes-action-select");
      const actionId = actionSelect ? actionSelect.value : undefined;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Consultando…";
      const timerEl = createTimerEl();
      btn.insertAdjacentElement("beforebegin", timerEl);
      const stopTimer = startTimer(timerEl);
      try {
        const result = await api("/codes/" + id + "/lookup-now", {
          method: "POST",
          body: JSON.stringify(actionId ? { actionId } : {}),
        });
        if (!result.found) alert("Todavía no hay código nuevo para esa cuenta.");
        await load();
      } catch (err) {
        alert(err.message || "No se pudo consultar.");
      } finally {
        stopTimer();
        timerEl.remove();
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  }

  let initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    initSearchForm();
    initAccountsListActions();
  }

  window.LiordarkCodes = { init, load };
})();
