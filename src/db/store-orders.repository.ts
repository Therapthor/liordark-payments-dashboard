import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// PEDIDOS DE LA TIENDA (liordark.com)
//
// 1) De quién es cada pedido web: /checkout guarda acá el código de orden
//    que devolvió el bot junto al cliente logueado. Sirve solo para que
//    GET /api/store/orders/:orderName/status le conteste a ESE cliente si
//    su pago ya llegó (pantalla «¡Pago aprobado!» de una reserva sin
//    stock) — nunca a otro.
// 2) «Movimiento» de compras: las últimas compras CONFIRMADAS (pago Yape
//    emparejado por el bot con su orden), solo plataforma y hace cuánto.
// ─────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS store_web_orders (
    order_name  TEXT    PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

export function saveStoreWebOrder(orderName: string, customerId: number): void {
  db.prepare(`INSERT OR REPLACE INTO store_web_orders (order_name, customer_id) VALUES (?, ?)`)
    .run(orderName, customerId);
}

/** ¿El pago de ESTA orden ya está confirmado? Solo si la orden es del cliente. */
export function storeOrderPaymentStatus(orderName: string, customerId: number): { found: boolean; paid: boolean } {
  const own = db.prepare(`SELECT 1 FROM store_web_orders WHERE order_name = ? AND customer_id = ?`)
    .get(orderName, customerId);
  if (!own) return { found: false, paid: false };
  // Pago confirmado = el bot emparejó un Yape verificado con esta orden
  // (payments.status 'matched', mismo criterio que los links de venta) o
  // confirmó la orden en la bitácora de pedidos (pending_orders_log).
  const paid = !!db.prepare(`
    SELECT 1 WHERE
      EXISTS (SELECT 1 FROM payments WHERE order_name = ? AND status = 'matched')
      OR EXISTS (SELECT 1 FROM pending_orders_log WHERE order_name = ? AND payment_confirmed = 1)
  `).get(orderName, orderName);
  return { found: true, paid };
}

export type RecentPurchase = { platformLabel: string; minutesAgo: number };

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
}

/**
 * Compras confirmadas de las últimas `hours` horas, la más nueva primero.
 * Fuentes: (a) perfiles vendidos por el bot cuyo pedido tiene un Yape
 * emparejado; (b) compras sin stock con el pago ya confirmado. Quedan
 * afuera renovaciones, recargas y ventas de mayoristas (pagan con saldo,
 * sin Yape emparejado; y por si acaso, cualquier pedido de un celular de
 * mayorista), y todo lo que no esté en el catálogo activo de la tienda.
 * No sale nada personal: solo el nombre del producto y los minutos.
 */
export function listRecentConfirmedPurchases(hours = 72, limit = 20): RecentPurchase[] {
  const now = Date.now();
  const cutoffMs = now - hours * 3600_000;
  const cutoffIso = new Date(cutoffMs).toISOString();                         // payments.created_at (ISO UTC)
  const cutoffSql = cutoffIso.slice(0, 19).replace("T", " ");                 // datetime('now') (UTC)

  const labels = new Map<string, string>();
  for (const r of db.prepare(`SELECT platform, title FROM catalog_products WHERE active = 1`).all() as any[]) {
    labels.set(String(r.platform).trim().toUpperCase(), String(r.title || "").trim() || titleCase(String(r.platform)));
  }

  const notRenewal = `
    NOT EXISTS (SELECT 1 FROM renewals_log r WHERE r.order_name = X)
    AND NOT EXISTS (SELECT 1 FROM pending_orders_log r2 WHERE r2.order_name = X AND r2.order_type <> 'Compra' AND r2.order_type <> 'Compra sin stock')`;

  const sold = db.prepare(`
    SELECT DISTINCT p.order_name AS orderName, a.platform AS platform, p.created_at AS at
    FROM payments p
    JOIN access_profiles ap ON ap.order_ref = p.order_name
    JOIN access_accounts a  ON a.id = ap.account_id
    WHERE p.status = 'matched' AND p.order_name <> '' AND p.created_at >= ?
      AND ${notRenewal.replace(/X/g, "p.order_name")}
      AND NOT EXISTS (SELECT 1 FROM wholesalers w WHERE substr(w.phone, -9) = substr(ap.client_phone, -9))
  `).all(cutoffIso) as { orderName: string; platform: string; at: string }[];

  const reserved = db.prepare(`
    SELECT po.order_name AS orderName, po.platform AS platform, po.created_at AS at
    FROM pending_orders_log po
    WHERE po.order_type = 'Compra sin stock' AND po.created_at >= ?
      AND (po.payment_confirmed = 1
           OR EXISTS (SELECT 1 FROM payments p WHERE p.order_name = po.order_name AND p.status = 'matched'))
      AND NOT EXISTS (SELECT 1 FROM wholesalers w WHERE substr(w.phone, -9) = substr(po.phone, -9))
  `).all(cutoffSql) as { orderName: string; platform: string; at: string }[];

  const seen = new Set<string>();
  const out: { label: string; ms: number }[] = [];
  for (const r of [...sold, ...reserved]) {
    const label = labels.get(String(r.platform).trim().toUpperCase());
    if (!label) continue;
    const key = r.orderName + "|" + label;
    if (seen.has(key)) continue;
    seen.add(key);
    const ms = Date.parse(r.at.includes("T") ? r.at : r.at.replace(" ", "T") + "Z");
    if (!Number.isFinite(ms) || ms < cutoffMs) continue;
    out.push({ label, ms });
  }
  out.sort((x, y) => y.ms - x.ms);
  return out.slice(0, limit).map(o => ({ platformLabel: o.label, minutesAgo: Math.max(0, Math.floor((now - o.ms) / 60_000)) }));
}
