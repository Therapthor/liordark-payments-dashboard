// Configuración › 📈 Publicidad — ID del píxel de TikTok.
// Ver routes/marketing.routes.ts; la tienda lo usa en public-store/js/app.js.
(function () {
  "use strict";
  const $ = id => document.getElementById(id);

  function setStatus(id) {
    $("mkt-tiktok-status").textContent = id
      ? "✅ Activo en la tienda: " + id
      : "Apagado: la tienda no manda nada a TikTok.";
  }

  async function load() {
    try {
      const res = await fetch("/api/marketing/tiktok-pixel", { credentials: "include" });
      if (!res.ok) return;
      const { pixelId } = await res.json();
      $("mkt-tiktok-id").value = pixelId || "";
      setStatus(pixelId);
    } catch { /* sin red */ }
  }

  function init() {
    const form = $("mkt-tiktok-form");
    if (!form) return;
    form.addEventListener("submit", async e => {
      e.preventDefault();
      $("mkt-tiktok-status").textContent = "Guardando…";
      try {
        const res = await fetch("/api/marketing/tiktok-pixel", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pixelId: $("mkt-tiktok-id").value }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { $("mkt-tiktok-status").textContent = "⚠️ " + (data.message || "No se pudo guardar."); return; }
        $("mkt-tiktok-id").value = data.pixelId || "";
        setStatus(data.pixelId);
      } catch {
        $("mkt-tiktok-status").textContent = "⚠️ Sin conexión con el panel.";
      }
    });
  }

  window.LiordarkMarketing = { load };
  document.addEventListener("DOMContentLoaded", init);
})();
