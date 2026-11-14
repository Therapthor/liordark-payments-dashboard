// ─────────────────────────────────────────────────────────────
// «Movimiento» de la tienda: un aviso chico «Alguien compró Netflix ·
// hace 4 min» cada ~25 s. Solo compras REALES y confirmadas (pago Yape
// emparejado con su pedido), de GET /api/store/recent-purchases — que
// devuelve únicamente el producto y hace cuántos minutos, nada personal.
// Si no hay compras recientes, no se muestra nada.
//  · Nunca repite la misma compra en la sesión.
//  · No aparece con una ventana abierta ni encima de un botón.
//  · Con la ✕ se cierra y no vuelve en esa sesión.
// ─────────────────────────────────────────────────────────────
(function () {
  "use strict";

  const OFF_KEY  = "ldp_buy_toast_off";
  const SEEN_KEY = "ldp_buy_toast_seen";
  const FIRST_DELAY_MS = 7000;
  const EVERY_MS       = 25000;
  const VISIBLE_MS     = 5500;
  const RETRY_MS       = 3000;
  const REFRESH_MS     = 5 * 60 * 1000;

  const toast = document.getElementById("buy-toast");
  if (!toast) return;

  const store = {
    get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* bloqueado: solo en memoria */ } },
  };
  let closedInMemory = false;
  const isOff = () => closedInMemory || store.get(OFF_KEY) === "1";

  // Lo ya mostrado: producto + minuto aproximado de la compra (±2 min).
  let seen = [];
  try { seen = JSON.parse(store.get(SEEN_KEY) || "[]"); } catch { seen = []; }
  const nowMin = () => Math.floor(Date.now() / 60000);
  const keyOf = (p) => ({ l: p.platformLabel, t: nowMin() - p.minutesAgo });
  const wasSeen = (k) => seen.some(s => s.l === k.l && Math.abs(s.t - k.t) <= 2);

  let purchases = [];
  let fetchedAt = 0;
  async function refresh() {
    try {
      const res = await fetch("/api/store/recent-purchases", { credentials: "same-origin" });
      if (!res.ok) return;
      const data = await res.json();
      purchases = Array.isArray(data.purchases) ? data.purchases : [];
      fetchedAt = Date.now();
    } catch { /* sin red: se intenta en el próximo turno */ }
  }

  function agoText(minutes) {
    if (minutes < 1) return "hace un momento";
    if (minutes < 60) return "hace " + minutes + " min";
    const h = Math.floor(minutes / 60);
    if (h < 24) return "hace " + h + (h === 1 ? " hora" : " horas");
    const d = Math.floor(h / 24);
    return "hace " + d + (d === 1 ? " día" : " días");
  }

  // ¿Se puede mostrar ahora? Sin ventanas abiertas, pestaña visible y
  // sin tapar ningún botón ni enlace de la zona donde aparece.
  const INTERACTIVE = "button, a[href], input, select, textarea, label, .product-cta, .nav-btn";
  function canShowNow() {
    if (document.hidden) return false;
    if (document.querySelector(".modal-backdrop:not([hidden])")) return false;
    const panel = document.getElementById("notif-panel");
    if (panel && !panel.hidden) return false;
    const r = toast.getBoundingClientRect();
    const pts = [[r.left + 8, r.top + 8], [r.right - 8, r.top + 8], [r.left + r.width / 2, r.top + r.height / 2],
                 [r.left + 8, r.bottom - 8], [r.right - 8, r.bottom - 8]];
    for (const [x, y] of pts) {
      for (const el of document.elementsFromPoint(x, y)) {
        if (toast.contains(el)) continue;
        if (el.closest(INTERACTIVE)) return false;
      }
    }
    return true;
  }

  let hideTimer = null;
  function show(p) {
    const chip = window.LiordarkStore && window.LiordarkStore.platformChip
      ? window.LiordarkStore.platformChip(p.platformLabel, "sm") : "";
    document.getElementById("buy-toast-chip").innerHTML = chip;
    document.getElementById("buy-toast-title").textContent = "Alguien compró " + p.platformLabel;
    document.getElementById("buy-toast-time").textContent = agoText(p.minutesAgo) + " · pago confirmado";
    toast.classList.remove("is-in");
    toast.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("is-in")));
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, VISIBLE_MS);
  }
  function hide() {
    clearTimeout(hideTimer);
    if (toast.hidden) return;
    toast.classList.remove("is-in");
    setTimeout(() => { if (!toast.classList.contains("is-in")) toast.hidden = true; }, 420);
  }

  let tickTimer = null;
  async function tick() {
    if (isOff()) return;
    if (!fetchedAt || Date.now() - fetchedAt > REFRESH_MS) await refresh();
    const next = purchases.map(p => ({ p, k: keyOf(p) })).find(x => !wasSeen(x.k));
    if (!next) { tickTimer = setTimeout(tick, EVERY_MS); return; }
    // Medir dónde caería (oculto pero con su tamaño) antes de decidir.
    toast.classList.add("is-measuring");
    toast.hidden = false;
    const ok = canShowNow();
    toast.hidden = true;
    toast.classList.remove("is-measuring");
    if (!ok) { tickTimer = setTimeout(tick, RETRY_MS); return; }
    seen.push(next.k);
    seen = seen.slice(-60);
    store.set(SEEN_KEY, JSON.stringify(seen));
    show(next.p);
    tickTimer = setTimeout(tick, EVERY_MS);
  }

  document.getElementById("buy-toast-close").addEventListener("click", () => {
    closedInMemory = true;
    store.set(OFF_KEY, "1");
    clearTimeout(tickTimer);
    hide();
  });

  if (!isOff()) tickTimer = setTimeout(tick, FIRST_DELAY_MS);
})();
