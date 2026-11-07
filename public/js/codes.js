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
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtDateTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso.includes("Z") || iso.includes("+") ? iso : iso + "Z");
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("es-PE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  // La fila muestra el ÚLTIMO código que se consultó, no necesariamente
  // el último correo que llegó: si el cliente pidió otro código después,
  // hay que darle a Consultar. Por eso se muestra la hora del correo en
  // hora de Lima y cuánto tiempo tiene, y se marca como posiblemente
  // vencido pasados 15 min (Disney+ y Netflix duran ~15 min).
  const CODE_STALE_MS = 15 * 60 * 1000;

  function emailDateFromSnippet(snippet) {
    const raw = String(snippet || "").replace(/^Recibido:\s*/, "").trim();
    // Pally: "05/11/2026 08:30:46" = día/mes/año, hora de Lima (Date.parse
    // lo leía como 11 de mayo). Streaming Market: "2026-11-02 23:04:51", Lima.
    const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (dmy) return new Date(Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1], +dmy[4] + 5, +dmy[5], +(dmy[6] || 0)));
    const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (ymd) return new Date(Date.UTC(+ymd[1], +ymd[2] - 1, +ymd[3], +ymd[4] + 5, +ymd[5], +(ymd[6] || 0)));
    const t = raw ? Date.parse(raw) : NaN;
    return Number.isNaN(t) ? null : new Date(t);
  }

  function agoText(ms) {
    const min = Math.floor(ms / 60000);
    if (min < 1) return "hace segundos";
    if (min < 60) return "hace " + min + " min";
    const h = Math.floor(min / 60);
    return h < 24 ? "hace " + h + " h" : "hace " + Math.floor(h / 24) + " d";
  }

  function latestCodeHtml(lc) {
    const isLink = lc.code.startsWith("http");
    const when = emailDateFromSnippet(lc.snippet)
      || (() => { const d = new Date(lc.receivedAt && !/[Z+]/.test(lc.receivedAt) ? lc.receivedAt + "Z" : lc.receivedAt); return Number.isNaN(d.getTime()) ? null : d; })();
    const age = when ? Date.now() - when.getTime() : 0;
    const stale = !isLink && when && age > CODE_STALE_MS;
    const hora = when ? when.toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "numeric", minute: "2-digit" }) : "";
    const label = when
      ? `Correo de las ${escapeHtml(hora)} · ${agoText(age)}${stale ? " · ⚠️ puede estar vencido, dale a Consultar" : ""}`
      : escapeHtml(lc.snippet || fmtDateTime(lc.receivedAt));
    return `<span class="${stale ? "codes-stale" : ""}">${resultHtml(isLink ? "link" : "code", lc.code)}</span>` +
      `<span class="codes-account-received${stale ? " codes-received-stale" : ""}">${label}</span>`;
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

  // ── Buscador: filtra la lista mientras se escribe (no consulta nada
  // solo). La consulta la hace el admin con el botón de cada fila. Solo si
  // el correo no está en la lista se ofrece buscarlo en todas las fuentes.

  function showNoMatchBanner(banner, text) {
    const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
    banner.hidden = false;
    banner.className = "codes-banner not-found";
    banner.innerHTML = `
      <span class="codes-banner-icon">✕</span>
      <span class="codes-banner-info">
        <span class="codes-banner-email">No hay cuentas con «${escapeHtml(text)}» en la lista</span>
        <span class="codes-banner-source">La lista muestra solo las cuentas con «Código» habilitado en Accesos.</span>
      </span>
      ${looksLikeEmail ? `<span class="codes-banner-result"><button type="button" class="codes-consult-btn" data-role="search-all">🔎 Buscar en todas las fuentes</button></span>` : ""}
    `;
  }

  function applySearchFilter(banner) {
    const text = document.getElementById("codes-search-email").value.trim();
    searchFilter = text.toLowerCase();
    renderAccountsList();
    if (!searchFilter) { banner.hidden = true; return; }
    const count = document.querySelectorAll("#codes-accounts-list .codes-account-row").length;
    if (count === 0) showNoMatchBanner(banner, text);
    else banner.hidden = true;
  }

  // Búsqueda libre en todas las fuentes — solo a pedido (correo no registrado).
  async function runGlobalSearch(email, banner, btn) {
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
      if (btn.isConnected) { btn.disabled = false; btn.textContent = original; }
    }
  }

  function initSearchForm() {
    const form   = document.getElementById("codes-search-form");
    const banner = document.getElementById("codes-search-banner");
    const input  = document.getElementById("codes-search-email");

    input.addEventListener("input", () => applySearchFilter(banner));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (cachedAccounts.length === 0) await load();
      applySearchFilter(banner);
      const row = document.querySelector("#codes-accounts-list .codes-account-row");
      if (row && searchFilter) row.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    banner.addEventListener("click", (e) => {
      const allBtn = e.target.closest("[data-role='search-all']");
      if (allBtn) { runGlobalSearch(input.value.trim(), banner, allBtn); return; }
      const codeEl = e.target.closest(".codes-code");
      if (codeEl) { copyToClipboard(codeEl.dataset.code, codeEl); return; }
      const linkBtn = e.target.closest(".codes-open-btn");
      if (linkBtn) window.open(linkBtn.dataset.link, "_blank", "noopener");
    });
  }

  // ── Lista de todas las cuentas con código habilitado ──

  let cachedAccounts = [];
  // Correo buscado que corresponde a una cuenta registrada: la lista se
  // filtra a esa(s) fila(s). Vacío = se ven todas.
  let searchFilter = "";

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
          <button type="button" class="codes-share-btn" data-totp="1" data-platform="${escapeHtml(a.platform)}" data-email="${escapeHtml(a.email)}">Enviar link</button>
        </span>
      `;
      startTimer(row.querySelector("[data-role='totp-ring']"), a.totp.secondsRemaining, TOTP_PERIOD_SECONDS);
      return row;
    }

    const latest = a.latestCode ? latestCodeHtml(a.latestCode) : "";

    // Fuentes con sub-acciones (ej. "PallyStore con opciones") — el admin
    // elige puntualmente qué consultar en vez de probarlas todas a ciegas.
    // Fuente con una sola opción (ej. Pally Netflix: solo «Código 4
    // dígitos») → solo su botón, sin desplegable ni "Consultar" genérico.
    const singleAction = a.sourceActions && a.sourceActions.length === 1;
    const actionSelect = a.sourceActions && !singleAction
      ? `<select class="codes-action-select">${a.sourceActions.map(act => `<option value="${escapeHtml(act.id)}">${escapeHtml(act.label)}</option>`).join("")}</select>`
      : "";
    // Atajos de un toque para lo más pedido: solo el código de 4 dígitos
    // o solo el enlace de inicio de sesión (sin tocar el desplegable).
    const hasAction = id => (a.sourceActions || []).some(act => act.id === id);
    const quickBtns = [
      hasAction("codigo_login") ? `<button type="button" class="codes-consult-btn codes-quick-btn" data-action="codigo_login">🔢 Código 4 dígitos</button>` : "",
      hasAction("link_login")   ? `<button type="button" class="codes-consult-btn codes-quick-btn" data-action="link_login">🔗 Enlace</button>` : "",
    ].join("");
    const genericBtn = singleAction ? "" :
      `<button type="button" class="codes-consult-btn" ${a.codeSource ? "" : "disabled title='Sin fuente configurada'"}>Consultar</button>`;
    // Visor: el correo tal cual llegó (ver code-viewer.js).
    const viewBtn = a.codeSource
      ? `<button type="button" class="codes-view-btn" data-platform="${escapeHtml(a.platform)}" data-email="${escapeHtml(a.email)}">Ver correo</button>` +
        `<button type="button" class="codes-share-btn" data-platform="${escapeHtml(a.platform)}" data-email="${escapeHtml(a.email)}">Enviar link</button>`
      : "";

    row.innerHTML = `
      <span class="codes-account-icon">🔑</span>
      <span class="codes-account-info">
        <span class="codes-account-name">${escapeHtml(a.platform)}</span>
        ${accountSubHtml(a)}
      </span>
      <span class="codes-account-result">
        ${latest}
        ${quickBtns}
        ${actionSelect}
        ${genericBtn}
        ${viewBtn}
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
    const visible = searchFilter
      ? cachedAccounts.filter(a => (a.email || "").toLowerCase().includes(searchFilter)
          || (a.platform || "").toLowerCase().includes(searchFilter))
      : cachedAccounts;
    for (const a of visible) list.appendChild(renderAccountRow(a));
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

      const shareBtn = e.target.closest(".codes-share-btn");
      if (shareBtn && window.LiordarkCodeViewer) {
        const row = shareBtn.closest(".codes-account-row");
        window.LiordarkCodeViewer.share({
          id: Number(row.dataset.id), platform: shareBtn.dataset.platform, email: shareBtn.dataset.email,
          totp: shareBtn.dataset.totp === "1",
        });
        return;
      }

      const viewBtn = e.target.closest(".codes-view-btn");
      if (viewBtn && window.LiordarkCodeViewer) {
        const row = viewBtn.closest(".codes-account-row");
        window.LiordarkCodeViewer.open({ id: Number(row.dataset.id), platform: viewBtn.dataset.platform, email: viewBtn.dataset.email });
        return;
      }

      const linkBtn = e.target.closest(".codes-open-btn");
      if (linkBtn) { window.open(linkBtn.dataset.link, "_blank", "noopener"); return; }

      const btn = e.target.closest(".codes-consult-btn");
      if (!btn || btn.disabled) return;
      const row = btn.closest(".codes-account-row");
      const id = Number(row.dataset.id);
      const actionSelect = row.querySelector(".codes-action-select");
      const actionId = btn.dataset.action || (actionSelect ? actionSelect.value : undefined);
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
