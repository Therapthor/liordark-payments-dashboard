// ─────────────────────────────────────────────────────────────
// 🧠 CEREBRO DE CUENTAS (Pagos › Renovaciones) — qué cuentas renovar con
// el proveedor, stock que falta, clientes movidos anoche y PIN por cambiar.
// Ver src/services/brain.service.ts.
// ─────────────────────────────────────────────────────────────
(function () {
  const box = () => document.getElementById("brain-box");

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

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function ddmm(ymd) {
    if (!ymd) return "—";
    const [y, m, d] = String(ymd).split("-");
    return `${d}/${m}/${y}`;
  }
  function phone9(p) { return String(p || "").replace(/\D/g, "").slice(-9); }

  function render(o) {
    const el = box();
    if (!el) return;
    const last = o.lastRun;
    const renewRows = o.renew.map(r => `
      <li class="brain-row${r.overdue ? " is-overdue" : ""}">
        <div class="brain-row-main">
          <b>${esc(r.platform)}</b> · ${esc(r.email)}
          <div class="brain-row-sub">${r.overdue ? "⚠️ Venció el " + ddmm(r.providerDate) + " — renuévala ya" : "Vence " + ddmm(r.providerDate) + (r.daysLeft === 0 ? " (hoy)" : r.daysLeft === 1 ? " (mañana)" : "")} · ${esc(r.reason)} · ${r.stayers}/${r.capacity} ocupados</div>
        </div>
        <span class="brain-cost">${r.cost ? esc(r.cost) + " USDT" : ""}</span>
        <button type="button" class="btn-primary btn-sm brain-renewed" data-id="${r.accountId}">✅ Ya la renové</button>
      </li>`).join("");

    const stock = (last && last.stock) || [];
    const stockRows = stock.map(s => `<li class="brain-row${s.urgent ? " is-overdue" : ""}"><div class="brain-row-main"><b>${esc(s.platform)}</b><div class="brain-row-sub">${esc(s.note)} · libres mañana: ${s.freeTomorrow} · margen para ventas: ${s.reserve}</div></div></li>`).join("");

    const moves = (last && last.moves) || [];
    const movesRows = moves.slice(0, 40).map(m => `<li class="brain-move">${esc(m.platform)} · ${m.wholesalerId != null ? "🏪 " : ""}${esc(phone9(m.clientPhone))} · ${esc(m.fromEmail)} → <b>${esc(m.toEmail)}</b>${m.profileName ? " (" + esc(m.profileName) + ")" : ""} · vence ${ddmm(m.date)}</li>`).join("");
    const expired = ((last && last.expired) || []).reduce((s, e) => s + e.count, 0);
    const pending = (last && last.pending) || [];

    const pinRows = o.pinTasks.map(t => `
      <li class="brain-row"><div class="brain-row-main"><b>${esc(t.platform)}</b> · ${esc(t.email)} · ${esc(t.profileName || "Perfil " + t.slot)}
        <div class="brain-row-sub">Cierra sus dispositivos, borra el historial y pon un PIN nuevo para volver a venderlo.</div></div>
        <button type="button" class="btn-secondary btn-sm brain-pin" data-id="${t.profileId}" data-name="${esc(t.profileName)}">🔐 Poner PIN</button></li>`).join("");

    el.innerHTML = `
      <div class="brain-section">
        <h3>Renovar con el proveedor ${o.renew.length ? `<span class="badge">${o.renew.length}</span>` : ""}</h3>
        ${o.renew.length
          ? `<p class="brain-note">Total: <b>${o.totalCostUSDT} USDT</b>. Son las cuentas que el cerebro necesita: ahí siguen clientes que ya pagaron. Las demás déjalas vencer (ya movió a su gente).</p><ul class="brain-list">${renewRows}</ul>`
          : `<p class="brain-note">Nada que renovar por ahora. ✨</p>`}
      </div>
      ${o.upcoming && o.upcoming.length ? `<div class="brain-section">
        <h3>Próximos 7 días <span class="badge">${o.upcoming.length}</span></h3>
        <p class="brain-note">Cuentas con clientes que siguen después de su fecha con el proveedor. El cerebro decide la víspera si se renuevan o se mueven (≈ ${o.upcoming.reduce((s, u) => s + (Number(u.cost) || 0), 0)} USDT si se renuevan todas).</p>
        <ul class="brain-list">${o.upcoming.map(u => `<li class="brain-row"><div class="brain-row-main"><b>${esc(u.platform)}</b> · ${esc(u.email)}<div class="brain-row-sub">Proveedor hasta ${ddmm(u.providerDate)} · ${u.stayers} cliente(s) siguen</div></div><span class="brain-cost">${u.cost ? esc(u.cost) + " USDT" : ""}</span></li>`).join("")}</ul>
      </div>` : ""}
      <div class="brain-section">
        <h3>Stock ${stock.length ? `<span class="badge">${stock.length}</span>` : ""}</h3>
        ${stock.length ? `<ul class="brain-list">${stockRows}</ul>` : `<p class="brain-note">Hay stock suficiente para las ventas de los próximos días.</p>`}
      </div>
      ${o.pinTasks.length ? `<div class="brain-section"><h3>PIN por cambiar <span class="badge">${o.pinTasks.length}</span></h3><ul class="brain-list">${pinRows}</ul></div>` : ""}
      <div class="brain-section">
        <h3>Última corrida</h3>
        ${last ? `<p class="brain-note">${new Date(last.ranAt).toLocaleString("es-PE", { timeZone: "America/Lima" })} (${last.origin === "manual" ? "a mano" : "10 pm"}) · ${moves.length} cliente(s) movidos · ${expired} vencido(s) liberados · ${(last.drop || []).length} cuenta(s) para dejar vencer${last.forcedRenew ? ` · ${last.forcedRenew} renovación(es) forzadas (no había dónde moverlos)` : ""}${pending.length ? ` · ${pending.length} en «Pendientes de cuenta nueva»` : ""}${o.passwordTasks.length ? ` · ${o.passwordTasks.length} cuenta(s) para cambiar contraseña` : ""}</p>
          ${moves.length ? `<details class="brain-moves"><summary>Ver movidos</summary><ul>${movesRows}</ul></details>` : ""}`
        : `<p class="brain-note">Todavía no corrió. Corre solo a las 10 pm, o tócalo ahora.</p>`}
      </div>`;

    el.querySelectorAll(".brain-renewed").forEach(btn => btn.addEventListener("click", async () => {
      if (!confirm("¿Ya le pagaste al proveedor? La cuenta suma 30 días.")) return;
      btn.disabled = true;
      try { await api("/accounts/" + btn.dataset.id + "/provider-renewed", { method: "POST" }); await load(); }
      catch (err) { btn.disabled = false; alert(err.message); }
    }));
    el.querySelectorAll(".brain-pin").forEach(btn => btn.addEventListener("click", async () => {
      const pin = prompt(`PIN nuevo para ${btn.dataset.name || "el perfil"} (4 a 6 números):`, "");
      if (pin === null) return;
      try { await api("/profiles/" + btn.dataset.id + "/pin", { method: "POST", body: JSON.stringify({ pin: pin.trim() }) }); await load(); }
      catch (err) { alert(err.message); }
    }));
  }

  async function load() {
    if (!box()) return;
    try { render(await api("/brain")); }
    catch (err) { box().innerHTML = `<p class="login-error">${esc(err.message)}</p>`; }
  }

  function init() {
    const btn = document.getElementById("brain-run-btn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      if (!confirm("Correr el cerebro ahora: libera vencidos, decide qué renovar y mueve clientes si hace falta (les llega aviso). ¿Seguir?")) return;
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = "Pensando…";
      try {
        const r = await api("/brain/run", { method: "POST" });
        render(r.overview);
        if (window.MP && MP.toast) MP.toast(`🧠 ${r.plan.renew.length} por renovar · ${r.plan.moves.length} movidos`);
      } catch (err) { alert(err.message); }
      finally { btn.disabled = false; btn.textContent = old; }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
  window.LiordarkBrain = { load };
})();
