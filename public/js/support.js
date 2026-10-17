(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // HELPERS (propios — este archivo no depende de app.js)
  // ─────────────────────────────────────────────────────────────

  async function api(path, options = {}) {
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
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function fmtPhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "").slice(-9);
    return digits.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3") || phone;
  }

  // Mismo criterio que access.js — sin el "51" wa.me no abre el chat correcto.
  function waLink(phone, text) {
    let digits = String(phone).replace(/\D/g, "");
    if (digits.length === 9) digits = "51" + digits;
    return "https://api.whatsapp.com/send?phone=" + digits + "&text=" + encodeURIComponent(text);
  }

  async function apiAccess(path, options = {}) {
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

  let providerCatalog = [];
  async function loadProviderCatalog() {
    if (providerCatalog.length) return providerCatalog;
    try {
      const res = await fetch("/api/access/providers-catalog", { credentials: "include" });
      const data = await res.json().catch(() => ({}));
      providerCatalog = data.providers || [];
    } catch { providerCatalog = []; }
    return providerCatalog;
  }
  function providerWhatsapp(name) {
    const found = providerCatalog.find(p => p.name.trim().toUpperCase() === String(name).trim().toUpperCase());
    return found?.whatsapp || "";
  }

  // ─────────────────────────────────────────────────────────────
  // TABLA + RESUMEN
  // ─────────────────────────────────────────────────────────────

  const STATUS_LABEL = { pending: "Pendiente", seen: "En revisión", attended: "Atendido" };
  const STATUS_CLASS = { pending: "support-status-pending", seen: "support-status-seen", attended: "support-status-done" };

  let cachedTickets = [];

  function renderSummary(pendingCount, attendedCount) {
    document.getElementById("support-pending-count").textContent = pendingCount;
    document.getElementById("support-attended-count").textContent = attendedCount;
    const badge = document.getElementById("support-pending-badge");
    if (badge) {
      badge.textContent = pendingCount;
      badge.hidden = pendingCount === 0;
    }
  }

  function renderTable(tickets) {
    const tbody = document.getElementById("support-table-body");
    const empty = document.getElementById("support-empty");
    const table = document.getElementById("support-table");
    if (tickets.length === 0) {
      tbody.innerHTML = "";
      table.hidden = true;
      empty.hidden = false;
      return;
    }
    table.hidden = false;
    empty.hidden = true;
    tbody.innerHTML = tickets.map(t => `
      <tr data-id="${t.id}">
        <td>${escapeHtml(fmtPhone(t.clientPhone))}</td>
        <td>${escapeHtml(t.platformTag)}</td>
        <td>${escapeHtml(t.problem)}</td>
        <td><span class="badge ${STATUS_CLASS[t.status]}">${STATUS_LABEL[t.status]}</span></td>
        <td>${t.status !== "attended" ? `<button class="btn-primary btn-sm support-attend-btn" data-id="${t.id}" type="button">Atender</button>` : ""}</td>
      </tr>
    `).join("");
  }

  async function loadAll() {
    const { tickets, pendingCount, attendedCount } = await api("/tickets");
    cachedTickets = tickets;
    renderTable(tickets);
    renderSummary(pendingCount, attendedCount);
  }

  // Se revisa aunque el admin no esté parado en "Soportes" (para el badge
  // de la pestaña); si SÍ está parado ahí, también refresca la tabla para
  // que un reporte nuevo aparezca solo, sin recargar la página.
  async function pollBadge() {
    try {
      const { tickets, pendingCount, attendedCount } = await api("/tickets");
      renderSummary(pendingCount, attendedCount);
      const view = document.getElementById("view-support");
      if (view && !view.hidden) {
        cachedTickets = tickets;
        renderTable(tickets);
      }
    } catch { /* red momentánea */ }
  }

  // ─────────────────────────────────────────────────────────────
  // MODAL "ATENDER" — nunca marca atendido solo, eso únicamente lo hace
  // el botón "Marcar atendido" (cerrar con la X o click afuera no cuenta).
  // ─────────────────────────────────────────────────────────────

  let attendTarget = null;

  function openAttendModal(ticket) {
    attendTarget = ticket;
    document.getElementById("support-attend-platform").textContent = ticket.platformTag;
    document.getElementById("support-attend-phone").textContent = fmtPhone(ticket.clientPhone);
    document.getElementById("support-attend-problem").textContent = ticket.problem || "(sin detalle)";
    document.getElementById("support-attend-email").textContent = ticket.accountEmail;
    document.getElementById("support-attend-password").textContent = ticket.accountPassword;

    const providerBox = document.getElementById("support-attend-provider-box");
    if (ticket.provider) {
      providerBox.hidden = false;
      document.getElementById("support-attend-provider").textContent = ticket.provider;
    } else {
      providerBox.hidden = true;
    }

    document.getElementById("support-attend-message").value = ticket.resolutionMessage || "";
    document.getElementById("support-attend-modal").hidden = false;

    // Abrir el modal ya cuenta como "lo vieron" — avisa al cliente que
    // su reporte pasó a revisión. Nunca lo marca atendido solo.
    if (ticket.status === "pending") {
      api("/tickets/" + ticket.id + "/seen", { method: "POST" })
        .then(() => {
          ticket.status = "seen";
          renderTable(cachedTickets);
        })
        .catch(() => { /* no crítico */ });
    }
  }

  function closeAttendModal() {
    document.getElementById("support-attend-modal").hidden = true;
    attendTarget = null;
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const original = btn.textContent;
      btn.textContent = "✅ Copiado";
      setTimeout(() => { btn.textContent = original; }, 1500);
    } catch {
      alert("No se pudo copiar. Copia los datos manualmente.");
    }
  }

  function initAttendModal() {
    document.getElementById("support-attend-close").addEventListener("click", closeAttendModal);
    document.getElementById("support-attend-modal").addEventListener("click", (e) => {
      if (e.target.id === "support-attend-modal") closeAttendModal(); // clic afuera de la tarjeta
    });

    // Tocar el celular lo copia — no abre WhatsApp, acá es solo para
    // pegarlo rápido donde haga falta.
    document.getElementById("support-attend-phone").addEventListener("click", (e) => {
      copyText(fmtPhone(attendTarget.clientPhone).replace(/\s/g, ""), e.currentTarget);
    });

    document.getElementById("support-attend-copy").addEventListener("click", (e) => {
      if (!attendTarget) return;
      const text = `${attendTarget.platformTag}\nCorreo: ${attendTarget.accountEmail}\nContraseña: ${attendTarget.accountPassword}`;
      copyText(text, e.currentTarget);
    });

    document.getElementById("support-attend-provider-btn").addEventListener("click", async () => {
      if (!attendTarget) return;
      await loadProviderCatalog();
      const phone = providerWhatsapp(attendTarget.provider);
      if (!phone) {
        alert(`No hay WhatsApp guardado para "${attendTarget.provider}". Agrégalo en Configuración > Proveedores.`);
        return;
      }
      const msg = `Hola! Necesito soporte con una cuenta de *${attendTarget.platformTag}*.\n📧 Correo: ${attendTarget.accountEmail}\n🔑 Contraseña: ${attendTarget.accountPassword}\n\nUn cliente reportó: "${attendTarget.problem}"`;
      window.open(waLink(phone, msg), "_blank");
    });

    document.getElementById("support-attend-replace-btn").addEventListener("click", () => {
      if (attendTarget) openReplaceModal(attendTarget);
    });

    document.getElementById("support-attend-done").addEventListener("click", async () => {
      if (!attendTarget) return;
      const btn = document.getElementById("support-attend-done");
      const resolutionMessage = document.getElementById("support-attend-message").value.trim();
      btn.disabled = true;
      try {
        await api("/tickets/" + attendTarget.id + "/attend", {
          method: "POST",
          body: JSON.stringify({ resolutionMessage }),
        });
        closeAttendModal();
        await loadAll();
      } catch (err) {
        alert(err.message || "No se pudo marcar como atendido.");
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // MODAL "REEMPLAZAR CUENTA" — exclusivo de Soporte. No cierra el reporte
  // solo; el admin usa "Marcar atendido" aparte cuando ya avisó al cliente.
  // ─────────────────────────────────────────────────────────────

  let replaceTarget = null;

  function showReplaceError(msg) {
    const el = document.getElementById("support-replace-error");
    el.textContent = msg;
    el.hidden = !msg;
  }

  function setReplaceTab(tab) {
    document.querySelectorAll(".support-replace-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
    document.getElementById("support-replace-pane-pool").hidden = tab !== "pool";
    document.getElementById("support-replace-pane-manual").hidden = tab !== "manual";
    showReplaceError("");
  }

  async function loadReplaceAccountOptions(platform) {
    const select = document.getElementById("support-replace-account-select");
    select.innerHTML = `<option value="">Cargando cuentas...</option>`;
    try {
      const { accounts } = await apiAccess("/platforms/" + encodeURIComponent(platform) + "/accounts");
      const withFreeSlot = accounts.filter(a => a.profiles.some(p => !p.clientPhone));
      if (withFreeSlot.length === 0) {
        select.innerHTML = `<option value="">Sin cuentas con cupo libre</option>`;
        return;
      }
      select.innerHTML = withFreeSlot.map(a => {
        const free = a.profiles.filter(p => !p.clientPhone).length;
        const expiry = a.expiresAt ? `vence ${a.expiresAt}` : "sin fecha";
        return `<option value="${a.id}">${escapeHtml(a.email)} — ${free} libre(s) — ${expiry}</option>`;
      }).join("");
    } catch {
      select.innerHTML = `<option value="">Error al cargar cuentas</option>`;
    }
  }

  function openReplaceModal(ticket) {
    replaceTarget = ticket;
    showReplaceError("");
    document.getElementById("support-replace-manual-email").value = "";
    document.getElementById("support-replace-manual-password").value = "";
    document.getElementById("support-replace-manual-profile").value = "";
    document.getElementById("support-replace-manual-provider").value = "";
    setReplaceTab("pool");
    document.getElementById("support-replace-modal").hidden = false;
    loadReplaceAccountOptions(ticket.platform);
  }

  function closeReplaceModal() {
    document.getElementById("support-replace-modal").hidden = true;
    replaceTarget = null;
  }

  function initReplaceModal() {
    document.getElementById("support-replace-close").addEventListener("click", closeReplaceModal);
    document.getElementById("support-replace-modal").addEventListener("click", (e) => {
      if (e.target.id === "support-replace-modal") closeReplaceModal();
    });
    document.querySelectorAll(".support-replace-tab").forEach(btn => {
      btn.addEventListener("click", () => setReplaceTab(btn.dataset.tab));
    });

    document.getElementById("support-replace-pool-confirm").addEventListener("click", async (e) => {
      if (!replaceTarget) return;
      const targetAccountId = Number(document.getElementById("support-replace-account-select").value);
      if (!targetAccountId) return showReplaceError("Elige una cuenta.");
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api("/tickets/" + replaceTarget.id + "/replace", {
          method: "POST",
          body: JSON.stringify({ targetAccountId }),
        });
        closeReplaceModal();
        closeAttendModal();
        await loadAll();
      } catch (err) {
        showReplaceError(err.message || "No se pudo reemplazar la cuenta.");
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("support-replace-manual-confirm").addEventListener("click", async (e) => {
      if (!replaceTarget) return;
      const newEmail       = document.getElementById("support-replace-manual-email").value.trim();
      const newPassword    = document.getElementById("support-replace-manual-password").value.trim();
      const newProfileName = document.getElementById("support-replace-manual-profile").value.trim();
      const newProvider    = document.getElementById("support-replace-manual-provider").value.trim();
      if (!newEmail) return showReplaceError("Falta el correo de la cuenta nueva.");
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api("/tickets/" + replaceTarget.id + "/replace-manual", {
          method: "POST",
          body: JSON.stringify({ newEmail, newPassword, newProfileName, newProvider }),
        });
        closeReplaceModal();
        closeAttendModal();
        await loadAll();
      } catch (err) {
        showReplaceError(err.message || "No se pudo crear la cuenta de reemplazo.");
      } finally {
        btn.disabled = false;
      }
    });
  }

  function initTableActions() {
    document.getElementById("support-table-body").addEventListener("click", (e) => {
      const btn = e.target.closest(".support-attend-btn");
      if (!btn) return;
      const ticket = cachedTickets.find(t => t.id === Number(btn.dataset.id));
      if (ticket) openAttendModal(ticket);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────

  const BADGE_POLL_MS = 8_000;
  let initialized = false;

  function init() {
    if (initialized) return;
    initialized = true;
    initTableActions();
    initAttendModal();
    initReplaceModal();
    pollBadge();
    setInterval(pollBadge, BADGE_POLL_MS);
  }

  window.LiordarkSupport = { init, load: loadAll };
})();
