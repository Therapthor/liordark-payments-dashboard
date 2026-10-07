import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// BITÁCORA DE ACTIVACIÓN MANUAL (CANVA, GEMINI AI PRO, ...) — reemplaza
// el registro en la hoja 'CANVA ANUAL'. La tabla sigue llamándose
// canva_orders_log por ser la original, pero ahora registra cualquier
// plataforma que se activa a mano con el correo del cliente.
//
// Estas plataformas no venden "stock" pre-cargado (access_accounts) —
// el admin activa el plan a mano con el correo del cliente, y esto solo
// registra esa aprobación para su propio historial.
// ─────────────────────────────────────────────────────────────

/** Idempotente — si el order_name ya existe, no hace nada. */
export function logCanvaOrder(params: {
  orderName:   string;
  phone:       string;
  clientEmail: string;
  platform:    string;
}): void {
  db.prepare(`
    INSERT OR IGNORE INTO canva_orders_log (order_name, phone, client_email, platform)
    VALUES (?, ?, ?, ?)
  `).run(params.orderName, params.phone, params.clientEmail, params.platform);
}
