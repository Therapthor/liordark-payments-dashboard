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
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function waLink(phone, text) {
    let digits = String(phone).replace(/\D/g, "");
    if (digits.length === 9) digits = "51" + digits;
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

  // En la lista se ve solo el número (9 dígitos), sin el 51.
  function localPhone(phone) {
    const d = String(phone ?? "").replace(/\D/g, "");
    return d.length === 11 && d.startsWith("51") ? d.slice(2) : d;
  }

  function renderRow(c) {
    const div = document.createElement("div");
    div.className = "web-customer-row";
    div.dataset.id = c.id === null ? "" : c.id;
    div.dataset.email = c.email || "";
    div.dataset.phone = c.phone || "";

    const purchaseLabel = c.purchaseCount === 1 ? "1 compra" : `${c.purchaseCount} compras`;

    // id === null = registro general — no tiene cuenta real en este
    // panel (nunca se registró en liordark.com), solo existe porque
    // alguna vez le asignaron una cuenta en Accesos. No hay contraseña
    // ni se puede suspender/banear algo que no es una cuenta de login.
    if (c.id === null) {
      div.innerHTML = `
        <div class="web-customer-main">
          <span class="web-customer-phone">${escapeHtml(localPhone(c.phone))}</span>
          <span class="web-customer-status">📋 Registro general</span>
        </div>
        <div class="web-customer-sub">${formatDate(c.createdAt)} · ${purchaseLabel}</div>
        <div class="web-customer-actions">
          <button class="btn-secondary btn-sm web-customer-access-btn" type="button">🔑 Dar acceso web (link por WhatsApp)</button>
          <button class="btn-danger btn-sm web-customer-fraud-btn" type="button">🚨 Fraude</button>
        </div>`;
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
        <a class="btn-secondary btn-sm" href="${waLink(c.phone, `Hola! Estos son tus accesos a Manguitope 🥭\n\nCelular: ${localPhone(c.phone)}\nContraseña: ${c.password}\n\nEntrá en https://liordark.com para comprar.`)}" target="_blank" rel="noopener">📲 Enviar accesos</a>`
      : `
        <span class="web-customer-password web-customer-password-none">${c.pinRecovery === "not_found" ? "Clave antigua (no es PIN de 4 números)" : "Buscando su PIN…"}</span>
        <button class="btn-secondary btn-sm web-customer-reset-btn" type="button">🔑 Generar contraseña</button>`;

    // Bloqueo por intentos fallidos de PIN (3+ fallos: 1 a 15 min).
    const blockedBadge = c.blocked ? `<span class="web-customer-status web-customer-status-locked">🚫 Bloqueado</span>` : "";
    const lockBadge = c.lockedUntil
      ? `<span class="web-customer-status web-customer-status-locked">🔒 Bloqueada por intentos · hasta ${new Date(c.lockedUntil).toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit" })}</span>
         <button class="btn-secondary btn-sm web-customer-unlock-btn" type="button">🔓 Quitar bloqueo</button>`
      : "";

    div.innerHTML = `
      <div class="web-customer-main">
        <span class="web-customer-phone">${escapeHtml(localPhone(c.phone))}</span>
        ${originBadge}
        ${statusBadge}
        ${blockedBadge}
        ${lockBadge}
      </div>
      <div class="web-customer-sub">${formatDate(c.createdAt)} · ${purchaseLabel}</div>
      <div class="web-customer-actions">
        ${passwordArea}
        <button class="btn-secondary btn-sm web-customer-pinlink-btn" type="button">🔑 Link cambio de PIN</button>
        <button class="btn-secondary btn-sm web-customer-resetpin-btn" type="button">♻️ Resetear PIN y cerrar sesión</button>
        ${emailArea}
        <button class="btn-secondary btn-sm web-customer-suspend-btn" type="button">⏸ Suspender</button>
        <button class="btn-danger btn-sm web-customer-ban-btn" type="button">🚫 Banear</button>
        <button class="btn-danger btn-sm web-customer-fraud-btn" type="button" title="Borra su cuenta, bloquea el número y libera todas sus cuentas">🚨 Fraude</button>
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

  async function resetPin(id) {
    if (!confirm("Se le pondrá un PIN nuevo y se cerrará su sesión en todos sus dispositivos. ¿Continuar?")) return;
    try {
      const r = await api(`/${id}/reset-pin`, { method: "POST" });
      alert("✅ PIN nuevo: " + r.pin + "\nSu sesión se cerró en todos sus dispositivos. Envíale el link de cambio de PIN si debe crear el suyo.");
      await load();
    } catch (err) { alert(err.message); }
  }

  // Número que ya compró pero no tiene acceso web: se crea y se le manda el
  // link de PIN a SU WhatsApp (solo el dueño real puede abrirlo).
  async function createAccess(phone) {
    try {
      const r = await api(`/create-access`, { method: "POST", body: JSON.stringify({ phone }) });
      await load();
      openPinLink(r.id, r.phone);
    } catch (err) { alert(err.message); }
  }

  // 🚨 Fraude: borra la cuenta, bloquea el número y libera todas sus cuentas.
  async function markFraud(phone) {
    if (!confirm(`¿Marcar ${localPhone(phone)} como FRAUDE?\n\nSe borra su cuenta web, se bloquea el número y se le quitan TODAS sus cuentas (los perfiles quedan libres).`)) return;
    try {
      const r = await api("/fraud", { method: "POST", body: JSON.stringify({ phone }) });
      const list = [...r.released.map(p => `• ${p.platform} · ${p.email}${p.profileName ? " · " + p.profileName : ""}`),
                    ...r.overridesRemoved.map(o => `• ${o.platform} · ${o.email} (reemplazo)`)];
      alert(list.length
        ? `Listo. Se liberaron ${list.length} cuenta(s) — cámbiales la contraseña:\n\n${list.join("\n")}`
        : "Listo. Cuenta borrada y número bloqueado (no tenía cuentas asignadas).");
      await load();
    } catch (err) { alert(err.message); }
  }

  async function unlock(id) {
    try {
      await api(`/${id}/unlock`, { method: "POST" });
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

  // ─── Link para que el cliente cambie su PIN (10 min, un solo uso) ───
  let pinPoll = null;
  let pinTick = null;

  function closePinLink() {
    clearInterval(pinPoll); pinPoll = null;
    clearInterval(pinTick); pinTick = null;
    document.getElementById("pin-link-back").hidden = true;
  }

  async function openPinLink(id, phone) {
    const $ = (x) => document.getElementById(x);
    closePinLink();
    $("pin-link-back").hidden = false;
    $("pin-link-sub").textContent = localPhone(phone);
    $("pin-link-url").textContent = "Generando…";
    $("pin-link-wa").removeAttribute("href");
    $("pin-link-status").textContent = "Vale 10 min · se usa una sola vez";
    let link;
    try {
      link = await api(`/${id}/pin-link`, { method: "POST" });
    } catch (err) {
      $("pin-link-url").textContent = err.message;
      return;
    }
    $("pin-link-url").textContent = link.url;
    const text = `Hola! Para cambiar tu PIN de Manguitope entra aquí (vale ${link.minutes} min):\n${link.url}`;
    $("pin-link-wa").href = waLink(phone, text);
    $("pin-link-copy").onclick = () => {
      navigator.clipboard.writeText(link.url).then(() => {
        $("pin-link-copy").textContent = "Copiado";
        setTimeout(() => { $("pin-link-copy").textContent = "Copiar"; }, 1500);
      }).catch(() => {});
    };

    const expires = new Date(link.expiresAt).getTime();
    let state = { state: "active", openedAt: null };
    const draw = () => {
      const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
      const st = $("pin-link-status");
      if (state.state === "used") { st.textContent = "✅ El cliente ya cambió su PIN"; return stop(); }
      if (state.state === "expired" || left <= 0) { st.textContent = "Link vencido"; return stop(); }
      const opened = state.openedAt ? "Abierto por el cliente" : "Aún no lo abre";
      st.textContent = `${opened} · vence en ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    };
    const stop = () => { clearInterval(pinPoll); pinPoll = null; clearInterval(pinTick); pinTick = null; };
    draw();
    pinTick = setInterval(draw, 1000);
    pinPoll = setInterval(async () => {
      try {
        state = await api(`/pin-link/${encodeURIComponent(link.token)}`);
        draw();
        if (state.state === "used") load();
      } catch { /* red momentánea */ }
    }, 5000);
  }

  document.getElementById("pin-link-close").addEventListener("click", closePinLink);
  document.getElementById("pin-link-back").addEventListener("click", (e) => {
    if (e.target.id === "pin-link-back") closePinLink();
  });

  function initRowActions(list) {
    list.addEventListener("click", (e) => {
      const row = e.target.closest(".web-customer-row");
      if (!row) return;
      const id = Number(row.dataset.id);
      if (e.target.closest(".web-customer-suspend-btn")) suspend(id, row);
      if (e.target.closest(".web-customer-reset-btn")) resetPassword(id);
      if (e.target.closest(".web-customer-email-btn")) setEmail(id, row.dataset.email);
      if (e.target.closest(".web-customer-ban-btn")) ban(id);
      if (e.target.closest(".web-customer-unlock-btn")) unlock(id);
      if (e.target.closest(".web-customer-resetpin-btn")) resetPin(id);
      if (e.target.closest(".web-customer-access-btn")) createAccess(row.dataset.phone);
      if (e.target.closest(".web-customer-pinlink-btn")) openPinLink(id, row.dataset.phone);
      if (e.target.closest(".web-customer-fraud-btn")) markFraud(row.dataset.phone);
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
        document.getElementById("customers-section-blocked").hidden  = section !== "blocked";
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
      renderLockedList();
    } catch (err) {
      list.innerHTML = `<p class="feed-empty">${escapeHtml(err.message)}</p>`;
    }
    loadStats();
    loadBlocked();
    loadSecurity();
  }

  // ─── Bloqueo temporal por intentos fallidos de PIN ───
  let blockedCounts = { locked: 0, phones: 0, ips: 0 };
  function paintBlockedCount() {
    const n = blockedCounts.locked + blockedCounts.phones + blockedCounts.ips;
    const el = document.getElementById("customers-blocked-count");
    if (el) el.textContent = n ? `(${n})` : "";
  }

  function renderLockedList() {
    const list = document.getElementById("locked-list");
    if (!list) return;
    const locked = cachedCustomers.filter(c => c.id !== null && c.lockedUntil);
    blockedCounts.locked = locked.length;
    paintBlockedCount();
    list.innerHTML = locked.length ? "" : `<p class="feed-empty">Nadie bloqueado por intentos.</p>`;
    locked.forEach(c => {
      const row = document.createElement("div");
      row.className = "web-customer-row";
      row.dataset.id = c.id;
      row.innerHTML = `
        <div class="web-customer-main">
          <span class="web-customer-phone">${escapeHtml(localPhone(c.phone))}</span>
          <span class="web-customer-status web-customer-status-locked">🔒 Hasta ${escapeHtml(formatDate(c.lockedUntil))}</span>
        </div>
        <div class="web-customer-actions">
          <button class="btn-secondary btn-sm web-customer-unlock-btn" type="button">🔓 Quitar bloqueo</button>
        </div>`;
      list.appendChild(row);
    });
  }

  // ─── Intentos de ataque e IPs bloqueadas ───
  async function loadSecurity() {
    const list = document.getElementById("security-events");
    const ipsEl = document.getElementById("security-ips");
    if (!list || !ipsEl) return;
    try {
      const { events, ips } = await api("/security/events");
      list.innerHTML = "";
      if (!events.length) list.innerHTML = `<p class="feed-empty">Sin intentos de ataque detectados.</p>`;
      events.forEach(ev => {
        const row = document.createElement("div");
        row.className = "web-customer-row";
        row.innerHTML = `
          <div class="web-customer-main">
            <span class="web-customer-phone">${escapeHtml(localPhone(ev.phone))}</span>
            <span class="web-customer-status web-customer-status-locked">🚨 ${escapeHtml(ev.reason)}</span>
          </div>
          <div class="web-customer-sub">${formatDate(ev.createdAt)}${ev.ip ? " · IP " + escapeHtml(ev.ip) : ""} · ${escapeHtml(ev.action)}</div>
          <div class="blocked-evidence"></div>`;
        row.querySelector(".blocked-evidence").textContent = ev.evidence;
        list.appendChild(row);
      });
      blockedCounts.ips = ips.length;
      paintBlockedCount();
      ipsEl.innerHTML = ips.length ? "" : `<p class="feed-empty">No hay IPs bloqueadas.</p>`;
      ips.forEach(b => {
        const row = document.createElement("div");
        row.className = "web-customer-row";
        row.innerHTML = `
          <div class="web-customer-main"><span class="web-customer-phone">${escapeHtml(b.ip)}</span>
            <span class="web-customer-status web-customer-status-locked">${escapeHtml(b.reason)}</span></div>
          <div class="web-customer-sub">Hasta ${formatDate(b.expiresAt)}</div>
          <div class="web-customer-actions"><button class="btn-secondary btn-sm" data-unblock-ip="${escapeHtml(b.ip)}" type="button">Desbloquear IP</button></div>`;
        ipsEl.appendChild(row);
      });
    } catch (err) {
      list.innerHTML = `<p class="feed-empty">${escapeHtml(err.message)}</p>`;
    }
  }

  document.getElementById("security-ips")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-unblock-ip]");
    if (!btn || !confirm("¿Desbloquear esta IP?")) return;
    try { await api("/security/ips/unblock", { method: "POST", body: JSON.stringify({ ip: btn.dataset.unblockIp }) }); loadSecurity(); }
    catch (err) { alert(err.message); }
  });

  // ─── Números bloqueados (automático por enlaces/código en el chat o baneo) ───
  async function loadBlocked() {
    const list = document.getElementById("blocked-list");
    const empty = document.getElementById("blocked-empty");
    if (!list) return;
    try {
      const { blocked } = await api("/blocked/list");
      blockedCounts.phones = blocked.length;
      paintBlockedCount();
      empty.hidden = blocked.length > 0;
      list.innerHTML = "";
      blocked.forEach(b => {
        const row = document.createElement("div");
        row.className = "web-customer-row";
        row.innerHTML = `
          <div class="web-customer-main">
            <span class="web-customer-phone">${escapeHtml(localPhone(b.phone))}</span>
            <span class="web-customer-status web-customer-status-locked">🚫 ${escapeHtml(b.reason)}</span>
            <span class="web-customer-badge">${b.source === "auto" ? "Automático" : "Baneado por ti"}</span>
          </div>
          <div class="web-customer-sub">${formatDate(b.createdAt)}${b.ip ? " · IP " + escapeHtml(b.ip) : ""}</div>
          ${b.evidence ? `<div class="blocked-evidence"></div>` : ""}
          <div class="web-customer-actions">
            <button class="btn-secondary btn-sm" data-unblock="${escapeHtml(b.phone)}" type="button">Desbloquear</button>
          </div>`;
        // La evidencia es lo que escribió el atacante: siempre como texto.
        const ev = row.querySelector(".blocked-evidence");
        if (ev) ev.textContent = b.evidence;
        list.appendChild(row);
      });
    } catch (err) {
      list.innerHTML = `<p class="feed-empty">${escapeHtml(err.message)}</p>`;
    }
  }

  document.getElementById("blocked-list")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-unblock]");
    if (!btn) return;
    if (!confirm("¿Desbloquear este número? Podrá volver a entrar.")) return;
    try {
      await api(`/blocked/${encodeURIComponent(btn.dataset.unblock)}/unblock`, { method: "POST" });
      loadBlocked();
    } catch (err) { alert(err.message); }
  });

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
  initRowActions(document.getElementById("locked-list"));
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
