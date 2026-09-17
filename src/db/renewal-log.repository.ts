import { db } from "./db";
import { findAccountByClientPhone } from "./access.repository";

// ─────────────────────────────────────────────────────────────
// BITÁCORA DE RENOVACIONES — reemplaza RENOVACIONES_CLIENTES de Sheets
//
// Solo registro para seguimiento del admin. La fecha de vencimiento real
// se actualiza aparte (cuenta nueva vía sellProfile, o el botón "Renovar"
// del panel para la misma cuenta) — esto no decide nada de eso.
// ─────────────────────────────────────────────────────────────

/** Idempotente — si el order_name ya existe, no hace nada. */
export function createRenewalLog(params: {
  orderName: string;
  phone:     string;
  platform:  string;
}): void {
  const account = findAccountByClientPhone(params.platform, params.phone);
  const initialEmail = account?.email ?? "";

  db.prepare(`
    INSERT OR IGNORE INTO renewals_log (order_name, phone, platform, initial_email)
    VALUES (?, ?, ?, ?)
  `).run(params.orderName, params.phone, params.platform, initialEmail);
}

/** Devuelve found=false si el order_name no existe. */
export function confirmRenewalLog(orderName: string): { found: boolean } {
  const result = db.prepare(`
    UPDATE renewals_log SET status = 'Confirmado' WHERE order_name = ?
  `).run(orderName);
  return { found: result.changes > 0 };
}
