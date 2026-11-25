// Configuración › 🥭 Manguito Pro — conexión con la API, quién puede usarlo,
// topes de gasto y cuánto se lleva gastado. Ver routes/manguito-admin.routes.ts.
// La clave nunca vuelve al navegador: solo se ven sus últimos 4 caracteres.
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const usd = n => "US$ " + (Number(n) || 0).toFixed(Number(n) < 1 ? 4 : 2);
  const TIER_NAMES = { rapido: "⚡ Rápido (Haiku)", equilibrado: "🧠 Equilibrado (Sonnet)", experto: "🏆 Experto (Opus)", router: "🧭 Selector de modelo", test: "🔌 Pruebas de conexión" };

  function msg(text) { $("mgp-msg").textContent = text || ""; }

  function render(v) {
    $("mgp-status").textContent = v.configured
      ? `✅ Conectada con ${v.mode === "authToken" ? "token" : "clave"} ••••${v.secretTail}${v.baseUrl ? " · " + v.baseUrl : ""}`
      : "Sin conectar: pega la clave de tu API y guarda.";
    $("mgp-base").value = v.baseUrl || "";
    $("mgp-phones").value = (v.phones || []).join("\n");
    $("mgp-daily").value = v.dailyCap;
    $("mgp-monthly").value = v.monthlyCap;
    $("mgp-key").value = "";
    $("mgp-token").value = "";
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

  function init() {
    const form = $("mgp-form");
    if (!form) return;
    form.addEventListener("submit", async e => {
      e.preventDefault();
      msg("Guardando…");
      const body = {
        baseUrl: $("mgp-base").value,
        phones: $("mgp-phones").value,
        dailyCap: $("mgp-daily").value,
        monthlyCap: $("mgp-monthly").value,
      };
      if ($("mgp-key").value.trim()) body.apiKey = $("mgp-key").value.trim();
      else if ($("mgp-token").value.trim()) body.authToken = $("mgp-token").value.trim();
      try { render(await call("POST", "", body)); msg("✅ Guardado."); }
      catch (err) { msg("⚠️ " + err.message); }
    });
    $("mgp-test").addEventListener("click", async () => {
      msg("Probando…");
      try {
        const r = await call("POST", "/test");
        msg(r.ok ? `✅ Funciona: respondió ${r.model} en ${(r.ms / 1000).toFixed(1)} s.` : "⚠️ " + r.message);
        load();
      } catch (err) { msg("⚠️ " + err.message); }
    });
    $("mgp-clear").addEventListener("click", async () => {
      if (!confirm("¿Quitar la clave? Manguito Pro dejará de responder hasta que pongas otra.")) return;
      try { render(await call("POST", "", { clearCredentials: true })); msg("Clave quitada."); }
      catch (err) { msg("⚠️ " + err.message); }
    });
  }

  window.LiordarkManguito = { load };
  document.addEventListener("DOMContentLoaded", init);
})();
