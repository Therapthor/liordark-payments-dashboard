import { db } from "./db";
import { normalizePeruPhone } from "../utils/phone.util";
import { checkLockout, nextLockoutState, type LockoutCheck } from "../services/login-lockout.service";
import "./wholesaler-membership.repository"; // agrega membership_until (y el mes de regalo) antes de usar la tabla

// ─────────────────────────────────────────────────────────────
// MAYORISTAS — ver tables.sql (wholesalers). La cuenta la crea el admin o
// el mismo mayorista desde mayorista.liordark.com (/register); sin
// membresía vigente solo puede pagarla (ver wholesaler-membership.repository.ts).
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
  membershipUntil:   string | null; // UTC «YYYY-MM-DD HH:MM:SS»; null = nunca pagó
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
    membershipUntil:   row.membership_until ?? null,
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
  // Al reactivar se reinicia el contador de 1 mes — si no, la regla de
  // inactividad la volvía a deshabilitar en menos de una hora.
  db.prepare(`
    UPDATE wholesalers SET status = ?, updated_at = datetime('now'),
      last_activity_at = CASE WHEN ? = 'active' THEN datetime('now') ELSE last_activity_at END
    WHERE id = ?
  `).run(status, status, id);
}

// Sesiones de mayorista: un token emitido antes de esta marca ya no vale.
// Se mueve al cambiar la contraseña, así sale cualquier intruso (auditoría M6).
try { db.exec(`ALTER TABLE wholesalers ADD COLUMN sessions_valid_after INTEGER NOT NULL DEFAULT 0`); } catch { /* ya existe */ }

export function wholesalerSessionsValidAfter(id: number): number {
  const r = db.prepare(`SELECT sessions_valid_after AS v FROM wholesalers WHERE id = ?`).get(id) as { v: number } | undefined;
  return r?.v ?? 0;
}

export function setWholesalerPassword(id: number, passwordHash: string, passwordPlain: string): Wholesaler | null {
  // Con la contraseña nueva entra ya: sin el bloqueo de los intentos viejos.
  db.prepare(`
    UPDATE wholesalers SET password_hash = ?, password_plain = ?, sessions_valid_after = ?,
      failed_login_count = 0, locked_until = NULL WHERE id = ?
  `).run(passwordHash, passwordPlain, Date.now(), id);
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

/** Admin: quita el bloqueo por intentos fallidos (y reinicia el contador). */
export function clearWholesalerLockout(id: number): void {
  db.prepare(`UPDATE wholesalers SET failed_login_count = 0, locked_until = NULL WHERE id = ?`).run(id);
}

export type LockedWholesaler = {
  id: number; phone: string; displayName: string;
  failedLoginCount: number; lockedUntil: string; lockedNow: boolean;
};

/**
 * Mayoristas con problemas para entrar: bloqueados ahora, o que se
 * bloquearon en las últimas 24 h y siguen con intentos fallidos (el próximo
 * fallo los vuelve a bloquear). Desde el 3.er fallo cada intento bloquea.
 */
export function listLockedWholesalers(): LockedWholesaler[] {
  const now = Date.now();
  return (db.prepare(`
    SELECT id, phone, display_name, failed_login_count, locked_until FROM wholesalers
    WHERE failed_login_count >= 3 AND locked_until IS NOT NULL
  `).all() as any[])
    .filter(r => new Date(r.locked_until).getTime() > now - 24 * 3600_000)
    .map(r => ({
      id: r.id, phone: r.phone, displayName: r.display_name,
      failedLoginCount: r.failed_login_count, lockedUntil: r.locked_until,
      lockedNow: new Date(r.locked_until).getTime() > now,
    }));
}

