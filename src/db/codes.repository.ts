import { db } from "./db";
import { limaTodayISO } from "../services/access.service";

// ─────────────────────────────────────────────────────────────
// CÓDIGOS — ver db.ts para el esquema. Todo lo relacionado a marcar
// cuentas, guardar códigos entrantes y llevar el límite de pedidos
// por cliente vive acá.
// ─────────────────────────────────────────────────────────────

export const CODE_MAX_AGE_HOURS = 24;

export function setAccountCodesEnabled(accountId: number, enabled: boolean): void {
  db.prepare(`UPDATE access_accounts SET codes_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, accountId);
}

/** Cuál página externa consultar para esta cuenta — null = sin configurar
 *  (ver services/codes-lookup.service.ts para los ids válidos). */
export function setAccountCodeSource(accountId: number, sourceId: string | null): void {
  db.prepare(`UPDATE access_accounts SET code_source = ? WHERE id = ?`).run(sourceId, accountId);
}

export function getAccountCodeSource(accountId: number): string | null {
  const row = db.prepare(`SELECT code_source FROM access_accounts WHERE id = ?`).get(accountId) as { code_source: string | null } | undefined;
  return row?.code_source ?? null;
}

/** Clave secreta de 2FA (TOTP) de esta cuenta — null = no usa TOTP (ver
 *  utils/totp.util.ts). Independiente de code_source: una cuenta usa UNO
 *  de los dos mecanismos, nunca ambos a la vez. */
export function setAccountTotpSecret(accountId: number, secret: string | null): void {
  db.prepare(`UPDATE access_accounts SET totp_secret = ? WHERE id = ?`).run(secret, accountId);
}

export function getAccountTotpSecret(accountId: number): string | null {
  const row = db.prepare(`SELECT totp_secret FROM access_accounts WHERE id = ?`).get(accountId) as { totp_secret: string | null } | undefined;
  return row?.totp_secret ?? null;
}

/** Todas las cuentas con "código" habilitado — para el panel admin. */
export type CodesEnabledAccount = {
  id:         number;
  platform:   string;
  email:      string;
  expiresAt:  string | null;
  codeSource: string | null;
  totpSecret: string | null;
};

export function listCodesEnabledAccounts(): CodesEnabledAccount[] {
  return db.prepare(`
    SELECT id, platform, email, expires_at AS expiresAt, code_source AS codeSource, totp_secret AS totpSecret
    FROM access_accounts
    WHERE codes_enabled = 1
    ORDER BY platform ASC
  `).all() as CodesEnabledAccount[];
}

/** Busca la cuenta (con código habilitado) cuyo correo aparece dentro del
 *  texto dado — así se atribuye un código entrante sin depender de que el
 *  remitente lo diga explícito. Case-insensitive. */
export function findCodesEnabledAccountByEmailInText(text: string): CodesEnabledAccount | null {
  const lower = text.toLowerCase();
  const accounts = listCodesEnabledAccounts();
  return accounts.find(a => a.email && lower.includes(a.email.toLowerCase())) ?? null;
}

export type ClientCodesAccount = {
  accountId:   number;
  platform:    string;
  email:       string;
  profileName: string;
  expiresAt:   string | null;
  totpSecret:  string | null;
};

/**
 * Cuentas de ESTE celular que tienen "🔑 Código" habilitado y siguen
 * activas (no vencidas) — para "Códigos" en liordark.com. Comparación
 * por últimos 9 dígitos, mismo criterio que el resto del sitio (ver
 * access.repository.ts / phone.util.ts).
 */
export function listClientCodesAccounts(clientPhone: string): ClientCodesAccount[] {
  const digits = clientPhone.replace(/\D/g, "");
  if (!digits) return [];

  return db.prepare(`
    SELECT a.id AS accountId, a.platform AS platform, a.email AS email,
           p.profile_name AS profileName, a.expires_at AS expiresAt, a.totp_secret AS totpSecret
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE a.codes_enabled = 1
      AND substr(p.client_phone, -9) = substr(?, -9)
      AND a.expires_at IS NOT NULL AND a.expires_at >= ?
    ORDER BY a.platform ASC
  `).all(digits, limaTodayISO()) as ClientCodesAccount[];
}

/** true si esta cuenta (con código habilitado) de verdad le pertenece a
 *  este celular ahora mismo — para no dejar pedir código de una cuenta
 *  ajena solo adivinando el accountId. */
export function clientOwnsCodesAccount(clientPhone: string, accountId: number): boolean {
  return listClientCodesAccounts(clientPhone).some(a => a.accountId === accountId);
}

export function saveIncomingCode(params: {
  accountId: number;
  code:      string;
  snippet:   string;
  source:    "gmail" | "external";
}): void {
  db.prepare(`
    INSERT INTO account_codes (account_id, code, snippet, source)
    VALUES (?, ?, ?, ?)
  `).run(params.accountId, params.code, params.snippet, params.source);
}

export type AccountCode = {
  id:         number;
  code:       string;
  source:     string;
  receivedAt: string;
  // Ej. "Recibido: 2026-11-02 23:04:51" — la hora que da el proveedor,
  // cuando la da (receivedAt es cuándo lo consultamos nosotros).
  snippet:    string;
};

/** El código más reciente para una cuenta, sin importar antigüedad (la
 *  limpieza de 24h ya se encarga de que nunca haya nada viejo). */
export function getLatestCodeForAccount(accountId: number): AccountCode | null {
  const row = db.prepare(`
    SELECT id, code, source, received_at AS receivedAt, snippet
    FROM account_codes
    WHERE account_id = ?
    ORDER BY received_at DESC
    LIMIT 1
  `).get(accountId) as AccountCode | undefined;
  return row ?? null;
}

/** Borra códigos con más de CODE_MAX_AGE_HOURS — corrida periódica. */
export function cleanupOldCodes(): number {
  const result = db.prepare(`
    DELETE FROM account_codes WHERE received_at <= datetime('now', '-${CODE_MAX_AGE_HOURS} hours')
  `).run();
  return result.changes;
}

