// ─────────────────────────────────────────────────────────────
// Movimiento tipo iPhone para la tienda (solo transform/opacity, curva
// de iOS). No cambia ninguna lógica de app.js: solo observa el DOM.
//  · Tarjetas y secciones aparecen escalonadas al entrar en pantalla
//    (IntersectionObserver, una sola vez por elemento).
//  · Al cambiar de sección, la nueva entra hacia el lado del menú tocado.
//  · Las ventanas se cierran suave (antes desaparecían de golpe).
//  · El carrito de «Arma tu combo» anima la fila nueva y el total.
// Con «reducir movimiento» activado en el teléfono/PC no hace nada.
// ─────────────────────────────────────────────────────────────
(function () {
  "use strict";

  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;
  const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

  // ── 1. Aparición escalonada al hacer scroll ──
  // El banner «Arma tu combo» queda fuera a propósito (igual que en producción).
  const REVEAL_SEL = [
    ".product-card", ".section-chip", "#dashboard-active-list .success-account-card",
    ".renewal-account-card", ".codes-acc", ".course-banner", ".info-line",
    ".dashboard-notify-btn", ".dashboard-subtitle",
  ].join(",");

  const settle = (el) => {
    el.classList.remove("rv", "rv-in");
    el.style.removeProperty("--rv-delay");
  };

  const io = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    const entering = entries.filter(e => e.isIntersecting).map(e => e.target);
    entering.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    entering.forEach((el, i) => {
      io.unobserve(el);
      el.style.setProperty("--rv-delay", Math.min(i, 8) * 45 + "ms");
      el.classList.add("rv-in");
      // Terminada la entrada se quita todo: el hover/press vuelve a su ritmo normal.
      const done = () => settle(el);
      el.addEventListener("transitionend", function onEnd(ev) {
        if (ev.target !== el || ev.propertyName !== "transform") return;
        el.removeEventListener("transitionend", onEnd);
        done();
      });
      setTimeout(done, 1400);
    });
  }, { rootMargin: "0px 0px -6% 0px", threshold: 0.08 }) : null;

  function arm(root) {
    if (!io || !root || !root.querySelectorAll) return;
    root.querySelectorAll(REVEAL_SEL).forEach(el => {
      if (el.dataset.rv) return;
      el.dataset.rv = "1";
      el.classList.add("rv");
      io.observe(el);
    });
  }

  // ── 2. Dirección al cambiar de sección (Tienda → Mis cuentas → Códigos) ──
  const ORDER = ["catalog", "dashboard", "codes"];
  let lastPage = document.body.dataset.page || "catalog";
  new MutationObserver(() => {
    const page = document.body.dataset.page || "catalog";
    if (page === lastPage) return;
    document.body.dataset.navDir = ORDER.indexOf(page) >= ORDER.indexOf(lastPage) ? "fwd" : "back";
    lastPage = page;
  }).observe(document.body, { attributes: true, attributeFilter: ["data-page"] });

  // ── 3. Ventanas: cierre suave ──
  // app.js abre/cierra con modal.hidden = true/false. Acá ese «hidden» de
  // cada ventana espera a que termine la animación de salida antes de
  // ocultarla de verdad (mientras tanto ya no recibe toques).
  const hiddenProp = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidden");
  const CLOSE_MS = 240;
  function smoothClose(el) {
    if (!hiddenProp || el.dataset.smoothClose) return;
    el.dataset.smoothClose = "1";
    let logical = hiddenProp.get.call(el);
    let timer = null;
    Object.defineProperty(el, "hidden", {
      configurable: true,
      get() { return logical; },
      set(value) {
        const hide = !!value;
        logical = hide;
        clearTimeout(timer);
        if (!hide) {
          el.classList.remove("mp-closing");
          hiddenProp.set.call(el, false);
          return;
        }
        if (hiddenProp.get.call(el)) return;
        // El detalle de producto ya trae su propia salida (clase .closing).
        if (el.classList.contains("closing")) { hiddenProp.set.call(el, true); return; }
        el.classList.add("mp-closing");
        timer = setTimeout(() => {
          el.classList.remove("mp-closing");
          if (logical) hiddenProp.set.call(el, true);
        }, CLOSE_MS);
      },
    });
  }

  // ── 4. «Arma tu combo»: fila nueva del carrito, total y botón ✓ ──
  function animate(el, frames, ms) {
    if (el && el.animate) el.animate(frames, { duration: ms, easing: EASE });
  }
  function watchCombo() {
    const list = document.getElementById("build-combo-cart-list");
    const total = document.getElementById("build-combo-total");
    const catalog = document.getElementById("build-combo-catalog");
    if (!list || !total || !catalog) return;
    let rows = new Set();
    const rowKey = (r) => (r.querySelector("[data-platform]") || {}).dataset?.platform || r.textContent;
    new MutationObserver(() => {
      const now = new Set();
      list.querySelectorAll(".build-combo-cart-row").forEach(r => {
        const k = rowKey(r);
        now.add(k);
        if (!rows.has(k)) animate(r, [{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "none" }], 380);
      });
      rows = now;
    }).observe(list, { childList: true });
    let lastTotal = total.textContent;
    new MutationObserver(() => {
      if (total.textContent === lastTotal) return;
      lastTotal = total.textContent;
      animate(total, [{ transform: "scale(1.12)" }, { transform: "none" }], 420);
    }).observe(total, { childList: true, characterData: true, subtree: true });
    let added = new Set();
    new MutationObserver(() => {
      const now = new Set();
      catalog.querySelectorAll(".build-combo-add-btn:disabled").forEach(b => {
        now.add(b.dataset.platform);
        if (!added.has(b.dataset.platform)) animate(b, [{ transform: "scale(.6)" }, { transform: "scale(1.08)", offset: .6 }, { transform: "none" }], 420);
      });
      added = now;
    }).observe(catalog, { childList: true });
  }

  function init() {
    document.querySelectorAll(".modal-backdrop").forEach(smoothClose);
    ["catalog-sections", "page-catalog", "page-dashboard", "page-codes"].forEach(id => {
      const root = document.getElementById(id);
      if (!root) return;
      arm(root);
      new MutationObserver(() => arm(root)).observe(root, { childList: true, subtree: true });
    });
    watchCombo();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
