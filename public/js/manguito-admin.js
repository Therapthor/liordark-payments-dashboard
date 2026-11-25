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
        ${chip}
      </div>
      <div class="mgp-key-btns">
        <button type="button" class="btn-secondary btn-sm" data-act="up" ${i === 0 ? "disabled" : ""} title="Usar antes">↑</button>
        <button type="button" class="btn-secondary btn-sm" data-act="down" ${i === n - 1 ? "disabled" : ""} title="Usar después">↓</button>
        <button type="button" class="btn-secondary btn-sm" data-act="test">Probar</button>
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
          phones: $("mgp-phones").value, phoneCaps: $("mgp-phone-caps").value, burstMessages: $("mgp-burst").value, pausesPerDay: $("mgp-pauses").value, dailyCap: $("mgp-daily").value,
          clientMonthlyCap: $("mgp-client-monthly").value, monthlyCap: $("mgp-monthly").value,
        }));
        msg("✅ Guardado.", "mgp-msg2");
      } catch (err) { msg("⚠️ " + err.message, "mgp-msg2"); }
    });
  }

  window.LiordarkManguito = { load };
  document.addEventListener("DOMContentLoaded", init);
})();
