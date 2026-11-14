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

  // Gatito de los códigos (js/cat.js): idle, searching, found, sad. Sin él
  // quedan los íconos de antes.
  function catHtml(state, cls) {
    return window.LiordarkCat ? window.LiordarkCat.html(state, cls) : "";
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
      ${catHtml("idle", "codes-banner-cat") || `<span class="codes-banner-icon">✕</span>`}
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
    const icon = banner.querySelector(".ld-cat, .codes-banner-icon");
    if (icon && window.LiordarkCat) icon.outerHTML = catHtml("searching", "codes-banner-cat");
    try {
      const result = await api("/codes/lookup", { method: "POST", body: JSON.stringify({ email }) });
      banner.hidden = false;
      if (!result.found) {
        banner.className = "codes-banner not-found";
        banner.innerHTML = `${catHtml("sad", "codes-banner-cat") || `<span class="codes-banner-icon">✕</span>`}<span>No se encontró ningún código reciente para <b>${escapeHtml(email)}</b>.</span>`;
        return;
      }
      banner.className = "codes-banner" + (result.kind === "link" ? " link" : "");
      banner.innerHTML = `
        ${catHtml("found", "codes-banner-cat") || `<span class="codes-banner-icon">${result.kind === "link" ? "🔗" : "✓"}</span>`}
        <span class="codes-banner-info">
          <span class="codes-banner-email">${escapeHtml(email)}</span>
          <span class="codes-banner-source">${escapeHtml(result.sourceLabel || "")}${result.receivedAt ? " · Recibido: " + escapeHtml(result.receivedAt) : ""}</span>
        </span>
        <span class="codes-banner-result">${resultHtml(result.kind, result.value)}</span>
      `;
    } catch (err) {
      banner.hidden = false;
      banner.className = "codes-banner not-found";
      if (window.LiordarkCat) banner.innerHTML = `${catHtml("sad", "codes-banner-cat")}<span>${escapeHtml(err.message || "No se pudo buscar.")}</span>`;
      else banner.textContent = err.message || "No se pudo buscar.";
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
    // Pally con opciones: «Código» y «Link» como botones (una consulta cada uno).
    const QUICK_IDS = ["codigo_login", "link_login"];
    const singleAction = a.sourceActions && (a.sourceActions.length === 1 || a.sourceActions.every(act => QUICK_IDS.includes(act.id)));
    const actionSelect = a.sourceActions && !singleAction
      ? `<select class="codes-action-select">${a.sourceActions.map(act => `<option value="${escapeHtml(act.id)}">${escapeHtml(act.label)}</option>`).join("")}</select>`
      : "";
    // Atajos de un toque para lo más pedido: solo el código de 4 dígitos
    // o solo el enlace de inicio de sesión (sin tocar el desplegable).
    const hasAction = id => (a.sourceActions || []).some(act => act.id === id);
    const quickBtns = [
      hasAction("codigo_login") ? `<button type="button" class="codes-consult-btn codes-quick-btn" data-action="codigo_login">🔢 Código de inicio de sesión</button>` : "",
      hasAction("link_login")   ? `<button type="button" class="codes-consult-btn codes-quick-btn" data-action="link_login">🔗 Link de inicio de sesión</button>` : "",
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
    for (const a of visible) {
      const row = renderAccountRow(a);
      const st = rowStatus.get(a.id);
      if (st && Date.now() - st.at < ROW_STATUS_MS) row.insertAdjacentHTML("beforeend", rowStatusHtml(st));
      else rowStatus.delete(a.id);
      list.appendChild(row);
    }
    scheduleTotpRefresh();
  }

  // «Consultar» de una fila: su gatito y lo que pasó, debajo de la fila
  // (queda 3 min o hasta la próxima consulta). Sin gatito: los avisos de antes.
  const rowStatus = new Map();
  const ROW_STATUS_MS = 3 * 60 * 1000;

  function rowStatusHtml(st) {
    return `<div class="codes-row-status is-${st.state}">${catHtml(st.state, "codes-row-cat")}<div class="codes-row-status-text">${st.html}</div></div>`;
  }

  function setRowStatus(id, state, html) {
    if (!window.LiordarkCat) return false;
    rowStatus.set(id, { state, html, at: Date.now() });
    const row = document.querySelector(`#codes-accounts-list .codes-account-row[data-id="${id}"]`);
    if (row) {
      const old = row.querySelector(".codes-row-status");
      if (old) old.outerHTML = rowStatusHtml(rowStatus.get(id));
      else row.insertAdjacentHTML("beforeend", rowStatusHtml(rowStatus.get(id)));
    }
    return true;
  }

  let loadedOnce = false;
  let loadedAt = 0;        // cuándo llegó la lista (el 2FA cuenta desde ahí)
  let loadPromise = null;

  // Lista fresca. Falla hacia arriba (la búsqueda rápida necesita saberlo);
  // load() es la versión silenciosa de siempre.
  async function fetchAccounts() {
    const { accounts } = await api("/codes");
    cachedAccounts = accounts;
    loadedOnce = true;
    loadedAt = Date.now();
    if (window.LiordarkCodesInbox) window.LiordarkCodesInbox.setAccountsCount(accounts.length);
    renderAccountsList();
    refreshSugsIfTyping();
    return accounts;
  }

  function load() {
    const p = fetchAccounts().catch(() => { /* se reintenta al volver a entrar a la vista */ });
    loadPromise = p;
    p.finally(() => { if (loadPromise === p) loadPromise = null; });
    return p;
  }

  // La búsqueda rápida necesita la lista para saber si el correo es de una
  // cuenta guardada: si todavía no llegó, la espera (una sola vez).
  function ensureAccounts() {
    if (loadedOnce) return Promise.resolve();
    return loadPromise || load();
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
      setRowStatus(id, "searching", "<strong>Buscando el código…</strong>");
      try {
        const result = await api("/codes/" + id + "/lookup-now", {
          method: "POST",
          body: JSON.stringify(actionId ? { actionId } : {}),
        });
        if (!result.found) {
          if (!setRowStatus(id, "sad", "<strong>Todavía no hay código nuevo para esa cuenta.</strong><span>Pide el código en la app y vuelve a consultar.</span>")) {
            alert("Todavía no hay código nuevo para esa cuenta.");
          }
        } else {
          const value = result.approval && safeUrl(result.approval.approveUrl) ? approvalHtml(result.approval) : resultHtml(result.kind, result.value);
          setRowStatus(id, "found", `<strong>¡Llegó!</strong>${value}`);
        }
        await load();
      } catch (err) {
        if (!setRowStatus(id, "sad", `<strong>No se pudo consultar.</strong><span>${escapeHtml(err.message || "")}</span>`)) {
          alert(err.message || "No se pudo consultar.");
        }
      } finally {
        stopTimer();
        timerEl.remove();
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // BÚSQUEDA RÁPIDA — pegar el correo + Enter → código.
  //  · Correo de una cuenta guardada: se consulta su fuente (lookup-now);
  //    si la cuenta tiene clave 2FA, su código vivo con los segundos que le
  //    quedan (sin consultar nada externo).
  //  · Correo desconocido: se busca en todas las fuentes (/codes/lookup).
  //  · Sugerencias mientras se escribe (↑/↓, Enter, Esc), las últimas 6
  //    búsquedas como chips y los atajos «/» y Ctrl/⌘+K.
  // ─────────────────────────────────────────────────────────────

  const RECENT_KEY = "liordark.codes.recent";
  const RECENT_MAX = 6;
  const SUGS_MAX = 8;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const $ = (id) => document.getElementById(id);

  // Marca y color de la plataforma (los mismos de la Bandeja).
  const PLATFORM_MARKS = [
    [/netflix/i, "netflix", "N", "Netflix"], [/disney/i, "disney", "D+", "Disney+"],
    [/prime|amazon/i, "prime", "P", "Prime Video"], [/crunchy/i, "crunchy", "C", "Crunchyroll"],
    [/chatgpt|openai/i, "chatgpt", "AI", "ChatGPT"], [/canva/i, "canva", "C", "Canva"],
  ];
  function platformOf(name) {
    const hit = PLATFORM_MARKS.find(([re]) => re.test(name || ""));
    return hit ? { cls: hit[1], mark: hit[2], name: hit[3] }
      : { cls: "other", mark: (name || "?").slice(0, 1).toUpperCase(), name: "" };
  }

  function safeUrl(u) {
    return /^https?:\/\//i.test(String(u || "")) ? String(u) : null;
  }

  function accountsByEmail(email) {
    const e = String(email || "").trim().toLowerCase();
    return e ? cachedAccounts.filter(a => String(a.email || "").trim().toLowerCase() === e) : [];
  }

  // ── Recientes (localStorage; si está bloqueado, solo esta sesión) ──
  let recentMem = [];

  function readRecent() {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      if (Array.isArray(raw)) {
        recentMem = raw.map(x => (typeof x === "string" ? x : x && x.email))
          .filter(x => typeof x === "string" && x.trim()).slice(0, RECENT_MAX);
      }
    } catch { /* bloqueado o dañado: queda lo de esta sesión */ }
    return recentMem;
  }

  function pushRecent(email) {
    const e = String(email || "").trim();
    if (!e) return;
    recentMem = [e, ...readRecent().filter(x => x.toLowerCase() !== e.toLowerCase())].slice(0, RECENT_MAX);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentMem)); } catch { /* bloqueado */ }
    renderRecent();
  }

  function renderRecent() {
    const box = $("cx-quick-recent");
    if (!box) return;
    const list = readRecent();
    box.hidden = list.length === 0;
    box.innerHTML = list.length
      ? `<span class="cx-q-recent-label">Recientes</span>` + list.map(e =>
          `<button type="button" class="cx-q-chip" data-q-recent="${escapeHtml(e)}" title="Buscar ${escapeHtml(e)}">${escapeHtml(e)}</button>`).join("")
      : "";
  }

  // ── Sugerencias ──
  let sugs = { items: [], active: -1 };
  let sugsWanted = false;  // el admin está escribiendo (no recién buscó)

  function suggestionsFor(text) {
    const q = String(text || "").trim().toLowerCase();
    if (!q) return [];
    const scored = [];
    for (const a of cachedAccounts) {
      const email = String(a.email || "").toLowerCase();
      const i = email.indexOf(q);
      const score = email === q ? 0 : i === 0 ? 1 : i > 0 ? 2 : String(a.platform || "").toLowerCase().includes(q) ? 3 : -1;
      if (score >= 0) scored.push({ score, a });
    }
    scored.sort((x, y) => x.score - y.score || String(x.a.email).localeCompare(String(y.a.email)));
    return scored.slice(0, SUGS_MAX).map(s => s.a);
  }

  function renderSugs() {
    const box = $("cx-quick-sugs"), input = $("cx-quick-input");
    const open = sugs.items.length > 0;
    box.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    box.innerHTML = sugs.items.map((a, i) => {
      const p = platformOf(a.platform);
      const sub = [a.platform, a.totp ? "2FA" : a.codeSourceLabel].filter(Boolean).join(" · ");
      return `
        <li id="cx-q-sug-${i}" class="cx-q-sug${i === sugs.active ? " active" : ""}" role="option" aria-selected="${i === sugs.active}" data-q-sug="${i}">
          <span class="cx-mark p-${p.cls}" aria-hidden="true">${escapeHtml(p.mark)}</span>
          <span class="cx-q-sug-text"><strong>${escapeHtml(a.email)}</strong><span>${escapeHtml(sub)}</span></span>
        </li>`;
    }).join("");
    if (sugs.active >= 0) {
      input.setAttribute("aria-activedescendant", "cx-q-sug-" + sugs.active);
      const el = box.querySelector(".cx-q-sug.active");
      if (el) el.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function updateSugs() {
    const keep = sugs.active >= 0 && sugs.items[sugs.active] ? sugs.items[sugs.active].id : null;
    sugs.items = suggestionsFor($("cx-quick-input").value);
    sugs.active = keep == null ? -1 : sugs.items.findIndex(a => a.id === keep);
    renderSugs();
  }

  function closeSugs() {
    sugsWanted = false;
    if (!sugs.items.length && sugs.active < 0) return;
    sugs = { items: [], active: -1 };
    renderSugs();
  }

  // La lista llegó mientras el admin escribía: se completan las sugerencias.
  function refreshSugsIfTyping() {
    const input = $("cx-quick-input");
    if (input && sugsWanted && document.activeElement === input) updateSugs();
  }

  function moveSug(delta) {
    if (!sugs.items.length) {
      sugsWanted = true;
      updateSugs();
      if (!sugs.items.length) return;
    }
    const n = sugs.items.length;
    sugs.active = sugs.active < 0 ? (delta > 0 ? 0 : n - 1) : (sugs.active + delta + n) % n;
    renderSugs();
  }

  function chooseSug(i) {
    const a = sugs.items[i];
    if (!a) return;
    setQuickText(a.email);
    closeSugs();
    runQuick({ account: a, email: a.email });
  }

  function setQuickText(text) {
    $("cx-quick-input").value = text;
    syncClear();
  }

  function syncClear() {
    $("cx-quick-clear").hidden = !$("cx-quick-input").value;
  }

  // ── La búsqueda ──
  let quick = null;      // lo que muestra la tarjeta: { seq, target, state, ... }
  let quickSeq = 0;      // cada búsqueda nueva deja sin efecto la anterior
  let quickTimer = null; // reloj de «Buscando… N s» o del código 2FA

  function stopQuickTimer() {
    clearInterval(quickTimer);
    quickTimer = null;
  }

  async function submitQuick() {
    const input = $("cx-quick-input");
    const text = input.value.trim();
    closeSugs();
    if (!text) { input.focus(); return; }
    await ensureAccounts();
    const exact = accountsByEmail(text);
    if (exact.length) { runQuick({ account: exact[0], email: exact[0].email }); return; }
    if (EMAIL_RE.test(text)) { runQuick({ account: null, email: text }); return; }
    // Parte del correo: si solo una cuenta coincide, esa; si no, a elegir.
    const partial = suggestionsFor(text);
    if (partial.length === 1) {
      setQuickText(partial[0].email);
      runQuick({ account: partial[0], email: partial[0].email });
      return;
    }
    quickSeq++;
    stopQuickTimer();
    quick = { state: "hint", text, many: partial.length > 1, target: null };
    renderQuick();
    if (partial.length) { sugsWanted = true; updateSugs(); }
  }

  function sameTarget(t) {
    if (!quick || !quick.target) return false;
    const cur = quick.target;
    return t.account
      ? !!cur.account && cur.account.id === t.account.id && (cur.actionId || "") === (t.actionId || "")
      : !cur.account && cur.email.toLowerCase() === t.email.toLowerCase();
  }

  // Pally con opciones: la misma cuenta da «código» o «enlace» de inicio de
  // sesión. Antes la búsqueda de arriba siempre pedía el código; ahora pregunta.
  function codeLinkChoice(a) {
    const acts = (a && a.sourceActions) || [];
    return acts.some(x => x.id === "codigo_login") && acts.some(x => x.id === "link_login");
  }

  async function runQuick(t) {
    const target = { account: t.account || null, email: String(t.account ? t.account.email : t.email || "").trim(), actionId: t.actionId || null };
    if (!target.email) return;
    if (quick && quick.state === "searching" && sameTarget(target)) return; // ya se está buscando
    const seq = ++quickSeq;
    stopQuickTimer();
    pushRecent(target.email);
    if (target.account && !target.account.totp && codeLinkChoice(target.account) && !target.actionId) {
      quick = { seq, target, state: "choose" };
      renderQuick();
      return;
    }
    quick = { seq, target, state: "searching", startedAt: Date.now() };
    renderQuick();

    if (target.account && target.account.totp) { showTotp(seq, false); return; }

    quickTimer = setInterval(paintElapsed, 1000);
    try {
      const res = target.account
        ? await api("/codes/" + target.account.id + "/lookup-now", { method: "POST", body: JSON.stringify(target.actionId ? { actionId: target.actionId } : {}) })
        : await api("/codes/lookup", { method: "POST", body: JSON.stringify({ email: target.email }) });
      if (seq !== quickSeq) return;
      quick.result = res;
      quick.state = res.found ? "found" : "notfound";
      // La lista de «Cuentas» también muestra el código nuevo.
      if (target.account && res.found) load();
    } catch (err) {
      if (seq !== quickSeq) return;
      quick.state = "error";
      quick.error = err.message || "No se pudo consultar.";
    }
    stopQuickTimer();
    renderQuick();
  }

  function paintElapsed() {
    const el = document.querySelector("#cx-quick-result [data-q-elapsed]");
    if (el && quick && quick.startedAt) el.textContent = Math.floor((Date.now() - quick.startedAt) / 1000) + " s";
  }

  // 2FA: el código se calcula en el servidor al pedir la lista (sin
  // consultar nada externo). Se muestra al toque si el de la lista sigue
  // vigente; al rotar, se pide la lista de nuevo.
  async function showTotp(seq, fresh) {
    const id = quick.target.account.id;
    let a = cachedAccounts.find(x => x.id === id);
    const msLeft = a && a.totp ? loadedAt + a.totp.secondsRemaining * 1000 - Date.now() : 0;
    if (fresh || msLeft < 2000) {
      try {
        await fetchAccounts();
      } catch (err) {
        if (seq !== quickSeq) return;
        quick.state = "error";
        quick.error = err.message || "No se pudo consultar.";
        renderQuick();
        return;
      }
      if (seq !== quickSeq) return;
      a = cachedAccounts.find(x => x.id === id);
    }
    if (!a || !a.totp) {
      quick.state = "error";
      quick.error = "Esta cuenta ya no tiene la clave 2FA guardada.";
      renderQuick();
      return;
    }
    quick.target.account = a;
    quick.state = "totp";
    quick.totpPaused = false;
    quick.totp = { code: a.totp.code, deadline: loadedAt + a.totp.secondsRemaining * 1000 };
    stopQuickTimer();
    renderQuick();
    quickTimer = setInterval(() => tickTotp(seq), 1000);
  }

  function totpLeft() {
    return Math.max(0, Math.ceil((quick.totp.deadline - Date.now()) / 1000));
  }

  function tickTotp(seq) {
    if (seq !== quickSeq || !quick || quick.state !== "totp") { stopQuickTimer(); return; }
    const left = totpLeft();
    paintTotp(left);
    if (left > 0) return;
    stopQuickTimer();
    // Fuera de la vista no se pide nada: se retoma al volver.
    if (document.hidden || $("view-codes").hidden) { quick.totpPaused = true; return; }
    showTotp(seq, true);
  }

  function paintTotp(left) {
    const box = $("cx-quick-result");
    const ring = box.querySelector("[data-q-ring]");
    const num = box.querySelector("[data-q-ring] .codes-timer-num");
    const text = box.querySelector("[data-q-left]");
    if (ring) ring.style.setProperty("--pct", String(Math.max(0, (left / TOTP_PERIOD_SECONDS) * 100)));
    if (num) num.textContent = left + "s";
    if (text) text.textContent = String(left);
  }

  function resumeTotp() {
    if (quick && quick.state === "totp" && quick.totpPaused && !$("view-codes").hidden && !document.hidden) {
      showTotp(quick.seq, true);
    }
  }

  // ── La tarjeta del resultado ──

  function receivedDate(res) {
    if (res.receivedIso) {
      const d = new Date(res.receivedIso);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return res.receivedAt ? emailDateFromSnippet(res.receivedAt) : null;
  }

  function ageHtml(res) {
    const d = receivedDate(res);
    if (!d) return "sin hora de llegada";
    const age = Date.now() - d.getTime();
    const hora = d.toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "numeric", minute: "2-digit" });
    return `llegó ${agoText(age)} (${escapeHtml(hora)})` +
      (age > CODE_STALE_MS ? ` · <b class="cx-q-stale">⚠️ puede estar vencido</b>` : "");
  }

  function codeValueHtml(code) {
    return `<button type="button" class="cx-code big cx-q-code" data-q-copy="${escapeHtml(code)}" title="Toca para copiar">${escapeHtml(code)}</button>
      <span class="cx-q-copyhint" data-q-copyhint>Toca el código para copiarlo</span>`;
  }

  // Netflix «Aprueba la nueva solicitud de inicio de sesión»: igual que en
  // la Bandeja (Aprobar / Rechazar, con el dispositivo que pidió entrar).
  function approvalHtml(a) {
    const deny = safeUrl(a.denyUrl);
    return `<div class="cx-approval">
        <span class="cx-approval-device">Solicitud de inicio de sesión${a.device ? " · " + escapeHtml(a.device) : ""}</span>
        <span class="cx-approval-btns">
          <a class="cx-linkbtn big" href="${escapeHtml(safeUrl(a.approveUrl))}" target="_blank" rel="noopener noreferrer">Aprobar</a>
          ${deny ? `<a class="cx-linkbtn deny big" href="${escapeHtml(deny)}" target="_blank" rel="noopener noreferrer">Rechazar</a>` : ""}
        </span>
      </div>`;
  }

  function foundValueHtml(res) {
    if (res.approval && safeUrl(res.approval.approveUrl)) return approvalHtml(res.approval);
    if (res.kind === "link") {
      const url = safeUrl(res.value);
      return url
        ? `<a class="cx-linkbtn big" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Abrir enlace</a>`
        : `<p class="cx-novalue">${escapeHtml(res.value)}</p>`;
    }
    return codeValueHtml(res.value);
  }

  // Con gatito: searching mientras busca y sad si no llegó o falló (o el
  // estado que se pida); sin él, el círculo que gira y los íconos de antes.
  function statusHtml(kind, title, sub, catState) {
    const icon = window.LiordarkCat ? catHtml(catState || (kind === "spin" ? "searching" : "sad"), "cx-q-cat")
      : kind === "spin" ? `<span class="cx-q-spin" aria-hidden="true"></span>`
      : `<span class="cx-q-icon" aria-hidden="true">${kind === "bad" ? "!" : kind === "warn" ? "…" : "?"}</span>`;
    return `<div class="cx-q-status ${kind}">${icon}<div><strong>${title}</strong><span>${sub}</span></div></div>`;
  }

  // Otras cuentas guardadas con el mismo correo (otra plataforma o fuente).
  function othersHtml(t) {
    if (!t.account) return "";
    const others = accountsByEmail(t.email).filter(o => o.id !== t.account.id);
    if (!others.length) return "";
    return `<p class="cx-q-others"><span>Este correo también está en:</span>${others.map(o => {
      const label = [o.platform, o.totp ? "2FA" : o.codeSourceLabel].filter(Boolean).join(" · ");
      return `<button type="button" class="cx-q-chip" data-q-acc="${escapeHtml(o.id)}" title="${escapeHtml(label)}">${escapeHtml(label)}</button>`;
    }).join("")}</p>`;
  }

  function quickCardHtml() {
    const q = quick;
    if (q.state === "hint") {
      return `<article class="cx-q-card is-hint">${q.many
        ? statusHtml("warn", `Hay varias cuentas con «${escapeHtml(q.text)}»`, "Elige una de la lista con ↑/↓ y Enter.", "idle")
        : statusHtml("warn", `Ninguna cuenta guardada tiene «${escapeHtml(q.text)}»`, "Escribe el correo completo para buscarlo en todas las fuentes.")}</article>`;
    }

    const t = q.target, a = t.account, res = q.result || {};
    const p = platformOf(a ? a.platform : res.sourceLabel);
    const title = a ? a.platform : (p.name || (q.state === "found" ? "Código" : "Todas las fuentes"));
    const retry = `<button type="button" class="cx-ghost-btn" data-q-act="retry">Reintentar</button>`;
    const share = a && window.LiordarkCodeViewer ? `<button type="button" class="cx-ghost-btn" data-q-act="share">Compartir link</button>` : "";
    let pill = "", body = "", meta = "", actions = "";

    const choice = a && codeLinkChoice(a);
    const wantsLink = t.actionId === "link_login";
    const switchBtn = choice
      ? `<button type="button" class="cx-ghost-btn" data-q-act="${wantsLink ? "code" : "link"}">${wantsLink ? "Pedir código" : "Pedir enlace"}</button>`
      : "";

    if (q.state === "choose") {
      body = `<div class="cx-q-choose">
          <p>¿Qué pides para esta cuenta?</p>
          <div class="cx-q-choose-btns">
            <button type="button" class="cx-q-choose-btn" data-q-act="code">Código de inicio de sesión</button>
            <button type="button" class="cx-q-choose-btn" data-q-act="link">Enlace de inicio de sesión</button>
          </div>
        </div>`;
    } else if (q.state === "searching") {
      body = statusHtml("spin", a ? (wantsLink ? "Buscando el enlace…" : "Buscando el código…") : "Buscando en todas las fuentes…",
        `<b data-q-elapsed aria-hidden="true">0 s</b> · la página del proveedor puede tardar hasta 1 minuto`);
    } else if (q.state === "totp") {
      const left = totpLeft();
      pill = `<span class="cx-pill new">2FA en vivo</span>`;
      body = `<div class="cx-q-value">${catHtml("found", "cx-q-cat")}${codeValueHtml(q.totp.code)}
          <span class="cx-q-totp" aria-hidden="true"><span class="codes-timer" data-q-ring style="--pct:${(left / TOTP_PERIOD_SECONDS) * 100}"><span class="codes-timer-num">${left}s</span></span>
          <span>Cambia en <b data-q-left>${left}</b> s</span></span>
        </div>`;
      meta = `${escapeHtml(a.codeSourceLabel || "Código 2FA")} · un código nuevo cada 30 s`;
      actions = retry + share;
    } else if (q.state === "found") {
      const d = receivedDate(res);
      const age = d ? Date.now() - d.getTime() : null;
      pill = age == null ? "" : age > CODE_STALE_MS
        ? `<span class="cx-pill muted">Viejo</span>` : age < 10 * 60 * 1000 ? `<span class="cx-pill new">Nuevo</span>` : "";
      body = `<div class="cx-q-value">${catHtml("found", "cx-q-cat")}${foundValueHtml(res)}</div>`;
      meta = `${escapeHtml(res.sourceLabel || (a && a.codeSourceLabel) || "")} · ${ageHtml(res)}`;
      const link = res.approval ? safeUrl(res.approval.approveUrl) : res.kind === "link" ? safeUrl(res.value) : null;
      actions = retry +
        (link ? `<button type="button" class="cx-ghost-btn" data-q-copy="${escapeHtml(link)}">${res.approval ? "Copiar link de Aprobar" : "Copiar enlace"}</button>` : "") +
        (res.inboxId ? `<button type="button" class="cx-ghost-btn" data-mail="${escapeHtml(res.inboxId)}">Ver correo</button>` : "") +
        switchBtn + share;
    } else if (q.state === "notfound") {
      body = a
        ? statusHtml("warn", wantsLink ? "Todavía no hay enlace nuevo para esa cuenta." : "Todavía no hay código nuevo para esa cuenta.", wantsLink ? "Pide el enlace en la app y toca Reintentar." : "Pide el código en la app y toca Reintentar.")
        : statusHtml("warn", `No se encontró ningún código reciente para ${escapeHtml(t.email)}.`, "Se buscó en todas las fuentes. Pide el código en la app y toca Reintentar.");
      actions = retry + switchBtn + share;
    } else {
      body = statusHtml("bad", "No se pudo consultar.", escapeHtml(q.error || ""));
      actions = retry + switchBtn + share;
    }

    return `
      <article class="cx-q-card p-${p.cls} is-${q.state}">
        <header class="cx-q-head">
          <span class="cx-mark p-${p.cls}" aria-hidden="true">${escapeHtml(p.mark)}</span>
          <div class="cx-q-who"><strong>${escapeHtml(title)}</strong><span class="cx-q-email">${escapeHtml(t.email)}</span></div>
          ${pill}
        </header>
        ${body}
        ${meta ? `<p class="cx-q-meta">${meta}</p>` : ""}
        ${actions ? `<div class="cx-q-actions">${actions}</div>` : ""}
        ${q.state === "searching" || q.state === "choose" ? "" : othersHtml(t)}
      </article>`;
  }

  function renderQuick() {
    const box = $("cx-quick-result");
    const hero = $("cx-hero");
    if (hero) hero.classList.toggle("cx-hero-off", !!quick);
    if (!quick) {
      // Sin búsqueda todavía: el gatito esperando (sin gatito, nada).
      box.hidden = !window.LiordarkCat;
      box.innerHTML = window.LiordarkCat
        ? `<div class="cx-q-idle">${catHtml("idle", "cx-q-cat")}<p><strong>Pega el correo y presiona Enter.</strong><span>El código sale aquí mismo.</span></p></div>`
        : "";
      return;
    }
    box.hidden = false;
    box.innerHTML = quickCardHtml();
  }

  async function quickCopy(text, el) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt("Copia:", text);
      return;
    }
    const isCode = el.classList.contains("cx-q-code");
    const hint = isCode ? el.parentElement.querySelector("[data-q-copyhint]") : null;
    const prev = el.textContent;
    el.classList.add("copied");
    if (hint) { hint.textContent = "¡Copiado!"; hint.classList.add("ok"); }
    if (!isCode) el.textContent = "Copiado ✓";
    setTimeout(() => {
      el.classList.remove("copied");
      if (!isCode) el.textContent = prev;
      if (hint) { hint.textContent = "Toca el código para copiarlo"; hint.classList.remove("ok"); }
    }, 1400);
  }

  // ── Mostrar la vista y el buscador ──

  function showCodesView() {
    if (window.LiordarkApp && typeof window.LiordarkApp.switchView === "function") {
      window.LiordarkApp.switchView("codes");
      return;
    }
    const tab = document.querySelector('.tab-btn[data-view="codes"]');
    if (tab) tab.click();
  }

  // Lleva el buscador a la vista, debajo de la barra de arriba (fija).
  function revealQuick() {
    const section = document.querySelector(".cx-quick");
    if (!section) return;
    const bar = document.querySelector(".topbar");
    const top = section.getBoundingClientRect().top + window.scrollY - (bar ? bar.offsetHeight : 0) - 12;
    window.scrollTo({ top: Math.max(0, top) });
  }

  function isDesktop() {
    return !!(window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches);
  }

  function focusQuick() {
    if ($("view-codes").hidden) showCodesView();
    const input = $("cx-quick-input");
    input.focus({ preventScroll: true });
    input.select();
    const r = input.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) revealQuick();
  }

  function isTypingField(el) {
    if (!el || el === document.body) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
    if (el.tagName === "INPUT") return !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(el.type);
    return false;
  }

  function overlayOpen() {
    if (document.querySelector("dialog[open], .modal-backdrop:not([hidden])")) return true;
    return ["cv-drawer-back", "cv-share-back"].some(id => { const el = $(id); return !!el && !el.hidden; });
  }

  // «/» y Ctrl/⌘+K: al buscador desde cualquier vista, salvo escribiendo
  // en otro campo o con una ventana abierta.
  function onShortcut(e) {
    const slash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey;
    const cmdK = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === "k";
    if ((!slash && !cmdK) || e.defaultPrevented || e.isComposing) return;
    const app = $("app");
    if (app && app.hidden) return;
    const input = $("cx-quick-input");
    if (e.target === input) {
      if (cmdK) { e.preventDefault(); input.select(); }
      return;
    }
    if (isTypingField(e.target) || overlayOpen()) return;
    e.preventDefault();
    focusQuick();
  }

  function initQuick() {
    const form = $("cx-quick-form");
    const input = $("cx-quick-input");
    const sugsBox = $("cx-quick-sugs");
    if (!form || !input) return;

    input.addEventListener("input", () => { sugsWanted = true; syncClear(); updateSugs(); });
    input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== input) closeSugs(); }, 150));
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "ArrowDown") { e.preventDefault(); moveSug(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveSug(-1); }
      else if (e.key === "Escape") { if (sugs.items.length) { e.preventDefault(); closeSugs(); } }
      else if (e.key === "Enter" && sugs.active >= 0 && sugs.items[sugs.active]) { e.preventDefault(); chooseSug(sugs.active); }
    });
    form.addEventListener("submit", (e) => { e.preventDefault(); submitQuick(); });

    // Clic en una sugerencia sin que el campo pierda el foco.
    sugsBox.addEventListener("mousedown", (e) => e.preventDefault());
    sugsBox.addEventListener("click", (e) => {
      const li = e.target.closest("[data-q-sug]");
      if (li) chooseSug(Number(li.dataset.qSug));
    });

    $("cx-quick-clear").addEventListener("click", () => {
      setQuickText("");
      closeSugs();
      // Limpiar la búsqueda también quita el resultado (y vuelve «Último código»).
      quickSeq++;
      stopQuickTimer();
      quick = null;
      renderQuick();
      input.focus();
    });

    $("cx-quick-recent").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-q-recent]");
      if (!chip) return;
      setQuickText(chip.dataset.qRecent);
      submitQuick();
    });

    // «Ver correo» (data-mail) lo abre la Bandeja (codes-inbox.js) en #cx-mail.
    $("cx-quick-result").addEventListener("click", (e) => {
      const copyEl = e.target.closest("[data-q-copy]");
      if (copyEl) { quickCopy(copyEl.dataset.qCopy, copyEl); return; }
      const other = e.target.closest("[data-q-acc]");
      if (other) {
        const a = cachedAccounts.find(x => String(x.id) === other.dataset.qAcc);
        if (a) { setQuickText(a.email); runQuick({ account: a, email: a.email }); }
        return;
      }
      const act = e.target.closest("[data-q-act]");
      if (!act || act.disabled || !quick || !quick.target) return;
      if (act.dataset.qAct === "retry") runQuick(quick.target);
      if (act.dataset.qAct === "code" || act.dataset.qAct === "link") {
        runQuick({ ...quick.target, actionId: act.dataset.qAct === "link" ? "link_login" : "codigo_login" });
      }
      if (act.dataset.qAct === "share" && quick.target.account && window.LiordarkCodeViewer) {
        const a = quick.target.account;
        window.LiordarkCodeViewer.share({ id: Number(a.id), platform: a.platform, email: a.email, totp: !!a.totp });
      }
    });

    document.addEventListener("keydown", onShortcut);
    document.addEventListener("visibilitychange", resumeTotp);
    if (/Mac|iPhone|iPad/i.test(navigator.platform || "")) {
      const ctrl = document.querySelector(".cx-quick-keys kbd:nth-of-type(2)");
      if (ctrl) ctrl.textContent = "⌘";
    }
    renderRecent();
    renderQuick();
  }

  // Al entrar a la vista (app.js → switchView): recientes al día, 2FA
  // retomado y, en PC, el cursor listo en el buscador para pegar.
  function onOpen() {
    init();
    renderRecent();
    resumeTotp();
    const input = $("cx-quick-input");
    if (input && isDesktop() && document.activeElement !== input && !overlayOpen()) {
      input.focus({ preventScroll: true });
      input.select();
    }
  }

  // Desde otras vistas (ej. «🔢 Código» en Accesos): abre Códigos, pone el
  // correo y lo busca.
  async function openFor(email) {
    init();
    const text = String(email ?? "").trim();
    if ($("view-codes").hidden) showCodesView();
    setQuickText(text);
    closeSugs();
    revealQuick();
    if (text) await submitQuick();
  }

  let initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    initSearchForm();
    initAccountsListActions();
    initQuick();
  }

  window.LiordarkCodes = { init, load, onOpen, openFor };
})();
