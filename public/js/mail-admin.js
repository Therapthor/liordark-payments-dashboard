/* ═══════════════════════════════════════════════════════════════
   Configuración › Correos — conectar Outlook/Hotmail (inicio de sesión
   oficial de Microsoft con código) y Gmail (contraseña de aplicación)
   para leer los códigos de inicio de sesión. Probar y desconectar.
   ═══════════════════════════════════════════════════════════════ */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function api(path, options = {}) {
    const res = await fetch("/api/mail" + path, {
      credentials: "include",
      headers: options.body ? { "Content-Type": "application/json" } : {},
      ...options,
    });
    if (res.status === 401) { location.reload(); throw new Error("No autenticado"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "No se pudo conectar. Intenta de nuevo.");
    return data;
  }

  function ago(sqlite) {
    if (!sqlite) return "";
    const d = new Date(String(sqlite).replace(" ", "T") + "Z");
    const min = Math.round((Date.now() - d.getTime()) / 60000);
    if (Number.isNaN(min)) return "";
    if (min < 1) return "hace un momento";
    if (min < 60) return `hace ${min} min`;
    const h = Math.round(min / 60);
    return h < 24 ? `hace ${h} h` : d.toLocaleDateString("es-PE", { day: "numeric", month: "short" });
  }

  let state = null;

  function paintClient() {
    const id = state.microsoftClientId || "";
    $("mlc-ms-id").value = id;
    $("mlc-ms-connect").disabled = !id;
    $("mlc-ms-note").textContent = id
      ? "✓ Listo. Ya puedes conectar tus Outlook."
      : "Primero pega aquí el «ID de la aplicación» (se crea una sola vez en Microsoft; te guío paso a paso).";
  }

  function rowHtml(c) {
    const ok = c.status === "ok";
    return `<div class="mlc-item" data-id="${c.id}">
      <span class="mlc-logo ${c.provider === "gmail" ? "g" : "ms"}" aria-hidden="true">${c.provider === "gmail" ? "G" : "O"}</span>
      <div class="mlc-item-txt">
        <b>${esc(c.email)}</b>
        <small class="${ok ? "" : "bad"}">${ok ? "Conectado" + (c.lastOkAt ? " · usado " + esc(ago(c.lastOkAt)) : "") : "Con error: " + esc(c.lastError)}</small>
        <small class="mlc-test" hidden></small>
      </div>
      <div class="mlc-item-acts">
        <button class="btn-secondary btn-sm" data-act="test" type="button">Probar</button>
        <button class="btn-secondary btn-sm mlc-off" data-act="off" type="button">Desconectar</button>
      </div>
    </div>`;
  }

  function render() {
    paintClient();
    const list = state.connections || [];
    $("mlc-list").innerHTML = list.length
      ? list.map(rowHtml).join("")
      : `<p class="panel-hint">Todavía no conectaste ningún correo.</p>`;
  }

  async function load() {
    try { state = await api(""); render(); }
    catch (err) { $("mlc-list").innerHTML = `<p class="form-error">${esc(err.message)}</p>`; }
  }

  $("mlc-ms-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await api("/microsoft", { method: "PUT", body: JSON.stringify({ clientId: $("mlc-ms-id").value }) });
      state.microsoftClientId = r.microsoftClientId;
      paintClient();
    } catch (err) { $("mlc-ms-note").textContent = err.message; }
  });

  // Outlook: código de Microsoft + espera a que el dueño inicie sesión.
  let pollTimer = null;
  $("mlc-ms-connect").addEventListener("click", async () => {
    const btn = $("mlc-ms-connect");
    btn.disabled = true;
    clearTimeout(pollTimer);
    try {
      const r = await api("/outlook/start", { method: "POST" });
      $("mlc-device").hidden = false;
      $("mlc-device-code").textContent = r.userCode;
      $("mlc-device-link").href = r.verificationUri;
      $("mlc-device-link").textContent = r.verificationUri.replace(/^https?:\/\//, "");
      $("mlc-device-state").innerHTML = `<span class="mlc-spin" aria-hidden="true"></span>Esperando que inicies sesión…`;
      const poll = async () => {
        try {
          const st = await api("/outlook/status/" + encodeURIComponent(r.pendingId));
          if (st.state === "waiting") { pollTimer = setTimeout(poll, 3000); return; }
          if (st.state === "done") {
            $("mlc-device-state").innerHTML = `✅ Conectado: <b>${esc(st.email)}</b>`;
            setTimeout(() => { $("mlc-device").hidden = true; }, 4000);
            btn.disabled = false;
            load();
            return;
          }
          $("mlc-device-state").textContent = "❌ " + st.message;
          btn.disabled = false;
        } catch (err) {
          $("mlc-device-state").textContent = "❌ " + err.message;
          btn.disabled = false;
        }
      };
      pollTimer = setTimeout(poll, 3000);
    } catch (err) {
      $("mlc-device").hidden = false;
      $("mlc-device-code").textContent = "—";
      $("mlc-device-state").textContent = "❌ " + err.message;
      btn.disabled = false;
    }
  });

  $("mlc-device-code").addEventListener("click", async (e) => {
    const code = e.currentTarget.textContent.trim();
    if (!code || code === "—") return;
    try { await navigator.clipboard.writeText(code); e.currentTarget.classList.add("copied"); setTimeout(() => e.currentTarget.classList.remove("copied"), 1200); } catch { /* sin portapapeles */ }
  });

  $("mlc-g-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("mlc-g-error");
    err.hidden = true;
    const btn = $("mlc-g-btn");
    btn.disabled = true; btn.textContent = "Conectando…";
    try {
      await api("/gmail", { method: "POST", body: JSON.stringify({ email: $("mlc-g-email").value, appPassword: $("mlc-g-pass").value }) });
      $("mlc-g-email").value = ""; $("mlc-g-pass").value = "";
      await load();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    btn.disabled = false; btn.textContent = "+ Conectar Gmail";
  });

  $("mlc-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const item = btn.closest(".mlc-item");
    const id = item.dataset.id;
    if (btn.dataset.act === "off") {
      const email = item.querySelector("b").textContent;
      if (!confirm(`¿Desconectar ${email}? El panel deja de leer sus códigos al instante.`)) return;
      btn.disabled = true;
      try { await api("/" + id, { method: "DELETE" }); await load(); } catch (ex) { btn.disabled = false; alert(ex.message); }
      return;
    }
    btn.disabled = true; btn.textContent = "Probando…";
    const out = item.querySelector(".mlc-test");
    try {
      const r = await api("/" + id + "/test", { method: "POST" });
      out.hidden = false; out.className = "mlc-test " + (r.ok ? "ok" : "bad"); out.textContent = r.message;
    } catch (ex) { out.hidden = false; out.className = "mlc-test bad"; out.textContent = ex.message; }
    btn.disabled = false; btn.textContent = "Probar";
  });

  window.LiordarkMail = { load };
})();
