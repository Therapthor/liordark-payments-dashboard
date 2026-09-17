import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// BITÁCORA DE CANVA — reemplaza el registro en la hoja 'CANVA ANUAL'.
//
// CANVA no vende "stock" pre-cargado (access_accounts) — el admin activa
// el plan a mano en Canva.com con el correo del cliente, y esto solo
// registra esa aprobación para su propio historial.
// ─────────────────────────────────────────────────────────────

/** Idempotente — si el order_name ya existe, no hace nada. */
export function logCanvaOrder(params: {
  orderName:   string;
  phone:       string;
  clientEmail: string;
}): void {
  db.prepare(`
    INSERT OR IGNORE INTO canva_orders_log (order_name, phone, client_email)
    VALUES (?, ?, ?)
  `).run(params.orderName, params.phone, params.clientEmail);
}
