/* ═════════════════════════════════════════════════════════════════
   MANGO PRO — orden de trabajo de cada vista («productive layout»)
   ─────────────────────────────────────────────────────────────────
   Cada tarjeta o fila muestra 1 acción principal + 2 secundarias; el
   resto pasa al menú «⋯» (los botones de siempre siguen en la página,
   ocultos, con su misma lógica). Lo que borra o libera va al menú, en rojo.
   ═════════════════════════════════════════════════════════════════ */
(() => {
  "use strict";
  const MP = window.MP;
  if (!MP || !MP.collapse) return;

  // ── Resumen: pedidos y renovaciones (✅ ❌ 🧹 a la vista, lo demás en «⋯») ──
  MP.collapse.register(".pending-order-actions", { keep: 3 });

  // ── Soportes: «Reemplazar» + WhatsApp + Listo; lo demás en «⋯» ──
  MP.collapse.register(".soporte-actions", { keep: 2, prefer: ["a[href*='wa.me'], a[href*='whatsapp']", "[data-act='solved']"] });

  // ── Clientes: 2 acciones a la vista; Banear / Fraude / resto en «⋯» ──
  MP.collapse.register(".web-customer-actions", { keep: 2 });

  // ── Accesos ──
  MP.collapse.register(".access-account-summary-actions", { keep: 2 });
  MP.collapse.register(".access-account-actions", { keep: 2, prefer: [".access-copy-credentials", ".access-renew-account"] });
  MP.collapse.register(".access-row-actions", { keep: 2 });
  MP.collapse.register(".access-client-item-actions", { keep: 2 });
})();
