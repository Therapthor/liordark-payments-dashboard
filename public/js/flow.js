(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // HELPERS (propios — este archivo no depende de app.js)
  // ─────────────────────────────────────────────────────────────

  async function api(path, options = {}) {
    const res = await fetch("/api/bot-flow" + path, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (res.status === 401) { location.reload(); throw new Error("No autenticado"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "Error de red");
    return data;
  }

  // ─────────────────────────────────────────────────────────────
  // FLUJO DE WHATSAPP — un solo formulario, sin lista (fila única)
  // ─────────────────────────────────────────────────────────────

  const FIELDS = [
    "welcomeGreeting", "menuPrompt",
    "btnTermsTitle", "btnProductsTitle", "btnSupportTitle",
    "termsText",
    "supportMessage", "contactPhone", "contactWaLink",
    "fallbackUnknownOption", "fallbackUnknownType", "backMainResponse",
  ];

  async function load() {
    const { config } = await api("/");
    for (const field of FIELDS) {
      const el = document.getElementById("flow-" + field);
      if (el) el.value = config[field] ?? "";
    }
    await loadPrincipalImage();
  }

  // ─────────────────────────────────────────────────────────────
  // IMAGEN PRINCIPAL DEL MENÚ
  // ─────────────────────────────────────────────────────────────

  async function loadPrincipalImage() {
    const preview = document.getElementById("principal-image-preview");
    const status  = document.getElementById("principal-image-status");
    try {
      const { url, configured } = await api("/principal-image");
      if (!configured) {
        status.textContent = "⚠️ Cloudinary no está configurado en el panel — pide que agreguen las variables CLOUDINARY_* al .env del panel.";
        status.hidden = false;
        return;
      }
      if (url) {
        preview.src = url;
        preview.hidden = false;
      }
      status.hidden = true;
    } catch (err) {
      status.textContent = "No se pudo cargar la imagen actual: " + (err.message || "error desconocido");
      status.hidden = false;
    }
  }

  function initPrincipalImageForm() {
    const form   = document.getElementById("principal-image-form");
    const status = document.getElementById("principal-image-status");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById("principal-image-file");
      const file = fileInput.files[0];
      if (!file) {
        status.textContent = "Elige una imagen primero.";
        status.hidden = false;
        return;
      }

      const submitBtn = form.querySelector("button[type=submit]");
      submitBtn.disabled = true;
      status.textContent = "Subiendo…";
      status.hidden = false;

      try {
        const body = new FormData();
        body.append("image", file);
        const res = await fetch("/api/bot-flow/principal-image", {
          method: "POST",
          credentials: "include",
          body,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.message || "Error de red");

        document.getElementById("principal-image-preview").src = data.url;
        document.getElementById("principal-image-preview").hidden = false;
        fileInput.value = "";
        status.textContent = "✅ Imagen actualizada — el bot la toma en unos minutos.";
      } catch (err) {
        status.textContent = "❌ " + (err.message || "No se pudo subir la imagen.");
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  function readForm() {
    const data = {};
    for (const field of FIELDS) {
      const el = document.getElementById("flow-" + field);
      data[field] = el ? el.value.trim() : "";
    }
    return data;
  }

  function initForm() {
    const form  = document.getElementById("flow-form");
    const saved = document.getElementById("flow-form-saved");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submitBtn = form.querySelector("button[type=submit]");
      submitBtn.disabled = true;
      try {
        await api("/", { method: "PUT", body: JSON.stringify(readForm()) });
        saved.classList.add("show");
        setTimeout(() => saved.classList.remove("show"), 2000);
      } catch (err) {
        alert(err.message || "No se pudo guardar el flujo.");
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────

  let initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    initForm();
    initPrincipalImageForm();
  }

  window.LiordarkFlow = { init, load };
})();
