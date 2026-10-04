import { db } from "./db";
import { normalizePeruPhone } from "../utils/phone.util";
import { applyWholesalerCreditChange } from "./wholesaler-credit.repository";
import { checkLockout, nextLockoutState, type LockoutCheck } from "../services/login-lockout.service";

// ─────────────────────────────────────────────────────────────
// MAYORISTAS — ver tables.sql (wholesalers). Cuenta siempre creada por
// el admin (nunca self-registro) — ver wholesaler-auth.routes.ts, que
// solo expone login/logout/me, nunca /register.
// ─────────────────────────────────────────────────────────────

export type Wholesaler = {
  id:                number;
  phone:             string;
  passwordHash:      string;
  passwordPlain:     string;
  displayName:       string;
  balanceCents:      number;
  status:            "active" | "disabled";
  lastActivityAt:    string;
  failedLoginCount:  number;
  lockedUntil:       string | null;
  createdAt:         string;
  updatedAt:         string;
};

function toWholesaler(row: any): Wholesaler {
  return {
    id:                row.id,
    phone:             row.phone,
    passwordHash:      row.password_hash,
    passwordPlain:     row.password_plain,
    displayName:       row.display_name,
    balanceCents:      row.balance_cents,
    status:            row.status,
    lastActivityAt:    row.last_activity_at,
    failedLoginCount:  row.failed_login_count,
    lockedUntil:       row.locked_until,
    createdAt:         row.created_at,
    updatedAt:         row.updated_at,
  };
}

export function createWholesaler(phone: string, passwordHash: string, passwordPlain: string, displayName: string): Wholesaler {
  const info = db.prepare(`
    INSERT INTO wholesalers (phone, password_hash, password_plain, display_name) VALUES (?, ?, ?, ?)
  `).run(normalizePeruPhone(phone), passwordHash, passwordPlain, displayName);
  return findWholesalerById(info.lastInsertRowid as number) as Wholesaler;
}

// Mismo criterio de últimos-9-dígitos que customer.repository.ts —
// el celular puede haber quedado guardado con o sin el prefijo "51".
export function findWholesalerByPhone(phone: string): Wholesaler | null {
  const digits = phone.replace(/\D/g, "");
  const row = db.prepare(`SELECT * FROM wholesalers WHERE substr(phone, -9) = substr(?, -9)`).get(digits);
  return row ? toWholesaler(row) : null;
}

export function findWholesalerById(id: number): Wholesaler | null {
  const row = db.prepare(`SELECT * FROM wholesalers WHERE id = ?`).get(id);
  return row ? toWholesaler(row) : null;
}

export function listAllWholesalers(): Wholesaler[] {
  const rows = db.prepare(`SELECT * FROM wholesalers ORDER BY created_at DESC`).all();
  return rows.map(toWholesaler);
}

export function setWholesalerStatus(id: number, status: "active" | "disabled"): void {
  db.prepare(`UPDATE wholesalers SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
}

export function setWholesalerPassword(id: number, passwordHash: string, passwordPlain: string): Wholesaler | null {
  db.prepare(`UPDATE wholesalers SET password_hash = ?, password_plain = ? WHERE id = ?`)
    .run(passwordHash, passwordPlain, id);
  return findWholesalerById(id);
}

/** Cualquier compra/recarga "toca" la actividad — de eso depende la regla de 1 mes. */
export function touchWholesalerActivity(id: number): void {
  db.prepare(`UPDATE wholesalers SET last_activity_at = datetime('now') WHERE id = ?`).run(id);
}

/** Bloqueo por intentos fallidos — ver login-lockout.service.ts para la fórmula. */
export function wholesalerLockoutStatus(phone: string): LockoutCheck {
  const wholesaler = findWholesalerByPhone(phone);
  return checkLockout(wholesaler?.lockedUntil);
}

export function recordWholesalerLoginFailure(phone: string): void {
  const wholesaler = findWholesalerByPhone(phone);
  if (!wholesaler) return;
  const { failedLoginCount, lockedUntil } = nextLockoutState(wholesaler.failedLoginCount);
  db.prepare(`UPDATE wholesalers SET failed_login_count = ?, locked_until = ? WHERE id = ?`)
    .run(failedLoginCount, lockedUntil, wholesaler.id);
}

export function recordWholesalerLoginSuccess(id: number): void {
  db.prepare(`UPDATE wholesalers SET failed_login_count = 0, locked_until = NULL WHERE id = ?`).run(id);
}

/**
 * 1 mes sin comprar/recargar → deshabilitada y saldo borrado (a pedido
 * explícito del dueño). El borrado de saldo pasa por
 * applyWholesalerCreditChange para que quede en el ledger, no sea un
 * reseteo silencioso de la columna.
 */
export function disableInactiveWholesalers(): number {
  const inactive = db.prepare(`
    SELECT id, balance_cents FROM wholesalers
    WHERE status = 'active' AND last_activity_at < datetime('now', '-1 month')
  `).all() as { id: number; balance_cents: number }[];

  for (const w of inactive) {
    setWholesalerStatus(w.id, "disabled");
    if (w.balance_cents > 0) {
      applyWholesalerCreditChange(w.id, -w.balance_cents, "wipe_inactive", "1 mes sin actividad", "system");
    }
  }
  return inactive.length;
}
