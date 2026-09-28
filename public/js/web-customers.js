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
    div.dataset.id = c.id;

    const originBadge = c.isGuest
      ? `<span class="web-customer-badge web-customer-badge-guest">Automática</span>`
      : `<span class="web-customer-badge web-customer-badge-own">Registro propio</span>`;

    const statusBadge = c.suspended
      ? `<span class="web-customer-status web-customer-status-suspended">⏸ Suspendida hasta ${formatDate(c.suspendedUntil)}</span>`
      : `<span class="web-customer-status">✅ Cuenta creada</span>`;

    const purchaseLabel = c.purchaseCount === 1 ? "1 compra" : `${c.purchaseCount} compras`;

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
      if (e.target.closest(".web-customer-ban-btn")) ban(id);
    });
  }

  async function load() {
    const list  = document.getElementById("web-customers-list");
    const empty = document.getElementById("web-customers-empty");
    try {
      const { customers } = await api("/");
      list.innerHTML = "";
      if (!customers || customers.length === 0) {
        empty.hidden = false;
        return;
      }
      empty.hidden = true;
      customers.forEach(c => list.appendChild(renderRow(c)));
    } catch (err) {
      list.innerHTML = `<p class="feed-empty">${escapeHtml(err.message)}</p>`;
    }
  }

  initRowActions(document.getElementById("web-customers-list"));

  window.LiordarkWebCustomers = { load };
})();
