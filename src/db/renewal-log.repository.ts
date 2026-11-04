import { db } from "./db";
import { findAccountByClientPhone, setProfileRenewal } from "./access.repository";

function last9(phone: string): string {
  return phone.replace(/\D/g, "").slice(-9);
}

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

/**
 * Devuelve found=false si el order_name no existe. Además de marcar la
 * bitácora, marca el checkbox "✅ Renueva" del perfil del cliente — antes
 * esto solo quedaba en el registro y el cliente pagaba sin que se viera
 * reflejado en ningún lado (ver runRenewalCutover en access.service.ts
 * para dónde se aplican de verdad los 30 días extra, 1 día antes de que
 * venza la cuenta).
 */
export function confirmRenewalLog(orderName: string): { found: boolean } {
  const row = db.prepare(`
    SELECT phone, platform FROM renewals_log WHERE order_name = ?
  `).get(orderName) as { phone: string; platform: string } | undefined;

  const result = db.prepare(`
    UPDATE renewals_log SET status = 'Confirmado' WHERE order_name = ?
  `).run(orderName);

  if (result.changes > 0 && row) {
    const account = findAccountByClientPhone(row.platform, row.phone);
    const profile = account?.profiles.find(p => last9(p.clientPhone) === last9(row.phone));
    if (profile) setProfileRenewal(profile.id, "yes");
  }

  return { found: result.changes > 0 };
}
