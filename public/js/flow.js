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
  }

  window.LiordarkFlow = { init, load };
})();
