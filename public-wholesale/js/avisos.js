/* ═══════════════════════════════════════════════════════════════
   Avisos del panel mayorista — ventana con imagen que el admin arma
   en el panel (Configuración › Avisos). Aparece al entrar (después del
   login), nunca encima de otra ventana abierta, y se cierra con un toque.
   Misma ventana que la tienda (public-store/js/avisos.js).
   ═══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const KEY = "ldAviso:wholesale";
  let shownThisLoad = false;

  // ─── Ventana (mismo diseño en mayorista y en la vista previa del panel) ───

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function openPopup(a, onAction) {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const prevFocus = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "aviso-backdrop";
    wrap.setAttribute("data-aviso", "");
    const size = a.imageW && a.imageH ? ` width="${a.imageW}" height="${a.imageH}"` : "";
    wrap.innerHTML = `
      <div class="aviso-card" role="dialog" aria-modal="true" aria-label="${esc(a.title || "Aviso")}" tabindex="-1">
        <button class="aviso-x" type="button" aria-label="Cerrar">✕</button>
        <div class="aviso-media"><img src="${esc(a.imageUrl)}" alt="${esc(a.title || "Promoción")}"${size} decoding="async"></div>
        ${a.title ? `<p class="aviso-title">${esc(a.title)}</p>` : ""}
        <div class="aviso-actions">
          ${a.button ? `<button class="aviso-cta" type="button">${esc(a.button.text)}</button>` : ""}
          <button class="aviso-close-text" type="button">Cerrar</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    document.documentElement.classList.add("aviso-lock");
    const card = wrap.querySelector(".aviso-card");
    try { card.focus({ preventScroll: true }); } catch { /* navegador viejo */ }

    let closed = false;
    function close(after) {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey);
      wrap.classList.add("is-closing");
      const done = () => {
        wrap.remove();
        if (!document.querySelector("[data-aviso]")) document.documentElement.classList.remove("aviso-lock");
        if (prevFocus && prevFocus.focus) { try { prevFocus.focus({ preventScroll: true }); } catch { /* nada */ } }
        if (after) after();
      };
      setTimeout(done, reduce ? 130 : 270);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap || e.target.closest(".aviso-x, .aviso-close-text")) close();
      else if (e.target.closest(".aviso-cta")) close(() => onAction && onAction(a.button));
    });
    return close;
  }

  // ─── Cuándo mostrarlo ───

  function today() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function alreadySeen(a) {
    if (shownThisLoad) return true;
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!s || s.rev !== a.rev) return false;
      return a.frequency === "daily" ? s.day === today() : true;
    } catch { return false; }
  }
  function markSeen(a) {
    shownThisLoad = true;
    try { localStorage.setItem(KEY, JSON.stringify({ rev: a.rev, day: today() })); } catch { /* sin almacenamiento: una vez por visita */ }
  }

  // Otra ventana abierta (compra, códigos, soporte…), campanita abierta,
  // pestaña oculta o todavía en el login.
  function busy() {
    if (document.hidden) return true;
    const app = document.getElementById("view-app");
    if (!app || app.hidden) return true;
    if (document.querySelector(".modal-backdrop:not([hidden]), [data-aviso]")) return true;
    const np = document.getElementById("notif-panel");
    return !!(np && !np.hidden);
  }
  function waitFor(test, fn, maxMs, everyMs) {
    const start = Date.now();
    (function check() {
      if (test()) return fn(true);
      if (Date.now() - start > maxMs) return fn(false);
      setTimeout(check, everyMs);
    })();
  }

  // «Ir a un producto»: abre Comprar y resalta ese producto.
  function onAction(btn) {
    if (!btn) return;
    if (btn.type === "product") {
      const nav = document.querySelector('button[data-page="comprar"]');
      if (nav) nav.click();
      const sel = '#catalog-grid [data-platform="' + (window.CSS && CSS.escape ? CSS.escape(btn.platform) : btn.platform) + '"]';
      waitFor(() => document.querySelector(sel), (ok) => {
        if (!ok) return;
        const card = document.querySelector(sel).closest(".catalog-card");
        if (!card) return;
        const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        card.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
        card.classList.remove("aviso-focus");
        void card.offsetWidth;
        card.classList.add("aviso-focus");
      }, 8000, 150);
    } else if (btn.type === "link") {
      let internal = false;
      try {
        const u = new URL(btn.url, location.href);
        internal = u.hostname === location.hostname;
      } catch { return; }
      if (internal) location.href = btn.url;
      else window.open(btn.url, "_blank", "noopener");
    }
  }

  let checking = false;
  async function check() {
    if (checking || shownThisLoad) return;
    const app = document.getElementById("view-app");
    if (!app || app.hidden) return;
    checking = true;
    let aviso = null;
    try {
      const res = await fetch("/api/wholesaler/aviso?_=" + Date.now(), { credentials: "same-origin" });
      if (res.ok) aviso = (await res.json()).aviso;
    } catch { /* sin aviso, el panel sigue normal */ }
    checking = false;
    if (!aviso || !aviso.imageUrl || alreadySeen(aviso)) return;
    const pre = new Image();
    pre.src = aviso.imageUrl;
    setTimeout(() => {
      waitFor(() => !busy(), (ok) => {
        if (!ok || alreadySeen(aviso)) return;
        markSeen(aviso);
        openPopup(aviso, onAction);
      }, 10 * 60_000, 500);
    }, 700);
  }

  function start() {
    const app = document.getElementById("view-app");
    if (!app) return;
    // Se muestra al entrar: ya con sesión, o apenas termina el login.
    new MutationObserver(check).observe(app, { attributes: true, attributeFilter: ["hidden"] });
    check();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
