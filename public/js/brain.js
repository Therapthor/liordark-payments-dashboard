// ─────────────────────────────────────────────────────────────
// 🧠 CEREBRO DE CUENTAS (Pagos › Renovaciones) — pagos al proveedor (con
// días que faltan y planes de los clientes), stock por comprar, tareas
// (PIN / contraseña) y la última corrida. Ver src/services/brain.service.ts.
// ─────────────────────────────────────────────────────────────
(function () {
  const $ = (id) => document.getElementById(id);
  let pinCount = 0;

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
    const [, m, d] = String(ymd).split("-");
    return `${d}/${m}`;
  }
  function phone9(p) { return String(p || "").replace(/\D/g, "").slice(-9); }
  function usdt(n) { const v = Math.round((Number(n) || 0) * 100) / 100; return v ? v + " USDT" : ""; }
  function planName(m) { return m >= 12 ? "Anual" : m === 1 ? "1 mes" : m + " meses"; }
  function planTier(m) { return m >= 12 ? 12 : m >= 6 ? 6 : m >= 3 ? 3 : 1; }

  // «3 × Anual · 2 × 3 meses» — de qué plan son los clientes que siguen.
  function planChips(plans) {
    if (!plans || !plans.length) return "";
    return plans.map(p => `<span class="brain-plan is-m${planTier(p.months)}">${p.count} × ${planName(p.months)}</span>`).join("");
  }

  // Cuadro de la izquierda: cuánto falta para pagarle al proveedor.
  function whenBox(daysLeft, date) {
    if (daysLeft == null) return `<div class="brain-when"><b>—</b></div>`;
    if (daysLeft < 0) return `<div class="brain-when is-late"><small>Venció</small><b>${-daysLeft} d</b><small>${ddmm(date)}</small></div>`;
    if (daysLeft === 0) return `<div class="brain-when is-now"><small>Vence</small><b>Hoy</b><small>${ddmm(date)}</small></div>`;
    if (daysLeft === 1) return `<div class="brain-when is-now"><small>Vence</small><b>Mañana</b><small>${ddmm(date)}</small></div>`;
    return `<div class="brain-when${daysLeft <= 3 ? " is-soon" : ""}"><small>Faltan</small><b>${daysLeft} días</b><small>${ddmm(date)}</small></div>`;
  }

  function payRow(r, decided, today) {
    const status = decided
      ? `<span class="brain-tag is-pay">Pagar</span>${r.stayers > 0 ? `${r.stayers} cliente(s) siguen después del ${ddmm(r.providerDate)}` : "Para tener stock libre para ventas nuevas"}`
      : `<span class="brain-tag">Se decide ${r.decideOn <= today ? "hoy 10 pm" : "el " + ddmm(r.decideOn) + " (10 pm)"}</span>pagarla o mover a sus ${r.stayers} cliente(s)`;
    return `
      <li class="brain-pay${decided ? " is-decided" : ""}">
        ${whenBox(r.daysLeft, r.providerDate)}
        <div class="brain-pay-main">
          <div class="brain-pay-top"><b>${esc(r.platform)}</b><span class="brain-pay-email">${esc(r.email)}</span></div>
          <div class="brain-pay-plans">${planChips(r.plans)}<span class="brain-pay-occ">${r.stayers} de ${r.capacity} perfiles</span></div>
          <div class="brain-pay-status">${status}</div>
        </div>
        <div class="brain-pay-side">
          <span class="brain-cost">${esc(usdt(r.cost))}</span>
          ${decided ? `<button type="button" class="btn-primary btn-sm brain-renewed" data-id="${r.accountId}">✅ Ya la renové</button>` : ""}
        </div>
      </li>`;
  }

  function render(o) {
    const el = $("brain-box");
    if (!el) return;
    const today = o.today || new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
    const last = o.lastRun;
    const renew = o.renew || [];
    const upcoming = o.upcoming || [];
    const stock = (last && last.stock) || [];
    const moves = (last && last.moves) || [];
    const drop = ((last && last.drop) || []).filter(d => !d.providerDate || d.providerDate >= today);
    const pending = (last && last.pending) || [];
    const expired = ((last && last.expired) || []).reduce((s, e) => s + e.count, 0);
    const soonCost = upcoming.reduce((s, u) => s + (Number(u.cost) || 0), 0);

    // ── 💳 Pagos al proveedor: primero lo decidido (pagar), luego lo que viene ──
    const payRows = renew.map(r => payRow(r, true, today)).join("") + upcoming.map(u => payRow(u, false, today)).join("");
    const totals = [
      renew.length ? `<span class="brain-total is-pay">Pagar ahora: <b>${esc(usdt(o.totalCostUSDT) || "0 USDT")}</b></span>` : "",
      upcoming.length ? `<span class="brain-total">Próximos 7 días: ≈ <b>${esc(usdt(soonCost) || "0 USDT")}</b></span>` : "",
    ].join("");
    const dropBlock = drop.length ? `
      <details class="brain-more"><summary>🚫 No pagar: ${drop.length} cuenta(s) — ya se movió a sus clientes</summary>
        <ul>${drop.map(d => `<li><b>${esc(d.platform)}</b> · ${esc(d.email)} · vence ${ddmm(d.providerDate)}</li>`).join("")}</ul>
      </details>` : "";

    const payCard = `
      <div class="brain-card">
        <div class="brain-card-head"><h3 class="brain-card-title">💳 Pagos al proveedor</h3><div class="brain-totals">${totals}</div></div>
        ${payRows
          ? `<p class="brain-note">Paga solo las que dicen <b>Pagar</b> y marca «✅ Ya la renové». Las demás se deciden la víspera: si hay espacio en otra cuenta, el cerebro mueve a sus clientes y no pagas.</p>
             <ul class="brain-list">${payRows}</ul>`
          : `<p class="brain-note brain-empty">Nada que pagar en los próximos 7 días. ✨</p>`}
        ${dropBlock}
      </div>`;

    // ── 📦 Stock por comprar ──
    const stockCard = `
      <div class="brain-card">
        <div class="brain-card-head"><h3 class="brain-card-title">📦 Stock por comprar</h3></div>
        ${stock.length
          ? `<ul class="brain-list">${stock.map(s => `
              <li class="brain-row${s.urgent ? " is-overdue" : ""}"><div class="brain-row-main"><b>${esc(s.platform)}</b>
                <div class="brain-row-sub">${esc(s.note)} · libres mañana: ${s.freeTomorrow} · margen para ventas: ${s.reserve}</div></div></li>`).join("")}</ul>`
          : `<p class="brain-note brain-empty">Hay stock suficiente para las ventas de los próximos días.</p>`}
      </div>`;

    // ── 🕘 Última corrida ──
    const facts = last ? [
      [moves.length, "movidos"], [expired, "vencidos liberados"], [pending.length, "en «Pendientes de cuenta nueva»"],
      [last.forcedRenew || 0, "renovaciones forzadas"],
    ].filter(([n]) => n > 0).map(([n, t]) => `<span class="brain-fact"><b>${n}</b> ${t}</span>`).join("") : "";
    const lastCard = `
      <div class="brain-card">
        <div class="brain-card-head"><h3 class="brain-card-title">🕘 Última corrida</h3>
          ${last ? `<span class="brain-when-ran">${esc(new Date(last.ranAt).toLocaleString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }))} · ${last.origin === "manual" ? "a mano" : "10 pm"}</span>` : ""}</div>
        ${last
          ? `<div class="brain-facts">${facts || `<span class="brain-note">Sin cambios: no hubo que mover ni liberar a nadie.</span>`}</div>
             ${moves.length ? `<details class="brain-more"><summary>Ver movidos (${moves.length})</summary><ul>${moves.slice(0, 60).map(m =>
               `<li>${esc(m.platform)} · ${m.wholesalerId != null ? "🏪 " : ""}${esc(phone9(m.clientPhone))} · ${esc(m.fromEmail)} → <b>${esc(m.toEmail)}</b>${m.profileName ? " (" + esc(m.profileName) + ")" : ""} · vence ${ddmm(m.date)}</li>`).join("")}</ul></details>` : ""}`
          : `<p class="brain-note brain-empty">Todavía no corrió. Corre solo a las 10 pm, o toca «Correr ahora».</p>`}
      </div>`;

    el.innerHTML = payCard + stockCard + lastCard;

    // ── ✅ Tareas › 🔐 ¿Cambiar PIN? (la contraseña la pinta access.js) ──
    const pinBox = $("brain-pin-box");
    const pins = o.pinTasks || [];
    pinCount = pins.length;
    if (pinBox) {
      pinBox.innerHTML = pins.length ? `
        <div class="brain-task-group">
          <h3 class="brain-card-title">🔐 ¿Cambiar PIN? <span class="badge">${pins.length}</span></h3>
          <p class="brain-note">Se liberó y ya se puede vender. Si quieres, cierra sus dispositivos y cámbiale el PIN; tú decides.</p>
          <ul class="brain-list">${pins.map(t => `
            <li class="brain-row brain-task"><div class="brain-row-main"><b>${esc(t.platform)}</b> · ${esc(t.profileName || "Perfil " + t.slot)}
              <div class="brain-login">Correo: <b>${esc(t.email)}</b> · Contraseña: <b>${esc(t.password)}</b>
                <button type="button" class="btn-ghost btn-sm brain-copy" data-copy="${esc(t.email + "\n" + t.password)}" title="Copiar correo y contraseña">📋</button></div></div>
              <div class="brain-row-actions">
                <button type="button" class="btn-secondary btn-sm brain-pin" data-id="${t.profileId}" data-name="${esc(t.profileName)}" data-platform="${esc(t.platform)}">🔐 PIN nuevo</button>
                <button type="button" class="btn-secondary btn-sm brain-pin-keep" data-id="${t.profileId}">Dejar igual</button>
              </div></li>`).join("")}</ul>
        </div>` : "";
    }

    // ── Números de arriba ──
    const setKpi = (id, n) => { const k = $(id); if (k) k.textContent = String(n); };
    setKpi("brain-kpi-now", renew.length);
    setKpi("brain-kpi-soon", upcoming.length);
    setKpi("brain-kpi-stock", stock.length);
    updateTasks();

    el.querySelectorAll(".brain-renewed").forEach(btn => btn.addEventListener("click", async () => {
      if (!confirm("¿Ya le pagaste al proveedor? La cuenta suma 30 días.")) return;
      btn.disabled = true;
      try { await api("/accounts/" + btn.dataset.id + "/provider-renewed", { method: "POST" }); await load(); }
      catch (err) { btn.disabled = false; alert(err.message); }
    }));
    if (pinBox) {
      pinBox.querySelectorAll(".brain-copy").forEach(btn => btn.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(btn.dataset.copy); if (window.MP && MP.toast) MP.toast("📋 Copiado"); }
        catch { prompt("Copia:", btn.dataset.copy); }
      }));
      pinBox.querySelectorAll(".brain-pin-keep").forEach(btn => btn.addEventListener("click", async () => {
        btn.disabled = true;
        try { await api("/profiles/" + btn.dataset.id + "/pin", { method: "POST", body: JSON.stringify({ keep: true }) }); await load(); }
        catch (err) { btn.disabled = false; alert(err.message); }
      }));
      pinBox.querySelectorAll(".brain-pin").forEach(btn => btn.addEventListener("click", async () => {
        const five = /amazon|prime/i.test(btn.dataset.platform || "");
        const pin = prompt(`PIN nuevo para ${btn.dataset.name || "el perfil"} (${five ? "5" : "4"} números):`, "");
        if (pin === null) return;
        try { await api("/profiles/" + btn.dataset.id + "/pin", { method: "POST", body: JSON.stringify({ pin: pin.trim() }) }); await load(); }
        catch (err) { alert(err.message); }
      }));
    }
  }

  // Tareas = PIN por cambiar + contraseñas por cambiar (lista de access.js).
  function updateTasks() {
    const pw = document.querySelectorAll("#password-change-list > li").length;
    const total = pinCount + pw;
    const k = $("brain-kpi-tasks");
    if (k) k.textContent = String(total);
    const empty = $("brain-tasks-empty");
    if (empty) empty.hidden = total > 0;
  }
  document.addEventListener("renewals:tasks", updateTasks);

  async function load() {
    if (!$("brain-box")) return;
    try { render(await api("/brain")); }
    catch (err) { $("brain-box").innerHTML = `<p class="login-error">${esc(err.message)}</p>`; }
  }

  function init() {
    const btn = $("brain-run-btn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      if (!confirm("Correr el cerebro ahora: libera vencidos, decide qué pagar al proveedor y mueve clientes si hace falta (les llega aviso). ¿Seguir?")) return;
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = "Pensando…";
      try {
        const r = await api("/brain/run", { method: "POST" });
        render(r.overview);
        if (window.LiordarkAccess) {
          window.LiordarkAccess.loadPasswordChangePending();
          window.LiordarkAccess.loadProviderRenewals();
        }
        if (window.LiordarkFullRenewals) window.LiordarkFullRenewals.load();
        if (window.MP && MP.toast) MP.toast(`🧠 ${r.plan.renew.length} por pagar · ${r.plan.moves.length} movidos`);
      } catch (err) { alert(err.message); }
      finally { btn.disabled = false; btn.textContent = old; }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
  window.LiordarkBrain = { load };
})();
