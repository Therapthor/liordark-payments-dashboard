// Configuración › 🥭 Manguito Pro — claves de la API (varias, en orden, con
// cambio automático si una se queda sin saldo), quién puede usarlo, topes y
// gasto. Ver routes/manguito-admin.routes.ts. Las claves nunca vuelven al
// navegador: solo se ven sus últimos 4 caracteres.
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const usd = n => "US$ " + (Number(n) || 0).toFixed(Number(n) < 1 ? 4 : 2);
  const ago = ms => {
    if (!ms) return "";
    const m = Math.round((Date.now() - ms) / 60000);
    return m < 1 ? "recién" : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`;
  };
  const TIER_NAMES = { rapido: "⚡ Rápido (Haiku)", equilibrado: "🧠 Equilibrado (Sonnet)", experto: "🏆 Experto (Opus)", router: "🧭 Selector de modelo", compact: "📦 Compactar conversaciones", memory: "🧠 Memoria de clientes", test: "🔌 Pruebas de conexión" };

  const msg = (text, id) => { $(id || "mgp-msg").textContent = text || ""; };

  function keyRow(k, i, n) {
    const chip = k.state === "ok" ? `<span class="mgp-chip ok">✅ Activa</span>`
      : k.state === "paused" ? `<span class="mgp-chip warn">⏸️ En pausa: ${esc(k.reason)}${k.failedAt ? " · " + ago(k.failedAt) : ""}</span>`
      : `<span class="mgp-chip off">Desactivada</span>`;
    return `<li data-id="${esc(k.id)}">
      <div class="mgp-key-main">
        <b>${i + 1}. ${esc(k.label)}</b>
        <small>${k.kind === "authToken" ? "Token" : "Clave"} ••••${esc(k.tail)}${k.baseUrl ? " · " + esc(k.baseUrl) : ""} · este mes ${usd(k.monthUsd)}${k.lastOkAt ? " · respondió " + ago(k.lastOkAt) : ""}</small>
        <small class="${k.budgetLeft !== null && k.budgetLeft < 10 ? "mgp-low" : ""}">${k.budgetLeft !== null ? `💰 Queda ≈ ${usd(k.budgetLeft)} de ${usd(k.budgetUsd)} anotados` : "💰 Saldo de la cuenta: sin anotar (anótalo para que te avise cuando se acabe)"}</small>
        ${chip}
      </div>
      <div class="mgp-key-btns">
        <button type="button" class="btn-secondary btn-sm" data-act="up" ${i === 0 ? "disabled" : ""} title="Usar antes">↑</button>
        <button type="button" class="btn-secondary btn-sm" data-act="down" ${i === n - 1 ? "disabled" : ""} title="Usar después">↓</button>
        <button type="button" class="btn-secondary btn-sm" data-act="test">Probar</button>
        <button type="button" class="btn-secondary btn-sm" data-act="budget" title="El saldo que tiene ahora la cuenta de la API (lo ves en su página de facturación)">Anotar saldo</button>
        ${k.state === "paused" ? `<button type="button" class="btn-secondary btn-sm" data-act="reset">Quitar pausa</button>` : ""}
        <button type="button" class="btn-secondary btn-sm" data-act="toggle">${k.enabled ? "Desactivar" : "Activar"}</button>
        <button type="button" class="btn-secondary btn-sm" data-act="delete">Borrar</button>
      </div>
    </li>`;
  }

  function render(v) {
    const keys = v.credentials || [];
    const active = keys.filter(k => k.state === "ok").length;
    $("mgp-status").textContent = !keys.length ? "Sin claves: agrega la primera abajo."
      : `${keys.length} clave${keys.length > 1 ? "s" : ""} · ${active} lista${active === 1 ? "" : "s"} para usar`;
    $("mgp-keys").innerHTML = keys.map((k, i) => keyRow(k, i, keys.length)).join("");
    $("mgp-phones").value = (v.phones || []).join("\n");
    $("mgp-phone-caps").value = v.phoneCaps || "";
    $("mgp-free-paused").checked = !!v.freePaused;
    $("mgp-burst").value = v.burstMessages;
    $("mgp-pauses").value = v.pausesPerDay;
    $("mgp-daily").value = v.dailyCap;
    $("mgp-client-monthly").value = v.clientMonthlyCap;
    $("mgp-monthly").value = v.monthlyCap;
    const u = v.usage || { today: {}, month: {}, byTier: [] };
    $("mgp-usage").innerHTML =
      `<div class="mgp-stats"><div><b>${usd(u.today.usd)}</b><span>Hoy · ${u.today.messages || 0} mensajes</span></div>` +
      `<div><b>${usd(u.month.usd)}</b><span>Este mes · ${u.month.messages || 0} mensajes</span></div>` +
      `<div><b>${usd(v.monthlyCap)}</b><span>Tope del mes</span></div></div>` +
      (u.byTier.length
        ? `<table class="mgp-table"><thead><tr><th>Modelo</th><th>Usos</th><th>Gasto</th></tr></thead><tbody>` +
          u.byTier.map(r => `<tr><td>${esc(TIER_NAMES[r.tier] || r.tier)}</td><td>${r.calls}</td><td>${usd(r.usd)}</td></tr>`).join("") +
          `</tbody></table>`
        : `<p class="text-muted">Todavía no hay uso este mes.</p>`);
    renderStore(v);
  }

  // ── Venta (plan mensual y créditos) ──
  const PACK_ROWS = 4;
  function renderStore(v) {
    const st = v.store;
    if (!st || !$("mgs-form")) return;
    $("mgs-enabled").checked = !!st.enabled;
    $("mgs-m-enabled").checked = !!st.monthly.enabled;
    $("mgs-m-price").value = st.monthly.priceSoles;
    $("mgs-m-usd").value = st.monthly.usd;
    $("mgs-m-week").value = st.monthly.weekPct;
    $("mgs-m-window").value = st.monthly.windowPct;
    $("mgs-rate").value = st.rate;
    let rows = "";
    for (let i = 0; i < PACK_ROWS; i++) {
      const p = st.packs[i] || { priceSoles: "", usd: "" };
      rows += `<div class="mgp-pack-row"><input type="number" min="0" step="0.1" placeholder="Precio S/" data-pack="${i}" data-f="priceSoles" value="${esc(p.priceSoles)}" />` +
        `<input type="number" min="0" step="0.5" placeholder="Saldo US$" data-pack="${i}" data-f="usd" value="${esc(p.usd)}" /><small class="mgp-calc" id="mgs-pc-${i}"></small></div>`;
    }
    $("mgs-packs").innerHTML = rows;
    calcStore();
    const o = v.outstanding || { credits: 0, plans: 0, activePlans: 0 };
    const rate = Number(st.rate) || 3.75;
    const mo = v.month || { soles: 0, sales: 0, costUsd: 0 };
    const bal = v.apiBalance || { known: false, remaining: 0 };
    const owed = o.credits + o.plans;
    const soles = n => "S/ " + (Number(n) || 0).toFixed(2);
    const subs = v.subscribers || [];
    const subsHtml = subs.length
      ? `<table class="mgp-table"><thead><tr><th>Cliente</th><th>Tiene</th><th>Pagó</th><th>Gastó (costo)</th><th>Ganancia</th><th>Este mes</th><th>Último uso</th></tr></thead><tbody>` +
        subs.map(r => {
          const has = [r.planActive ? "Plan hasta " + new Date(r.planEnd).toLocaleDateString("es-PE", { day: "numeric", month: "short" }) : "", r.credits > 0 ? "Créditos " + usd(r.credits) : ""].filter(Boolean).join(" + ") || "Sin saldo";
          const cost = r.spentUsd * rate;
          const gain = r.paidSoles - cost;
          return `<tr><td>${esc(r.phone)}${r.wholesaler ? " 🏪" : ""}</td><td>${esc(has)}</td><td>${soles(r.paidSoles)}${r.giftsUsd ? ` <small>+ 🎁 ${usd(r.giftsUsd)}</small>` : ""}</td>` +
            `<td>${usd(r.spentUsd)} <small>(${soles(cost)})</small></td><td class="${gain >= 0 ? "mgp-good" : "mgp-bad"}">${soles(gain)}</td><td>${usd(r.monthUsd)}</td>` +
            `<td>${r.lastAt ? esc(String(r.lastAt).slice(0, 16)) : "—"}</td></tr>`;
        }).join("") + `</tbody></table>`
      : `<p class="text-muted">Todavía no hay suscriptores.</p>`;
    const sales = v.purchases || [];
    $("mgs-stats").innerHTML =
      `<p class="mgp-label">Control del mes</p>` +
      `<div class="mgp-stats"><div><b>${soles(mo.soles)}</b><span>Vendido este mes · ${mo.sales} venta(s)</span></div>` +
      `<div><b>${usd(mo.costUsd)}</b><span>Gastaron este mes (≈ ${soles(mo.costUsd * rate)})</span></div>` +
      `<div><b class="${mo.soles - mo.costUsd * rate >= 0 ? "mgp-good" : "mgp-bad"}">${soles(mo.soles - mo.costUsd * rate)}</b><span>Ganancia del mes</span></div></div>` +
      `<div class="mgp-stats"><div><b>${usd(owed)}</b><span>Saldo vendido aún sin usar (créditos ${usd(o.credits)} + planes ${usd(o.plans)})</span></div>` +
      `<div><b class="${bal.known && (bal.remaining < 10 || bal.remaining < owed) ? "mgp-bad" : ""}">${bal.known ? usd(bal.remaining) : "—"}</b><span>${bal.known ? "Queda en la API (según lo anotado)" : "Saldo de la API: anótalo en cada clave"}</span></div>` +
      `<div><b>${o.activePlans}</b><span>Planes mensuales activos</span></div></div>` +
      `<p class="text-muted">Si lo que queda en la API no alcanza para lo vendido, te dejo una incidencia en Soportes para que recargues.</p>` +
      `<p class="mgp-label">Suscriptores</p>` + subsHtml +
      `<p class="mgp-label">Últimas ventas</p>` +
      (sales.length
        ? `<table class="mgp-table"><thead><tr><th>Fecha</th><th>Cliente</th><th>Qué</th><th>Pagó</th><th>Saldo</th></tr></thead><tbody>` +
          sales.map(p => `<tr><td>${esc(String(p.paidAt || p.createdAt).slice(0, 16))}</td><td>${esc(p.phone)}</td><td>${p.kind === "plan" ? "Plan mensual" : p.kind === "gift" ? "🎁 Regalo" : "Créditos"}</td><td>${p.kind === "gift" ? "—" : "S/ " + esc(p.amountSoles)}</td><td>${usd(p.usd)}</td></tr>`).join("") +
          `</tbody></table>`
        : `<p class="text-muted">Todavía no hay ventas.</p>`);
  }

  // Ganancia o pérdida si el cliente usa TODO su saldo.
  function margin(priceSoles, usdAmount) {
    const rate = Number($("mgs-rate").value) || 3.75;
    const cost = usdAmount * rate;
    return { cost, diff: priceSoles - cost };
  }
  function calcLine(el, price, amount, extra) {
    if (!el) return;
    if (!(price > 0 && amount > 0)) { el.textContent = ""; el.className = "mgp-calc"; return; }
    const m = margin(price, amount);
    el.textContent = `Si lo usa todo te cuesta ≈ S/ ${m.cost.toFixed(2)} → ${m.diff >= 0 ? "ganas" : "pierdes"} S/ ${Math.abs(m.diff).toFixed(2)}${extra || ""}`;
    el.className = "mgp-calc " + (m.diff >= 0 ? "good" : "bad");
  }
  function calcStore() {
    const usdM = Number($("mgs-m-usd").value) || 0;
    const week = usdM * (Number($("mgs-m-week").value) || 0) / 100;
    const win = usdM * (Number($("mgs-m-window").value) || 0) / 100;
    calcLine($("mgs-m-calc"), Number($("mgs-m-price").value), usdM, ` · por semana hasta ${usd(week)} · cada 3 h hasta ${usd(win)}`);
    for (let i = 0; i < PACK_ROWS; i++) {
      const pr = document.querySelector(`[data-pack="${i}"][data-f="priceSoles"]`), us = document.querySelector(`[data-pack="${i}"][data-f="usd"]`);
      if (pr && us) calcLine($("mgs-pc-" + i), Number(pr.value), Number(us.value));
    }
  }

  async function call(method, path, body) {
    const res = await fetch("/api/manguito-admin" + path, {
      method, credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "No se pudo guardar.");
    return data;
  }

  async function load() {
    try { render(await call("GET", "")); } catch (err) { $("mgp-status").textContent = "⚠️ " + err.message; }
  }

  function showTest(r) {
    if (r.view) render(r.view);
    msg(r.ok ? `✅ Funciona: «${r.label}» respondió con ${r.model} en ${(r.ms / 1000).toFixed(1)} s.` : "⚠️ " + r.message);
  }

  function init() {
    if (!$("mgp-add")) return;
    if ($("mgs-form")) {
      $("mgs-form").addEventListener("input", calcStore);
      $("mgs-form").addEventListener("submit", async e => {
        e.preventDefault();
        msg("Guardando…", "mgs-msg");
        const packs = [];
        for (let i = 0; i < PACK_ROWS; i++) {
          const pr = document.querySelector(`[data-pack="${i}"][data-f="priceSoles"]`).value, us = document.querySelector(`[data-pack="${i}"][data-f="usd"]`).value;
          if (pr || us) packs.push({ priceSoles: pr, usd: us });
        }
        try {
          render(await call("POST", "/store", {
            enabled: $("mgs-enabled").checked, rate: $("mgs-rate").value, packs,
            monthly: { enabled: $("mgs-m-enabled").checked, priceSoles: $("mgs-m-price").value, usd: $("mgs-m-usd").value, weekPct: $("mgs-m-week").value, windowPct: $("mgs-m-window").value },
          }));
          msg("✅ Guardado.", "mgs-msg");
        } catch (err) { msg("⚠️ " + err.message, "mgs-msg"); }
      });
      $("mgs-gift").addEventListener("submit", async e => {
        e.preventDefault();
        msg("Regalando…", "mgs-msg2");
        try {
          render(await call("POST", "/gift", { phone: $("mgs-g-phone").value, kind: $("mgs-g-kind").value, usd: $("mgs-g-usd").value }));
          $("mgs-g-phone").value = ""; $("mgs-g-usd").value = "";
          msg("✅ Listo, ya lo tiene en su Manguito Pro.", "mgs-msg2");
        } catch (err) { msg("⚠️ " + err.message, "mgs-msg2"); }
      });
    }
    $("mgp-add").addEventListener("submit", async e => {
      e.preventDefault();
      const body = { label: $("mgp-label").value, baseUrl: $("mgp-base").value };
      if ($("mgp-key").value.trim()) body.apiKey = $("mgp-key").value.trim();
      else if ($("mgp-token").value.trim()) body.authToken = $("mgp-token").value.trim();
      else { msg("⚠️ Pega la clave de la API (o el token)."); return; }
      msg("Guardando…");
      try {
        render(await call("POST", "/keys", body));
        ["mgp-label", "mgp-key", "mgp-token", "mgp-base"].forEach(id => { $(id).value = ""; });
        msg("✅ Clave agregada. Tócale «Probar» para confirmar que tiene saldo.");
      } catch (err) { msg("⚠️ " + err.message); }
    });
    $("mgp-test").addEventListener("click", async () => {
      msg("Probando…");
      try { showTest(await call("POST", "/test")); } catch (err) { msg("⚠️ " + err.message); }
    });
    $("mgp-keys").addEventListener("click", async e => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const id = btn.closest("li").dataset.id;
      const act = btn.dataset.act;
      try {
        if (act === "test") { msg("Probando…"); showTest(await call("POST", `/keys/${id}/test`)); return; }
        if (act === "budget") {
          const v = prompt("¿Cuánto saldo tiene AHORA esta cuenta de la API? (US$, lo ves en su página de facturación). Vacío = no anotar.");
          if (v === null) return;
          render(await call("PATCH", `/keys/${id}`, { budgetUsd: v.trim() }));
          msg(v.trim() ? "✅ Saldo anotado. Te aviso en Soportes cuando quede poco." : "Saldo borrado.");
          return;
        }
        if (act === "delete") {
          if (!confirm("¿Borrar esta clave de la lista?")) return;
          render(await call("DELETE", `/keys/${id}`)); msg("Clave borrada."); return;
        }
        const enabled = btn.textContent.trim() === "Activar";
        const body = act === "up" || act === "down" ? { move: act } : act === "reset" ? { reset: true } : { enabled };
        render(await call("PATCH", `/keys/${id}`, body));
        msg("");
      } catch (err) { msg("⚠️ " + err.message); }
    });
    $("mgp-form").addEventListener("submit", async e => {
      e.preventDefault();
      msg("Guardando…", "mgp-msg2");
      try {
        render(await call("POST", "", {
          phones: $("mgp-phones").value, phoneCaps: $("mgp-phone-caps").value, freePaused: $("mgp-free-paused").checked, burstMessages: $("mgp-burst").value, pausesPerDay: $("mgp-pauses").value, dailyCap: $("mgp-daily").value,
          clientMonthlyCap: $("mgp-client-monthly").value, monthlyCap: $("mgp-monthly").value,
        }));
        msg("✅ Guardado.", "mgp-msg2");
      } catch (err) { msg("⚠️ " + err.message, "mgp-msg2"); }
    });
  }

  window.LiordarkManguito = { load };
  document.addEventListener("DOMContentLoaded", init);
})();
