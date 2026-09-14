(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────

  function fmtMoney(n) {
    const num = Number(n) || 0;
    return "S/ " + num.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtDateShort(ymd) {
    const [, m, d] = ymd.split("-");
    const meses = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
    return `${Number(d)} ${meses[Number(m) - 1]}`;
  }

  function fmtDateLong(ymd) {
    const [y, m, d] = ymd.split("-");
    return `${d}/${m}/${y}`;
  }

  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString("es-PE", {
        timeZone: "America/Lima", hour: "2-digit", minute: "2-digit",
      });
    } catch { return ""; }
  }

  function todayLima() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
  }

  async function api(path, options = {}) {
    const res = await fetch("/api" + path, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (res.status === 401) {
      showLogin();
      throw new Error("No autenticado");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "Error de red");
    return data;
  }

  // ─────────────────────────────────────────────────────────────
  // SONIDO — beep generado en el navegador, sin archivo de audio
  // ─────────────────────────────────────────────────────────────

  let audioCtx = null;
  function playChime() {
    if (localStorage.getItem("ldp_muted") === "1") return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const now = audioCtx.currentTime;
      [880, 1320].forEach((freq, i) => {
        const osc  = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + i * 0.09);
        gain.gain.exponentialRampToValueAtTime(0.18, now + i * 0.09 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.35);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(now + i * 0.09);
        osc.stop(now + i * 0.09 + 0.4);
      });
    } catch { /* navegador sin soporte de audio — no crítico */ }
  }

  function initSoundToggle() {
    const btn = document.getElementById("sound-toggle");
    const muted = localStorage.getItem("ldp_muted") === "1";
    updateSoundBtn(btn, muted);
    btn.addEventListener("click", () => {
      const nowMuted = localStorage.getItem("ldp_muted") === "1";
      localStorage.setItem("ldp_muted", nowMuted ? "0" : "1");
      updateSoundBtn(btn, !nowMuted);
      if (nowMuted) playChime(); // feedback al reactivar
    });
  }
  function updateSoundBtn(btn, muted) {
    btn.textContent = muted ? "🔕" : "🔔";
    btn.classList.toggle("muted", muted);
    btn.title = muted ? "Sonido desactivado — clic para activar" : "Sonido activado — clic para silenciar";
  }

  // ─────────────────────────────────────────────────────────────
  // AUTH
  // ─────────────────────────────────────────────────────────────

  function showLogin() {
    document.getElementById("login-screen").hidden = false;
    document.getElementById("app").hidden = true;
  }
  function showApp() {
    document.getElementById("login-screen").hidden = true;
    document.getElementById("app").hidden = false;
  }

  async function checkAuth() {
    try {
      const { authenticated } = await api("/auth/me");
      if (authenticated) { showApp(); boot(); }
      else showLogin();
    } catch {
      showLogin();
    }
  }

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = document.getElementById("login-password").value;
    const errorEl = document.getElementById("login-error");
    errorEl.hidden = true;
    try {
      await api("/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      showApp();
      boot();
    } catch {
      errorEl.hidden = false;
    }
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    location.reload();
  });

  // ─────────────────────────────────────────────────────────────
  // TABS
  // ─────────────────────────────────────────────────────────────

  function initTabs() {
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        const view = btn.dataset.view;
        document.getElementById("view-live").hidden    = view !== "live";
        document.getElementById("view-history").hidden = view !== "history";
        if (view === "history") loadHistory();
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // STATS + FEED (vista en vivo)
  // ─────────────────────────────────────────────────────────────

  function renderStats(stats) {
    document.getElementById("stat-today-total").textContent   = fmtMoney(stats.today.total);
    document.getElementById("stat-today-count").textContent   = stats.today.count + (stats.today.count === 1 ? " pago" : " pagos");
    document.getElementById("stat-month-total").textContent   = fmtMoney(stats.month.total);
    document.getElementById("stat-month-count").textContent   = stats.month.count + (stats.month.count === 1 ? " pago" : " pagos");
    document.getElementById("stat-alltime-total").textContent = fmtMoney(stats.allTime.total);
    document.getElementById("stat-alltime-count").textContent = stats.allTime.count + (stats.allTime.count === 1 ? " pago" : " pagos");
  }

  function statusLabel(status) {
    if (status === "matched") return "Emparejado";
    if (status === "no_code") return "Sin código";
    return "Pendiente";
  }

  function renderFeedItem(p, isNew) {
    const li = document.createElement("li");
    li.className = "feed-item" + (isNew ? " is-new" : "");
    li.innerHTML = `
      <span class="feed-badge ${p.status}"></span>
      <div class="feed-main">
        <div class="feed-name">${escapeHtml(p.senderName)}</div>
        <div class="feed-time">${fmtTime(p.createdAt)} · ${statusLabel(p.status)}</div>
      </div>
      <div class="feed-amount">${fmtMoney(p.amount)}</div>
    `;
    return li;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function prependFeedItem(payment) {
    const list  = document.getElementById("feed-list");
    const empty = document.getElementById("feed-empty");
    empty.hidden = true;
    const item = renderFeedItem(payment, true);
    list.prepend(item);
    while (list.children.length > 50) list.removeChild(list.lastChild);
  }

  function renderFeedList(payments) {
    const list  = document.getElementById("feed-list");
    const empty = document.getElementById("feed-empty");
    list.innerHTML = "";
    if (payments.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;
    for (const p of payments) list.appendChild(renderFeedItem(p, false));
  }

  // ─────────────────────────────────────────────────────────────
  // CONEXIÓN EN VIVO
  // ─────────────────────────────────────────────────────────────

  function setConnIndicator(status) {
    const el = document.getElementById("conn-indicator");
    el.classList.remove("conn-connected", "conn-connecting");
    if (status === "connected") {
      el.classList.add("conn-connected");
      el.innerHTML = `<span class="conn-dot"></span> En vivo`;
    } else {
      el.classList.add("conn-connecting");
      el.innerHTML = `<span class="conn-dot"></span> Conectando…`;
    }
  }

  let evtSource = null;
  function connectLive() {
    if (evtSource) evtSource.close();
    evtSource = new EventSource("/api/live/stream");

    evtSource.onopen = () => setConnIndicator("connected");
    evtSource.onerror = () => setConnIndicator("connecting");

    evtSource.onmessage = (msg) => {
      let evt;
      try { evt = JSON.parse(msg.data); } catch { return; }

      if (evt.type === "connection") setConnIndicator(evt.status);

      if (evt.type === "payment") {
        prependFeedItem(evt.payment);
        playChime();
      }

      if (evt.type === "stats") {
        renderStats(evt.stats);
        refreshChartIfStale();
      }
    };
  }

  // ─────────────────────────────────────────────────────────────
  // GRÁFICO — últimos 30 días
  // ─────────────────────────────────────────────────────────────

  let chart = null;
  let lastChartLoad = 0;

  async function loadChart() {
    const { days } = await api("/history?days=30");
    const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));

    const labels = ordered.map(d => fmtDateShort(d.date));
    const totals = ordered.map(d => d.total);
    const today  = todayLima();

    const ctx = document.getElementById("chart-daily").getContext("2d");
    const barColors = ordered.map(d => d.date === today ? "#3987e5" : "rgba(57,135,229,0.55)");

    if (chart) chart.destroy();
    chart = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Ingresos",
          data: totals,
          backgroundColor: barColors,
          borderRadius: 4,
          maxBarThickness: 22,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => "S/ " + ctx.parsed.y.toLocaleString("es-PE", { minimumFractionDigits: 2 }),
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: "#898781", font: { size: 11 } },
          },
          y: {
            beginAtZero: true,
            grid: { color: "#2c2c2a" },
            ticks: {
              color: "#898781",
              font: { size: 11 },
              callback: (v) => "S/ " + v,
            },
          },
        },
      },
    });

    lastChartLoad = Date.now();
  }

  function refreshChartIfStale() {
    if (Date.now() - lastChartLoad > 30_000) loadChart();
  }

  // ─────────────────────────────────────────────────────────────
  // HISTORIAL
  // ─────────────────────────────────────────────────────────────

  async function loadHistory() {
    const { days } = await api("/history?days=90");
    const tbody = document.getElementById("history-tbody");
    tbody.innerHTML = "";

    for (const d of days) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${fmtDateLong(d.date)}</td>
        <td>${fmtMoney(d.total)}</td>
        <td>${d.count || "—"}</td>
        <td><span class="badge ${d.source}">${badgeLabel(d.source)}</span></td>
        <td>${d.source === "manual" ? `<button class="row-delete-btn" data-date="${d.date}">Borrar</button>` : ""}</td>
      `;
      tr.addEventListener("click", (e) => {
        if (e.target.closest(".row-delete-btn")) return;
        openDayDetail(d.date);
      });
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll(".row-delete-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("¿Borrar este registro manual?")) return;
        await api("/history/" + btn.dataset.date, { method: "DELETE" });
        loadHistory();
      });
    });
  }

  function badgeLabel(source) {
    if (source === "auto") return "Automático";
    if (source === "manual") return "Manual";
    return "Sin datos";
  }

  async function openDayDetail(date) {
    const info = await api("/history/" + date);
    document.getElementById("day-modal-title").textContent = fmtDateLong(date);
    const body = document.getElementById("day-modal-body");

    if (info.source === "none") {
      body.innerHTML = `<p>Sin datos para este día.</p>`;
    } else if (info.source === "manual") {
      body.innerHTML = `
        <div class="day-detail-row"><span>Total (manual)</span><b>${fmtMoney(info.total)}</b></div>
        ${info.note ? `<div class="day-detail-row"><span>Nota</span><span>${escapeHtml(info.note)}</span></div>` : ""}
      `;
    } else {
      const rows = info.payments.map(p => `
        <div class="day-detail-row">
          <span>${fmtTime(p.createdAt)} · ${escapeHtml(p.senderName)}</span>
          <b>${fmtMoney(p.amount)}</b>
        </div>
      `).join("");
      body.innerHTML = `
        <div class="day-detail-row"><span><b>Total del día</b></span><b>${fmtMoney(info.total)}</b></div>
        ${rows}
      `;
    }

    document.getElementById("day-modal").hidden = false;
  }
  document.getElementById("day-modal-close").addEventListener("click", () => {
    document.getElementById("day-modal").hidden = true;
  });

  // ── Modal: agregar día manual ──
  const manualModal = document.getElementById("manual-modal");
  document.getElementById("add-manual-btn").addEventListener("click", () => {
    document.getElementById("manual-form").reset();
    document.getElementById("manual-error").hidden = true;
    document.getElementById("manual-date").max = todayLima();
    manualModal.hidden = false;
  });
  document.getElementById("manual-cancel").addEventListener("click", () => { manualModal.hidden = true; });

  document.getElementById("manual-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const date   = document.getElementById("manual-date").value;
    const amount = document.getElementById("manual-amount").value;
    const note   = document.getElementById("manual-note").value;
    const errorEl = document.getElementById("manual-error");
    errorEl.hidden = true;

    try {
      await api("/history/" + date, {
        method: "PUT",
        body: JSON.stringify({ amount: Number(amount), note }),
      });
      manualModal.hidden = true;
      loadHistory();
      loadChart();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });

  // ─────────────────────────────────────────────────────────────
  // ARRANQUE
  // ─────────────────────────────────────────────────────────────

  let booted = false;
  async function boot() {
    if (booted) return;
    booted = true;

    initTabs();
    initSoundToggle();

    const { payments, stats } = await api("/live/initial");
    renderStats(stats);
    renderFeedList(payments);
    await loadChart();
    connectLive();
  }

  checkAuth();
})();
