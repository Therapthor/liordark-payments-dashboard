(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // RENOVADOS (Pagos > Renovaciones) — cuentas con perfiles donde algún
  // cliente (web o mayorista) ya pagó su renovación. La cuenta entera no
  // suma días sola (ver confirmCycleRenewal en access.service.ts):
  //   ✅ Confirmar renovación → +30 días a la cuenta (ya renovada con el proveedor).
  //   📦 Enviar cuenta nueva  → mueve a los que pagaron a otra cuenta, con su fecha nueva.
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
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtDate(ymd) {
    if (!ymd) return "—";
    const [y, m, d] = String(ymd).slice(0, 10).split("-");
    return d && m && y ? `${d}/${m}/${y}` : ymd;
  }

  function daysBadge(daysLeft) {
    if (daysLeft === null || daysLeft === undefined) return "";
    if (daysLeft < 0) return `<span class="feed-status expired">${Math.abs(daysLeft)}d vencida</span>`;
    if (daysLeft <= 1) return `<span class="feed-status pending">${daysLeft === 0 ? "Vence hoy" : "Vence mañana"}</span>`;
    return `<span class="feed-status matched">${daysLeft}d restantes</span>`;
  }

  let cached = [];
  let currentId = null;

  function renderItem(r) {
    const li = document.createElement("li");
    li.className = "catalog-item";
    li.dataset.id = r.id;
    const payers = r.renewing.map(p =>
      (p.wholesalerId != null ? "🏪 " : "👤 ") + escapeHtml(p.clientPhone) + (p.profileName ? ` (${escapeHtml(p.profileName)})` : "")
    ).join(", ");
    li.innerHTML = `
      <div class="catalog-thumb catalog-thumb-empty">♻️</div>
      <div class="catalog-main">
        <div class="catalog-name">${escapeHtml(r.platform)} — ${escapeHtml(r.email)}</div>
        <div class="catalog-desc">
          💰 Pagaron ${r.renewing.length} de ${r.occupiedCount}: ${payers}<br>
          📅 Vence: ${fmtDate(r.expiresAt)} ${daysBadge(r.daysLeft)} → al confirmar: <b>${fmtDate(r.newExpiresAt)}</b>
        </div>
      </div>
      <div class="catalog-actions">
        <button class="btn-primary btn-sm full-renewal-done-btn" type="button" title="Ya renovaste esta cuenta con el proveedor">✅ Confirmar renovación</button>
        <button class="btn-secondary btn-sm full-renewal-new-btn" type="button" title="Mover a los que pagaron a otra cuenta">📦 Enviar cuenta nueva</button>
      </div>
    `;
    return li;
  }

  function render() {
    const list  = document.getElementById("full-renewals-list");
    const empty = document.getElementById("full-renewals-empty");
    const count = document.getElementById("full-renewals-count");
    if (!list) return;
    list.innerHTML = "";
    count.hidden = cached.length === 0;
    count.textContent = String(cached.length);
    if (cached.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;
    for (const r of cached) list.appendChild(renderItem(r));
  }

  async function load() {
    try {
      const { accounts } = await api("/cycle-renewals");
      cached = accounts || [];
      render();
    } catch (err) {
      const list = document.getElementById("full-renewals-list");
      if (list) list.innerHTML = `<p class="panel-hint">${escapeHtml(err.message)}</p>`;
    }
  }

  async function openNewAccountModal(r) {
    currentId = r.id;
    document.getElementById("full-renewal-modal-info").innerHTML =
      `${escapeHtml(r.platform)}: se mueven los <b>${r.renewing.length}</b> cliente(s) que pagaron, con vencimiento <b>${fmtDate(r.newExpiresAt)}</b>. Los que no pagaron se quedan en la cuenta actual hasta que venza.`;
    document.getElementById("full-renewal-email").value = "";
    document.getElementById("full-renewal-password").value = "";
    document.getElementById("full-renewal-error").hidden = true;
    const select = document.getElementById("full-renewal-stock");
    select.innerHTML = `<option value="">Cargando…</option>`;
    document.getElementById("full-renewal-modal").hidden = false;
    try {
      const { accounts } = await api(`/cycle-renewals/${r.id}/candidates`);
      select.innerHTML = `<option value="">— Ninguna (escribir a mano) —</option>` +
        accounts.map(a => `<option value="${a.id}">${escapeHtml(a.email)} · ${a.freeCount} libres · vence ${fmtDate(a.expiresAt)}</option>`).join("");
      if (accounts.length === 0) select.innerHTML = `<option value="">No hay cuentas de ${escapeHtml(r.platform)} con ${r.renewing.length} cupo(s) libre(s)</option>`;
    } catch (err) {
      select.innerHTML = `<option value="">${escapeHtml(err.message)}</option>`;
    }
  }

  function init() {
    const list = document.getElementById("full-renewals-list");
    if (!list) return;

    list.addEventListener("click", async (e) => {
      const li = e.target.closest(".catalog-item");
      if (!li) return;
      const r = cached.find(x => x.id === Number(li.dataset.id));
      if (!r) return;

      if (e.target.closest(".full-renewal-done-btn")) {
        if (!confirm(`¿Ya renovaste "${r.platform} — ${r.email}" con el proveedor?\n\nLa cuenta pasa a vencer el ${fmtDate(r.newExpiresAt)}, se avisa a los ${r.renewing.length} que pagaron, y a los que no pagaron se les saca en su fecha de vencimiento.`)) return;
        const btn = e.target.closest("button");
        btn.disabled = true;
        try {
          await api(`/cycle-renewals/${r.id}/confirm`, { method: "POST" });
          await load();
        } catch (err) {
          alert(err.message || "No se pudo confirmar.");
          btn.disabled = false;
        }
        return;
      }

      if (e.target.closest(".full-renewal-new-btn")) openNewAccountModal(r);
    });

    document.getElementById("full-renewal-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("full-renewal-error");
      errEl.hidden = true;
      const targetAccountId = Number(document.getElementById("full-renewal-stock").value) || 0;
      const newEmail    = document.getElementById("full-renewal-email").value.trim();
      const newPassword = document.getElementById("full-renewal-password").value.trim();
      if (!targetAccountId && !newEmail) {
        errEl.textContent = "Elige una cuenta del stock o escribe el correo de la cuenta nueva.";
        errEl.hidden = false;
        return;
      }
      const btn = e.target.querySelector("button[type='submit']");
      btn.disabled = true;
      try {
        const body = targetAccountId ? { targetAccountId } : { newEmail, newPassword };
        await api(`/cycle-renewals/${currentId}/send-new`, { method: "POST", body: JSON.stringify(body) });
        document.getElementById("full-renewal-modal").hidden = true;
        await load();
      } catch (err) {
        errEl.textContent = err.message || "No se pudo enviar la cuenta nueva.";
        errEl.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
  window.LiordarkFullRenewals = { load };
})();
