(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // CLIENTES DE LA TIENDA WEB (liordark.com) — lista de cuentas
  // registradas. Las creadas con "Comprar sin cuenta" muestran la
  // contraseña generada (con botón para reenviarla por WhatsApp);
  // las que el cliente registró con su propia contraseña no la
  // muestran (nunca se guarda en texto plano).
  // ─────────────────────────────────────────────────────────────

  async function api(path) {
    const res = await fetch("/api/customers" + path, { credentials: "include" });
    if (res.status === 401) { location.reload(); throw new Error("No autenticado"); }
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

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return iso;
    }
  }

  function renderRow(c) {
    const div = document.createElement("div");
    div.className = "web-customer-row";

    const originBadge = c.isGuest
      ? `<span class="web-customer-badge web-customer-badge-guest">Automática</span>`
      : `<span class="web-customer-badge web-customer-badge-own">Registro propio</span>`;

    const passwordCol = c.isGuest
      ? `<span class="web-customer-password">${escapeHtml(c.password)}</span>`
      : `<span class="web-customer-sub">—</span>`;

    const msg = `Hola! Tu cuenta de Manguitope quedó creada 🥭\n\nCelular: ${c.phone}\nContraseña: ${c.password}\n\nEntrá en https://liordark.com para comprar.`;
    const sendBtn = c.isGuest
      ? `<a class="btn-secondary btn-sm" href="${waLink(c.phone, msg)}" target="_blank" rel="noopener">📲 Enviar por WhatsApp</a>`
      : "";

    div.innerHTML = `
      <div class="web-customer-main">
        <span class="web-customer-phone">${escapeHtml(c.phone)}</span>
        ${originBadge}
        <span class="web-customer-status">✅ Cuenta creada</span>
      </div>
      <div class="web-customer-sub">${formatDate(c.createdAt)}</div>
      <div class="web-customer-actions">
        ${passwordCol}
        ${sendBtn}
      </div>`;
    return div;
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

  window.LiordarkWebCustomers = { load };
})();
