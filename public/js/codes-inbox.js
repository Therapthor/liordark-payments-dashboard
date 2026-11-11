(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // CÓDIGOS — Bandeja, salud de fuentes y actividad (ver
  // services/codes-brain.service.ts). La pestaña «Cuentas» sigue siendo
  // la de siempre (codes.js). Lo nuevo llega en vivo por el stream del
  // panel (app.js → LiordarkCodesInbox.onLive).
  // ─────────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  async function api(path, options = {}) {
    const res = await fetch("/api/access" + path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...options });
    if (res.status === 401) { location.reload(); throw new Error("No autenticado"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "Error de red");
    return data;
  }

  // ── Tiempo ──
  const sqlToDate = (s) => (s ? new Date(String(s).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z")) : null);
  function itemDate(it) { return (it.receivedIso && new Date(it.receivedIso)) || sqlToDate(it.firstSeenAt); }
  function ago(d) {
    if (!d || isNaN(d)) return "";
    const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
    if (s < 45) return "hace un momento";
    if (s < 3600) return "hace " + Math.round(s / 60) + " min";
    if (s < 86400) return "hace " + Math.round(s / 3600) + " h";
    return "hace " + Math.round(s / 86400) + " d";
  }
  const clock = (d) => (d && !isNaN(d) ? d.toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "numeric", minute: "2-digit" }) : "");
  const dayClock = (d) => (d && !isNaN(d) ? d.toLocaleString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" }) : "");

  // ── Plataformas ──
  const PLATFORMS = [
    [/netflix/i, "netflix", "N"], [/disney/i, "disney", "D+"], [/prime|amazon/i, "prime", "P"],
    [/crunchy/i, "crunchy", "C"], [/chatgpt|openai/i, "chatgpt", "AI"], [/canva/i, "canva", "C"],
  ];
  function platformOf(name) {
    const hit = PLATFORMS.find(([re]) => re.test(name || ""));
    return hit ? { cls: hit[1], mark: hit[2] } : { cls: "other", mark: (name || "?").slice(0, 1).toUpperCase() };
  }

  // ── Estado de un correo de la bandeja ──
  function itemState(it) {
    if (it.accountChange) return { cls: "lock", text: "Cambio de cuenta" };
    if (!it.value) return { cls: "muted", text: "Sin código" };
    if (it.expired) return { cls: "muted", text: "Caducado" };
    const d = itemDate(it);
    // Enlaces de Netflix (acceso temporal) vencen a los 15 min.
    if (it.kind === "link" && d && Date.now() - d.getTime() > 15 * 60 * 1000) return { cls: "muted", text: "Vencido" };
    if (d && Date.now() - d.getTime() < 10 * 60 * 1000) return { cls: "new", text: "Nuevo" };
    return { cls: "ok", text: "Llegó" };
  }

  function valueHtml(it, big) {
    if (!it.value) return `<p class="cx-novalue">${esc(it.subject || "Correo sin código")}</p>`;
    // Netflix «Aprueba la nueva solicitud de inicio de sesión» (TV).
    if (it.kind === "link" && it.approval) {
      const a = it.approval;
      return `<div class="cx-approval">
          <span class="cx-approval-device">Solicitud de inicio de sesión${a.device ? " · " + esc(a.device) : ""}</span>
          <span class="cx-approval-btns">
            <a class="cx-linkbtn${big ? " big" : ""}" href="${esc(a.approveUrl)}" target="_blank" rel="noopener noreferrer">Aprobar</a>
            ${a.denyUrl ? `<a class="cx-linkbtn deny${big ? " big" : ""}" href="${esc(a.denyUrl)}" target="_blank" rel="noopener noreferrer">Rechazar</a>` : ""}
          </span>
        </div>`;
    }
    if (it.kind === "link") {
      return `<a class="cx-linkbtn${big ? " big" : ""}" href="${esc(it.value)}" target="_blank" rel="noopener noreferrer">Abrir enlace${/travel|temporal/i.test(it.value + it.subject) ? " · Obtener código" : ""}</a>`;
    }
    return `<button type="button" class="cx-code${big ? " big" : ""}" data-copy="${esc(it.value)}" title="Copiar">${esc(it.value)}</button>`;
  }

  // ── Bandeja ──
  let items = [];
  let lastIds = new Set();
  let filters = { q: "", source: "", onlyCodes: false };
  const recentlyArrived = new Set();

  function visibleItems() {
    const q = filters.q.trim().toLowerCase();
    return items.filter(it =>
      (!filters.source || it.sourceId === filters.source) &&
      (!filters.onlyCodes || it.value) &&
      (!q || [it.email, it.subject, it.value, it.platform].some(v => String(v || "").toLowerCase().includes(q))));
  }

  function cardHtml(it) {
    const p = platformOf(it.platform || it.sourceLabel);
    const st = itemState(it);
    const d = itemDate(it);
    return `
      <article class="cx-card p-${p.cls}${recentlyArrived.has(it.id) ? " arrived" : ""}" data-id="${it.id}">
        <header class="cx-card-head">
          <span class="cx-mark p-${p.cls}">${esc(p.mark)}</span>
          <div class="cx-card-who">
            <strong>${esc(it.platform || "—")}</strong>
            <span title="${esc(it.email)}">${esc(it.email)}</span>
          </div>
          <span class="cx-pill ${st.cls}">${esc(st.text)}</span>
        </header>
        <div class="cx-card-value">${valueHtml(it, false)}</div>
        <footer class="cx-card-foot">
          <span title="${esc(dayClock(d))}">${esc(ago(d))}${d ? " · " + esc(clock(d)) : ""}</span>
          <span class="cx-src">${esc(it.sourceLabel)}</span>
          ${it.hasHtml ? `<button type="button" class="cx-mini" data-mail="${it.id}">Ver correo</button>` : ""}
        </footer>
      </article>`;
  }

  function heroHtml(it) {
    const p = platformOf(it.platform || it.sourceLabel);
    const st = itemState(it);
    const d = itemDate(it);
    return `
      <div class="cx-hero-stripe p-${p.cls}"></div>
      <div class="cx-hero-body">
        <p class="cx-eyebrow">Último código <span class="cx-pill ${st.cls}">${esc(st.text)}</span></p>
        <div class="cx-hero-main">
          <div class="cx-hero-value">${valueHtml(it, true)}</div>
          <div class="cx-hero-info">
            <p class="cx-hero-platform"><span class="cx-mark p-${p.cls}">${esc(p.mark)}</span>${esc(it.platform || "—")}</p>
            <p class="cx-hero-email">${esc(it.email)}</p>
            <p class="cx-hero-meta">${esc(it.subject || "")}</p>
            <p class="cx-hero-meta">${esc(ago(d))}${d ? " · llegó a las " + esc(clock(d)) : ""} · ${esc(it.sourceLabel)}</p>
          </div>
        </div>
        <div class="cx-hero-actions">
          ${it.value && it.kind !== "link" ? `<button type="button" class="cx-btn" data-copy="${esc(it.value)}">Copiar código</button>` : ""}
          ${it.value && it.kind === "link" ? `<button type="button" class="cx-btn" data-copy="${esc(it.value)}">${it.approval ? "Copiar link de Aprobar" : "Copiar enlace"}</button>` : ""}
          ${it.hasHtml ? `<button type="button" class="cx-ghost-btn" data-mail="${it.id}">Ver correo</button>` : ""}
        </div>
      </div>`;
  }

  function renderInbox() {
    const list = $("cx-inbox-list");
    const vis = visibleItems();
    list.innerHTML = vis.map(cardHtml).join("");
    $("cx-inbox-empty").hidden = vis.length > 0;
    const withCode = items.filter(i => i.value);
    $("cx-inbox-count").textContent = withCode.length ? String(withCode.length) : "";

    const hero = $("cx-hero");
    const top = withCode[0];
    hero.hidden = !top;
    if (top) {
      hero.className = "cx-hero" + (recentlyArrived.has(top.id) ? " arrived" : "");
      hero.innerHTML = heroHtml(top);
    }
  }

  async function loadInbox() {
    try {
      const data = await api("/codes/inbox?limit=200");
      items = data.items || [];
      lastIds = new Set(items.map(i => i.id));
      renderInbox();
      paintWatcher(data.watcher);
    } catch { /* se reintenta al volver */ }
  }

  // ── Salud de las fuentes ──
  const STATE_TEXT = { ok: "Funciona", warn: "Con fallas", down: "Caída", idle: "Sin uso reciente" };
  let sourcesCache = [];

  function renderHealth(sources) {
    sourcesCache = sources;
    const ORDER = { down: 0, warn: 1, ok: 2, idle: 3 };
    const relevant = sources
      .filter(s => s.accounts > 0 || s.state !== "idle" || s.last24h.found || s.last24h.problems)
      .sort((a, b) => ORDER[a.state] - ORDER[b.state]);
    $("cx-health").innerHTML = relevant.map(s => {
      const detail = s.state === "down" || s.state === "warn"
        ? (s.lastError ? s.lastError.message : "")
        : s.lastFoundAt ? "Último código " + ago(new Date(s.lastFoundAt))
        : s.lastOkAt ? "Respondió " + ago(new Date(s.lastOkAt))
        : s.last24h.problems && s.lastError ? `${s.last24h.problems} problema${s.last24h.problems === 1 ? "" : "s"} hoy · ${s.lastError.message}`
        : s.last24h.found ? `${s.last24h.found} código${s.last24h.found === 1 ? "" : "s"} hoy`
        : "Aún sin consultas hoy";
      return `
        <div class="cx-src-chip s-${s.state}" title="${esc(STATE_TEXT[s.state] + (s.lastError ? " · último error: " + s.lastError.message : ""))}">
          <span class="cx-src-dot"></span>
          <div>
            <strong>${esc(s.label)}</strong>
            <span>${esc(s.accounts)} cuenta${s.accounts === 1 ? "" : "s"}${s.watched ? " · se vigila sola" : ""}</span>
            <span class="cx-src-detail">${esc(detail)}</span>
          </div>
        </div>`;
    }).join("");

    // Desplegable de fuentes de la bandeja.
    const sel = $("cx-inbox-source");
    const current = sel.value;
    sel.innerHTML = `<option value="">Todas las fuentes</option>` +
      sources.map(s => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join("");
    sel.value = current;
  }

  function paintWatcher(w) {
    const el = $("cx-watch-text");
    if (!w) return;
    if (w.running) { el.textContent = "Revisando ahora…"; return; }
    el.textContent = w.last
      ? `Vigilando · revisado ${ago(new Date(w.last.at))}`
      : `Vigilando cada ${w.intervalMinutes} min`;
  }

  async function loadHealth() {
    try {
      const data = await api("/codes/health");
      renderHealth(data.sources || []);
      paintWatcher(data.watcher);
    } catch { /* nada */ }
  }

  // ── Actividad ──
  const STATUS = {
    found:          { icon: "✓", cls: "ok",   text: "Llegó" },
    not_found:      { icon: "…", cls: "wait", text: "Aún no llega" },
    wrong_source:   { icon: "!", cls: "warn", text: "Correo de otra fuente" },
    session:        { icon: "⟳", cls: "bad",  text: "Sesión del proveedor" },
    provider:       { icon: "!", cls: "bad",  text: "Error del proveedor" },
    network:        { icon: "⌁", cls: "bad",  text: "Sin conexión" },
    timeout:        { icon: "⌛", cls: "bad",  text: "No respondió" },
    client_waiting: { icon: "☎", cls: "warn", text: "Cliente esperando" },
  };
  const ORIGIN = { cliente: "Cliente", panel: "Panel", busqueda: "Búsqueda", asistente: "Asistente", vigilante: "Vigilante" };

  async function loadActivity() {
    try {
      const onlyProblems = $("cx-only-problems").checked;
      const { rows } = await api("/codes/activity?limit=200" + (onlyProblems ? "&problems=1" : ""));
      const list = $("cx-activity-list");
      list.innerHTML = rows.map(r => {
        const st = STATUS[r.status] || { icon: "•", cls: "wait", text: r.status };
        const d = sqlToDate(r.at);
        return `
          <li class="cx-act ${st.cls}">
            <span class="cx-act-icon" aria-hidden="true">${st.icon}</span>
            <div class="cx-act-body">
              <p class="cx-act-top"><strong>${esc(st.text)}</strong><span class="cx-chip">${esc(ORIGIN[r.origin] || r.origin)}</span><span class="cx-act-src">${esc(r.sourceLabel)}</span></p>
              <p class="cx-act-msg">${esc(r.message)}</p>
              <p class="cx-act-meta">${esc(r.email)} · ${esc(dayClock(d))}${r.ms ? " · " + (r.ms / 1000).toFixed(1) + " s" : ""}${r.relogged ? " · sesión renovada" : ""}</p>
            </div>
          </li>`;
      }).join("");
      $("cx-activity-empty").hidden = rows.length > 0;
      const problems = rows.filter(r => !["found", "not_found"].includes(r.status)).length;
      const badge = $("cx-problems-count");
      badge.hidden = !problems || onlyProblems;
      badge.textContent = problems ? String(problems) : "";
    } catch { /* nada */ }
  }

  // ── Pendientes: pedidos de clientes y fila de cada proveedor ──
  let requests = [], lanes = [];
  const mmss = (sec) => Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0");
  const REQ_STATE = {
    searching:  { icon: "⌛", cls: "wait", text: "Buscando" },
    found:      { icon: "✓", cls: "ok",   text: "Llegó · el cliente lo está viendo" },
    delivered:  { icon: "✓", cls: "ok",   text: "Entregado" },
    unresolved: { icon: "!", cls: "bad",  text: "Se venció sin código" },
    closed:     { icon: "•", cls: "wait", text: "Cerrado sin código" },
  };
  const LAST_STATE = {
    not_found: "Aún no llega", old: "Solo hay uno viejo o vencido", problem: "El proveedor falló", not_login: "Llegó un correo que no es de inicio de sesión",
  };

  function waitedSec(r) {
    if (r.status !== "searching") return r.waitedSec;
    const c = sqlToDate(r.createdAt);
    return c ? Math.max(0, (Date.now() - c.getTime()) / 1000) : r.waitedSec;
  }

  function renderLanes() {
    const box = $("cx-lanes");
    box.innerHTML = lanes.map(l => {
      const pause = l.cooldownUntil ? Math.max(0, Math.round((new Date(l.cooldownUntil) - Date.now()) / 1000)) : 0;
      const cls = pause ? "warn" : l.busy || l.queued ? "busy" : "ok";
      const text = pause ? `Pausa ${pause} s: el proveedor pidió esperar`
        : l.busy ? `Consultando${l.queued ? " · " + l.queued + " en fila" : ""}`
        : l.queued ? `${l.queued} en fila` : "Libre";
      return `<span class="cx-lane ${cls}" title="${esc(l.lastError || "")}"><b>${esc(l.label)}</b> ${esc(text)}</span>`;
    }).join("");
    box.hidden = !lanes.length;
  }

  function renderRequests() {
    if (!$("cx-req-list")) return;
    const list = $("cx-req-list");
    list.innerHTML = requests.map(r => {
      const st = REQ_STATE[r.status] || REQ_STATE.closed;
      const sec = waitedSec(r);
      const last = sqlToDate(r.lastCheckAt);
      const what = r.foundKind === "link" ? "Link" : "Código";
      const found = r.foundValue
        ? `<p class="cx-act-msg">${what} de inicio de sesión: ${r.foundKind === "link" ? `<a href="${esc(r.foundValue)}" target="_blank" rel="noopener">abrir link</a>` : `<b class="cx-req-code">${esc(r.foundValue)}</b>`} · llegó en ${mmss(sec)}</p>`
        : `<p class="cx-act-msg">${esc((LAST_STATE[r.lastState] ? LAST_STATE[r.lastState] + ": " : "") + (r.lastMessage || (r.status === "searching" ? "En fila para la primera consulta…" : "")))}</p>`;
      return `
        <li class="cx-act ${st.cls}">
          <span class="cx-act-icon${r.status === "searching" ? " spin" : ""}" aria-hidden="true">${st.icon}</span>
          <div class="cx-act-body">
            <p class="cx-act-top"><strong>${esc(st.text)}${r.status === "searching" ? " · " + mmss(sec) : ""}</strong>
              <span class="cx-chip">${esc(r.platform || "")}</span><span class="cx-act-src">${esc(r.sourceLabel)}</span></p>
            ${found}
            <p class="cx-act-meta">${esc(r.email)}${r.clientPhone ? " · cliente " + esc(r.clientPhone) : ""} · ${r.attempts} búsqueda${r.attempts === 1 ? "" : "s"}${last ? " · última " + esc(ago(last)) : ""}${r.extendedMinutes ? " · link alargado " + r.extendedMinutes + " min" : ""}</p>
          </div>
          ${r.status === "searching" ? `<button type="button" class="cx-ghost-btn" data-rush="${esc(r.token)}"${r.checking ? " disabled" : ""}>${r.checking ? "Consultando…" : "Revisar ya"}</button>` : ""}
        </li>`;
    }).join("");
    $("cx-req-empty").hidden = requests.length > 0;
    const waiting = requests.filter(r => r.status === "searching").length;
    $("cx-req-count").textContent = waiting ? String(waiting) : "";
    renderLanes();
  }

  async function loadRequests() {
    try {
      const data = await api("/codes/requests");
      requests = data.requests || [];
      lanes = data.lanes || [];
      renderRequests();
    } catch { /* nada */ }
  }

  // ── Correo completo ──
  async function openMail(id) {
    const dlg = $("cx-mail");
    $("cx-mail-subject").textContent = "Cargando…";
    $("cx-mail-meta").textContent = "";
    $("cx-mail-frame").srcdoc = "";
    if (!dlg.open) dlg.showModal();
    try {
      const { item, html } = await api("/codes/inbox/" + id);
      $("cx-mail-subject").textContent = item.subject || "Correo";
      const d = itemDate(item);
      $("cx-mail-meta").textContent = `${item.email} · ${dayClock(d)} · ${item.sourceLabel}`;
      $("cx-mail-frame").srcdoc = html || "<p style='font-family:system-ui;padding:16px'>El correo completo ya no está guardado (se guarda 2 días).</p>";
    } catch (e) {
      $("cx-mail-subject").textContent = e.message;
    }
  }

  async function copy(text, el) {
    try { await navigator.clipboard.writeText(text); } catch { prompt("Copia:", text); return; }
    if (!el) return;
    el.classList.add("copied");
    const prev = el.dataset.label || el.textContent;
    el.dataset.label = prev;
    if (el.classList.contains("cx-btn")) el.textContent = "Copiado ✓";
    setTimeout(() => { el.classList.remove("copied"); if (el.classList.contains("cx-btn")) el.textContent = prev; }, 1400);
  }

  // ── Pestañas ──
  let tab = "requests";
  function showTab(name) {
    tab = name;
    document.querySelectorAll(".cx-tab").forEach(b => b.classList.toggle("active", b.dataset.cxTab === name));
    ["requests", "inbox", "accounts", "activity"].forEach(n => { $("cx-pane-" + n).hidden = n !== name; });
    if (name === "activity") loadActivity();
    if (name === "requests") loadRequests();
    if (name === "accounts" && window.LiordarkCodes) window.LiordarkCodes.load();
  }

  // ── En vivo ──
  function onLive(evt) {
    if (evt.type === "code_request" && evt.request) {
      const r = evt.request;
      const idx = requests.findIndex(x => x.token === r.token);
      if (idx >= 0) requests[idx] = r; else requests.unshift(r);
      requests.sort((a, b) => (b.status === "searching") - (a.status === "searching") || String(b.createdAt).localeCompare(String(a.createdAt)));
      renderRequests();
    }
    if (evt.type === "code_inbox" && evt.item) {
      const it = evt.item;
      const idx = items.findIndex(x => x.id === it.id);
      if (idx >= 0) items[idx] = it; else items.unshift(it);
      items.sort((a, b) => (itemDate(b)?.getTime() || 0) - (itemDate(a)?.getTime() || 0));
      if (!lastIds.has(it.id) && it.value) {
        recentlyArrived.add(it.id);
        setTimeout(() => { recentlyArrived.delete(it.id); }, 8000);
      }
      lastIds.add(it.id);
      renderInbox();
    }
  }

  let ticker = null;
  function init() {
    if (!$("view-codes")) return;
    document.querySelectorAll(".cx-tab").forEach(b => b.addEventListener("click", () => showTab(b.dataset.cxTab)));
    $("cx-inbox-search").addEventListener("input", e => { filters.q = e.target.value; renderInbox(); });
    $("cx-inbox-source").addEventListener("change", e => { filters.source = e.target.value; renderInbox(); });
    $("cx-only-codes").addEventListener("change", e => { filters.onlyCodes = e.target.checked; renderInbox(); });
    $("cx-only-problems").addEventListener("change", loadActivity);
    $("cx-watch-now").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      $("cx-watch-text").textContent = "Revisando ahora…";
      try { const r = await api("/codes/watch-now", { method: "POST" }); paintWatcher(r.watcher); } catch (err) { $("cx-watch-text").textContent = err.message; }
      btn.disabled = false;
      loadInbox(); loadHealth();
    });
    $("view-codes").addEventListener("click", e => {
      const c = e.target.closest("[data-copy]");
      if (c) { copy(c.dataset.copy, c); return; }
      const m = e.target.closest("[data-mail]");
      if (m) { openMail(m.dataset.mail); return; }
      const rush = e.target.closest("[data-rush]");
      if (rush) {
        rush.disabled = true; rush.textContent = "En fila…";
        api("/codes/requests/" + encodeURIComponent(rush.dataset.rush) + "/now", { method: "POST" }).catch(() => {});
      }
    });
    $("cx-mail-close").addEventListener("click", () => $("cx-mail").close());
    $("cx-mail").addEventListener("click", e => { if (e.target === $("cx-mail")) $("cx-mail").close(); });
  }

  // Al entrar a la vista: todo fresco + reloj de «hace X min».
  let reqTicker = null;
  function open() {
    loadInbox(); loadHealth(); loadRequests();
    if (tab === "activity") loadActivity();
    clearInterval(ticker);
    ticker = setInterval(() => {
      if ($("view-codes").hidden || document.hidden) return;
      renderInbox(); loadHealth();
      if (tab === "activity") loadActivity();
    }, 30_000);
    // Pendientes: reloj de espera cada segundo y estado fresco cada 10 s.
    clearInterval(reqTicker);
    let n = 0;
    reqTicker = setInterval(() => {
      if ($("view-codes").hidden || document.hidden) return;
      if (++n % 10 === 0) loadRequests(); else if (tab === "requests") renderRequests();
    }, 1000);
  }

  init();
  window.LiordarkCodesInbox = { open, onLive, setAccountsCount: (n) => { $("cx-accounts-count").textContent = n ? String(n) : ""; } };
})();
