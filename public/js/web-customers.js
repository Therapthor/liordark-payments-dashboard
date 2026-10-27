(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // CLIENTES DE LA TIENDA WEB (liordark.com) — lista de cuentas
  // registradas, con su contraseña (guardada en texto plano, igual
  // que las cuentas de streaming en Accesos) para poder reenviarla,
  // cuántas cuentas se le entregaron, y acciones de suspender/banear.
  // ─────────────────────────────────────────────────────────────

  async function api(path, options) {
    const res = await fetch("/api/customers" + path, {
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

  function waLink(phone, text) {
    const digits = String(phone).replace(/\D/g, "");
    return "https://api.whatsapp.com/send?phone=" + digits + "&text=" + encodeURIComponent(text);
  }

  // SQLite guarda created_at como "YYYY-MM-DD HH:MM:SS" (UTC, sin
  // indicarlo) — sin la "Z" el navegador lo toma como hora LOCAL y la
  // muestra corrida (5h antes/después según el huso). Se normaliza a
  // ISO con "Z" antes de parsearla.
  function formatDate(iso) {
    try {
      const isoUtc = /[Zz]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.replace(" ", "T") + "Z";
      return new Date(isoUtc).toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return iso;
    }
  }

  function renderRow(c) {
    const div = document.createElement("div");
    div.className = "web-customer-row";
    div.dataset.id = c.id === null ? "" : c.id;
    div.dataset.email = c.email || "";

    const purchaseLabel = c.purchaseCount === 1 ? "1 compra" : `${c.purchaseCount} compras`;

    // id === null = registro general — no tiene cuenta real en este
    // panel (nunca se registró en liordark.com), solo existe porque
    // alguna vez le asignaron una cuenta en Accesos. No hay contraseña
    // ni se puede suspender/banear algo que no es una cuenta de login.
    if (c.id === null) {
      div.innerHTML = `
        <div class="web-customer-main">
          <span class="web-customer-phone">${escapeHtml(c.phone)}</span>
          <span class="web-customer-status">📋 Registro general</span>
        </div>
        <div class="web-customer-sub">${formatDate(c.createdAt)} · ${purchaseLabel}</div>`;
      return div;
    }

    const originBadge = c.isGuest
      ? `<span class="web-customer-badge web-customer-badge-guest">Automática</span>`
      : `<span class="web-customer-badge web-customer-badge-own">Registro propio</span>`;

    const statusBadge = c.suspended
      ? `<span class="web-customer-status web-customer-status-suspended">⏸ Suspendida hasta ${formatDate(c.suspendedUntil)}</span>`
      : `<span class="web-customer-status">✅ Cuenta creada</span>`;

    const emailArea = c.email
      ? `<span class="web-customer-email">✉️ ${escapeHtml(c.email)}</span>
         <button class="btn-secondary btn-sm web-customer-email-btn" type="button">✏️ Cambiar correo</button>`
      : `<span class="web-customer-email web-customer-email-none">Sin correo de aviso</span>
         <button class="btn-secondary btn-sm web-customer-email-btn" type="button">✉️ Agregar correo</button>`;

    // Cuentas registradas antes de guardar password_plain no tienen
    // contraseña visible (quedó solo como hash) — se les puede generar
    // una nueva en vez de mostrar un envío vacío.
    const passwordArea = c.password
      ? `
        <span class="web-customer-password">${escapeHtml(c.password)}</span>
        <a class="btn-secondary btn-sm" href="${waLink(c.phone, `Hola! Estos son tus accesos a Manguitope 🥭\n\nCelular: ${c.phone}\nContraseña: ${c.password}\n\nEntrá en https://liordark.com para comprar.`)}" target="_blank" rel="noopener">📲 Enviar accesos</a>`
      : `
        <span class="web-customer-password web-customer-password-none">Sin contraseña guardada</span>
        <button class="btn-secondary btn-sm web-customer-reset-btn" type="button">🔑 Generar contraseña</button>`;

    div.innerHTML = `
      <div class="web-customer-main">
        <span class="web-customer-phone">${escapeHtml(c.phone)}</span>
        ${originBadge}
        ${statusBadge}
      </div>
      <div class="web-customer-sub">${formatDate(c.createdAt)} · ${purchaseLabel}</div>
      <div class="web-customer-actions">
        ${passwordArea}
        ${emailArea}
        <button class="btn-secondary btn-sm web-customer-suspend-btn" type="button">⏸ Suspender</button>
        <button class="btn-danger btn-sm web-customer-ban-btn" type="button">🚫 Banear</button>
      </div>`;
    return div;
  }

  async function suspend(id, row) {
    if (!confirm("¿Suspender esta cuenta por 3 días? El cliente no va a poder iniciar sesión hasta entonces.")) return;
    try {
      await api(`/${id}/suspend`, { method: "POST" });
      await load();
    } catch (err) {
      alert(err.message);
    }
  }

  async function resetPassword(id) {
    if (!confirm("Esto le genera una contraseña NUEVA al cliente (la original no se puede recuperar). ¿Continuar?")) return;
    try {
      await api(`/${id}/reset-password`, { method: "POST" });
      await load();
    } catch (err) {
      alert(err.message);
    }
  }

  async function setEmail(id, currentEmail) {
    const email = prompt("Correo de aviso de vencimiento para este cliente:", currentEmail || "");
    if (email === null) return; // canceló
    if (!email.trim()) return alert("Escribe un correo.");
    try {
      await api(`/${id}/email`, { method: "POST", body: JSON.stringify({ email: email.trim() }) });
      await load();
    } catch (err) {
      alert(err.message);
    }
  }

  async function ban(id) {
    if (!confirm("Esto BORRA la cuenta y su contraseña de este panel. No se puede deshacer. ¿Continuar?")) return;
    if (!confirm("Confirmá de nuevo: ¿estás seguro de banear y borrar esta cuenta?")) return;
    try {
      await api(`/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      alert(err.message);
    }
  }

  function initRowActions(list) {
    list.addEventListener("click", (e) => {
      const row = e.target.closest(".web-customer-row");
      if (!row) return;
      const id = Number(row.dataset.id);
      if (e.target.closest(".web-customer-suspend-btn")) suspend(id, row);
      if (e.target.closest(".web-customer-reset-btn")) resetPassword(id);
      if (e.target.closest(".web-customer-email-btn")) setEmail(id, row.dataset.email);
      if (e.target.closest(".web-customer-ban-btn")) ban(id);
    });
  }

  // Se guarda el último fetch para filtrar por celular sin golpear al
  // servidor en cada tecla — mismo patrón que "Pedidos pendientes". Se
  // divide en dos grupos: "Web" (tiene cuenta real en este panel —
  // registrada o automática por compra, con contraseña y acciones) y
  // "Registro" (sin cuenta real, solo existe en Accesos — id: null).
  let cachedCustomers = [];
  let webSearchDigits = "";
  let registroSearchDigits = "";
  let webSort = "recent";

  function sortWebCustomers(list) {
    if (webSort === "purchases-desc") return [...list].sort((a, b) => b.purchaseCount - a.purchaseCount);
    if (webSort === "purchases-asc")  return [...list].sort((a, b) => a.purchaseCount - b.purchaseCount);
    return list; // "recent" — ya viene ordenado por fecha desde el servidor
  }

  function renderWebList() {
    const list  = document.getElementById("web-customers-list");
    const empty = document.getElementById("web-customers-empty");
    const webCustomers = cachedCustomers.filter(c => c.id !== null);
    const filtered = webSearchDigits
      ? webCustomers.filter(c => c.phone.replace(/\D/g, "").includes(webSearchDigits))
      : webCustomers;

    list.innerHTML = "";
    if (filtered.length === 0) {
      empty.hidden = false;
      empty.textContent = webSearchDigits
        ? "Sin resultados para ese número."
        : "Todavía no hay clientes con cuenta en liordark.com.";
    } else {
      empty.hidden = true;
      sortWebCustomers(filtered).forEach(c => list.appendChild(renderRow(c)));
    }
  }

  function renderRegistroList() {
    const list  = document.getElementById("registro-customers-list");
    const empty = document.getElementById("registro-customers-empty");
    const registroCustomers = cachedCustomers.filter(c => c.id === null);
    const filtered = registroSearchDigits
      ? registroCustomers.filter(c => c.phone.replace(/\D/g, "").includes(registroSearchDigits))
      : registroCustomers;

    list.innerHTML = "";
    if (filtered.length === 0) {
      empty.hidden = false;
      empty.textContent = registroSearchDigits
        ? "Sin resultados para ese número."
        : "Todavía no hay clientes solo en Accesos (sin cuenta en liordark.com).";
    } else {
      empty.hidden = true;
      filtered.forEach(c => list.appendChild(renderRow(c)));
    }
  }

  function initSearch() {
    const webInput    = document.getElementById("web-customers-search");
    const webClearBtn = document.getElementById("web-customers-search-clear");
    webInput.addEventListener("input", () => {
      webSearchDigits = webInput.value.replace(/\D/g, "");
      webClearBtn.hidden = !webSearchDigits;
      renderWebList();
    });
    webClearBtn.addEventListener("click", () => {
      webInput.value = "";
      webSearchDigits = "";
      webClearBtn.hidden = true;
      renderWebList();
    });

    document.getElementById("web-customers-sort").addEventListener("change", (e) => {
      webSort = e.target.value;
      renderWebList();
    });

    const registroInput    = document.getElementById("registro-customers-search");
    const registroClearBtn = document.getElementById("registro-customers-search-clear");
    registroInput.addEventListener("input", () => {
      registroSearchDigits = registroInput.value.replace(/\D/g, "");
      registroClearBtn.hidden = !registroSearchDigits;
      renderRegistroList();
    });
    registroClearBtn.addEventListener("click", () => {
      registroInput.value = "";
      registroSearchDigits = "";
      registroClearBtn.hidden = true;
      renderRegistroList();
    });
  }

  function initCustomersSubnav() {
    document.querySelectorAll("[data-customers-section]").forEach(btn => {
      btn.addEventListener("click", () => {
        const section = btn.dataset.customersSection;
        document.querySelectorAll("[data-customers-section]").forEach(b => b.classList.toggle("active", b === btn));
        document.getElementById("customers-section-web").hidden     = section !== "web";
        document.getElementById("customers-section-registro").hidden = section !== "registro";
      });
    });
  }

  async function load() {
    const list = document.getElementById("web-customers-list");
    try {
      const { customers } = await api("/");
      cachedCustomers = customers || [];
      renderWebList();
      renderRegistroList();
    } catch (err) {
      list.innerHTML = `<p class="feed-empty">${escapeHtml(err.message)}</p>`;
    }
    loadStats();
  }

  // ─────────────────────────────────────────────────────────────
  // RESUMEN + CURVA — total de clientes y registros por día del mes,
  // para ver de un vistazo si el tráfico de la web sube o baja.
  // ─────────────────────────────────────────────────────────────

  let statsChart = null;

  function fmtDayShort(dateStr) {
    const parts = dateStr.split("-");
    return `${parts[2]}/${parts[1]}`;
  }

  async function loadStats() {
    try {
      const { totalCustomers, customersWithEmail, registrationsThisMonth } = await api("/stats");
      document.getElementById("web-customers-total").textContent = totalCustomers;
      document.getElementById("web-customers-with-email").textContent = customersWithEmail;

      const canvas = document.getElementById("chart-web-customers");
      if (!canvas || typeof Chart === "undefined") return;

      const labels    = registrationsThisMonth.map(r => fmtDayShort(r.date));
      const counts    = registrationsThisMonth.map(r => r.count);
      const todayIdx  = registrationsThisMonth.length - 1;
      const barColors = registrationsThisMonth.map((_, i) => i === todayIdx ? "#d6900f" : "rgba(245,166,35,0.55)");

      if (statsChart) statsChart.destroy();
      statsChart = new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: {
          labels,
          datasets: [{ label: "Registros", data: counts, backgroundColor: barColors, borderRadius: 4, maxBarThickness: 22 }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: { label: (ctx) => ctx.parsed.y + (ctx.parsed.y === 1 ? " registro" : " registros") },
            },
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: "#9a9a9a", font: { size: 11 } } },
            y: { beginAtZero: true, ticks: { color: "#9a9a9a", font: { size: 11 }, precision: 0 }, grid: { color: "#efefef" } },
          },
        },
      });
    } catch { /* no crítico — la lista de clientes ya se mostró igual */ }
  }

  initRowActions(document.getElementById("web-customers-list"));
  initRowActions(document.getElementById("registro-customers-list"));
  initSearch();
  initCustomersSubnav();

  // "En tiempo real" — mientras esta pestaña esté abierta, se refresca
  // sola cada 20s (sin recargar la página) para reflejar registros
  // nuevos o asignaciones manuales recién hechas en Accesos.
  const LIVE_POLL_MS = 20_000;
  setInterval(() => {
    const view = document.getElementById("view-web-customers");
    if (view && !view.hidden) load();
  }, LIVE_POLL_MS);

  window.LiordarkWebCustomers = { load };
})();
