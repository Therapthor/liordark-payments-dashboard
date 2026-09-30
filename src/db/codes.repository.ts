import { db } from "./db";
import { limaTodayISO } from "../services/access.service";

// ─────────────────────────────────────────────────────────────
// CÓDIGOS — ver db.ts para el esquema. Todo lo relacionado a marcar
// cuentas, guardar códigos entrantes y llevar el límite de pedidos
// por cliente vive acá.
// ─────────────────────────────────────────────────────────────

export const MAX_CODE_REQUESTS_PER_ACCOUNT = 2;
export const CODE_MAX_AGE_HOURS = 24;

export function setAccountCodesEnabled(accountId: number, enabled: boolean): void {
  db.prepare(`UPDATE access_accounts SET codes_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, accountId);
}

/** Todas las cuentas activas con "código" habilitado — para el poller de Gmail
 *  (saber a qué email atribuir un código que llega) y para el panel admin. */
export type CodesEnabledAccount = {
  id:        number;
  platform:  string;
  email:     string;
  expiresAt: string | null;
};

export function listCodesEnabledAccounts(): CodesEnabledAccount[] {
  return db.prepare(`
    SELECT id, platform, email, expires_at AS expiresAt
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
           p.profile_name AS profileName, a.expires_at AS expiresAt
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
};

/** El código más reciente para una cuenta, sin importar antigüedad (la
 *  limpieza de 24h ya se encarga de que nunca haya nada viejo). */
export function getLatestCodeForAccount(accountId: number): AccountCode | null {
  const row = db.prepare(`
    SELECT id, code, source, received_at AS receivedAt
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

// ── LÍMITE DE PEDIDOS POR CLIENTE/CUENTA — 2 para siempre, sin reset
// automático (a pedido); solo el admin lo resetea a mano desde el panel. ──

export type CodeRequestState = {
  requestCount:    number;
  lastRequestedAt: string | null;
};

export function getCodeRequestState(clientPhone: string, accountId: number): CodeRequestState {
  const row = db.prepare(`
    SELECT request_count AS requestCount, last_requested_at AS lastRequestedAt
    FROM code_requests WHERE client_phone = ? AND account_id = ?
  `).get(clientPhone, accountId) as CodeRequestState | undefined;
  return row ?? { requestCount: 0, lastRequestedAt: null };
}

/** Suma un pedido — falla (devuelve false) si ya llegó al límite, sin sumar. */
export function registerCodeRequest(clientPhone: string, accountId: number): boolean {
  const current = getCodeRequestState(clientPhone, accountId);
  if (current.requestCount >= MAX_CODE_REQUESTS_PER_ACCOUNT) return false;

  db.prepare(`
    INSERT INTO code_requests (client_phone, account_id, request_count, last_requested_at)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(client_phone, account_id) DO UPDATE SET
      request_count = request_count + 1,
      last_requested_at = datetime('now')
  `).run(clientPhone, accountId);
  return true;
}

/** Resetea manualmente el contador de un cliente para una cuenta — botón admin. */
export function resetCodeRequests(clientPhone: string, accountId: number): void {
  db.prepare(`DELETE FROM code_requests WHERE client_phone = ? AND account_id = ?`).run(clientPhone, accountId);
}
