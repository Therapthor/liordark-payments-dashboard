(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // SEGURIDAD — dispositivos con el panel abierto (cerrar sesión en
  // cualquiera) y cambio de contraseña.
  // ─────────────────────────────────────────────────────────────

  async function api(path, options) {
    const res = await fetch("/api/auth" + path, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.reload(); throw new Error("No autenticado"); }
    if (!res.ok) throw new Error(data?.message || "Error de red");
    return data;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function deviceName(ua) {
    const s = String(ua || "");
    const os = /iPhone|iPad/.test(s) ? "iPhone/iPad" : /Android/.test(s) ? "Android" : /Windows/.test(s) ? "Windows"
      : /Mac OS X|Macintosh/.test(s) ? "Mac" : /Linux/.test(s) ? "Linux" : "Dispositivo";
    const br = /Edg\//.test(s) ? "Edge" : /OPR\//.test(s) ? "Opera" : /Chrome\//.test(s) ? "Chrome"
      : /Firefox\//.test(s) ? "Firefox" : /Safari\//.test(s) ? "Safari" : "Navegador";
    return `${br} en ${os}`;
  }

  function fmt(sqlDate) {
    try {
      const d = new Date(String(sqlDate).replace(" ", "T") + "Z");
      return d.toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" });
    } catch { return sqlDate; }
  }

  async function load() {
    const list = document.getElementById("sec-sessions");
    list.innerHTML = `<li class="feed-empty">Cargando…</li>`;
    try {
      const { sessions } = await api("/sessions");
      list.innerHTML = sessions.map(s => `
        <li class="sec-session${s.current ? " current" : ""}">
          <div>
            <b>${escapeHtml(deviceName(s.userAgent))}</b>${s.current ? ` <span class="sec-this">Este dispositivo</span>` : ""}
            <span>IP ${escapeHtml(s.ip || "?")} · última vez ${escapeHtml(fmt(s.lastSeenAt))} · inició ${escapeHtml(fmt(s.createdAt))}</span>
          </div>
          ${s.current ? "" : `<button class="btn-secondary btn-sm" data-revoke="${escapeHtml(s.id)}" type="button">Cerrar sesión</button>`}
        </li>`).join("") || `<li class="feed-empty">Sin sesiones abiertas.</li>`;
    } catch (err) {
      list.innerHTML = `<li class="feed-empty">${escapeHtml(err.message)}</li>`;
    }
  }

  function init() {
    document.getElementById("sec-sessions").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-revoke]");
      if (!btn) return;
      if (!confirm("¿Cerrar la sesión de ese dispositivo?")) return;
      try { await api("/sessions/" + btn.dataset.revoke + "/revoke", { method: "POST" }); } catch (err) { alert(err.message); }
      load();
    });
    document.getElementById("sec-revoke-others").addEventListener("click", async () => {
      if (!confirm("¿Cerrar la sesión en todos los demás dispositivos?")) return;
      try {
        const r = await api("/sessions/revoke-others", { method: "POST" });
        alert(`✅ Se cerraron ${r.closed} sesión(es).`);
      } catch (err) { alert(err.message); }
      load();
    });
    // Contraseña aleatoria generada en este navegador (no pasa por nadie).
    document.getElementById("sec-pw-generate").addEventListener("click", () => {
      const A = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
      const bytes = new Uint32Array(12);
      crypto.getRandomValues(bytes);
      const chars = Array.from(bytes, n => A[n % A.length]).join("");
      const pw = "Mango-" + chars.slice(0, 4) + "-" + chars.slice(4, 8) + "-" + chars.slice(8, 12).replace(/\D/g, "") + (Math.floor(Math.random() * 90) + 10);
      const n1 = document.getElementById("sec-pw-next"), n2 = document.getElementById("sec-pw-next2");
      n1.value = n2.value = pw;
      n1.type = "text";
      const out = document.getElementById("sec-pw-generated");
      out.hidden = false;
      out.innerHTML = "Tu nueva contraseña: <b></b> — anótala en un lugar seguro antes de guardar.";
      out.querySelector("b").textContent = pw;
    });

    document.getElementById("sec-password-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = document.getElementById("sec-pw-msg");
      const current = document.getElementById("sec-pw-current").value;
      const next = document.getElementById("sec-pw-next").value;
      const next2 = document.getElementById("sec-pw-next2").value;
      msg.hidden = false; msg.style.color = "";
      if (next !== next2) { msg.textContent = "Las contraseñas nuevas no coinciden."; return; }
      try {
        const r = await api("/password", { method: "POST", body: JSON.stringify({ current, next }) });
        e.target.reset();
        document.getElementById("sec-pw-next").type = "password";
        document.getElementById("sec-pw-generated").hidden = true;
        msg.style.color = "var(--success, #2f9e5b)";
        msg.textContent = `✅ Contraseña cambiada. Se cerraron ${r.closed} sesión(es) en otros dispositivos.`;
        load();
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  init();
  // ─── Enlace con clave para la app de Yape ───
  function paintYape(d) {
    const input = document.getElementById("sec-yape-url");
    input.value = d.url || ("Clave: " + d.key + "  (agrégala al enlace de tu app como ?key=…)");
    document.getElementById("sec-yape-state").textContent = d.required
      ? "✅ Tu app ya usa la clave: los avisos sin clave se rechazan."
      : "⚠️ Tu app todavía no usa la clave. Pon este enlace en la app; mientras tanto, revisa y aprueba a mano los pedidos.";
  }

  async function loadYape() {
    try { paintYape(await api("/yape-link")); }
    catch (err) { document.getElementById("sec-yape-state").textContent = "⚠️ " + err.message; }
  }

  document.getElementById("sec-yape-copy").addEventListener("click", async () => {
    const v = document.getElementById("sec-yape-url").value;
    try { await navigator.clipboard.writeText(v); alert("Enlace copiado."); }
    catch { document.getElementById("sec-yape-url").select(); }
  });

  document.getElementById("sec-yape-rotate").addEventListener("click", async () => {
    if (!confirm("¿Cambiar la clave? Tendrás que poner el enlace nuevo en la app de Yape; el anterior deja de funcionar.")) return;
    try { paintYape(await api("/yape-link/rotate", { method: "POST" })); }
    catch (err) { alert(err.message); }
  });

  const loadAll = () => { load(); loadYape(); };
  window.LiordarkSecurity = { load: loadAll };
})();
