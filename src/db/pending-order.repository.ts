import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// BITÁCORA DE PEDIDOS — reemplaza PEDIDOS_PENDIENTES de Sheets
//
// Registro puro para seguimiento del admin (qué pedidos quedaron sin
// stock, si ya se les asignó cuenta). No decide nada de la venta real —
// eso lo maneja access_accounts/access_profiles.
// ─────────────────────────────────────────────────────────────

export type OrderType = "Compra" | "Renovación" | "Compra sin stock";

/** Idempotente — si el order_name ya existe, no hace nada y devuelve success igual. */
export function createPendingOrder(params: {
  orderName: string;
  phone:     string;
  platform:  string;
  orderType: OrderType;
}): void {
  db.prepare(`
    INSERT OR IGNORE INTO pending_orders_log (order_name, phone, platform, order_type)
    VALUES (?, ?, ?, ?)
  `).run(params.orderName, params.phone, params.platform, params.orderType);
}

/** Devuelve found=false si el order_name no existe (igual que antes con Sheets). */
export function confirmPendingOrderPayment(orderName: string): { found: boolean } {
  const result = db.prepare(`
    UPDATE pending_orders_log SET payment_confirmed = 1 WHERE order_name = ?
  `).run(orderName);
  return { found: result.changes > 0 };
}

export function markPendingOrderAssigned(orderName: string): void {
  db.prepare(`
    UPDATE pending_orders_log SET assigned = 1 WHERE order_name = ?
  `).run(orderName);
}
