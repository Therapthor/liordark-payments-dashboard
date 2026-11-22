import { db } from "./db";
import { limaTodayISO } from "../services/access.service";

// ─────────────────────────────────────────────────────────────
// CÓDIGOS — ver db.ts para el esquema. Todo lo relacionado a marcar
// cuentas, guardar códigos entrantes y llevar el límite de pedidos
// por cliente vive acá.
// ─────────────────────────────────────────────────────────────

export const CODE_MAX_AGE_HOURS = 24;

// «🔑 Código» compartido: las cuentas con el mismo correo en la misma
// plataforma (ej. ChatGPT, hasta 10 accesos por correo) usan la misma
// configuración — se guarda en todas a la vez.
const SAME_EMAIL_GROUP = `
  SELECT b.id FROM access_accounts a
  JOIN access_accounts b
    ON b.id = a.id
    OR (TRIM(a.email) <> ''
        AND UPPER(TRIM(b.platform)) = UPPER(TRIM(a.platform))
        AND LOWER(TRIM(b.email)) = LOWER(TRIM(a.email)))
  WHERE a.id = ?`;

export function setAccountCodesEnabled(accountId: number, enabled: boolean): void {
  db.prepare(`UPDATE access_accounts SET codes_enabled = ? WHERE id IN (${SAME_EMAIL_GROUP})`).run(enabled ? 1 : 0, accountId);
}

/** «Mayorista ve todos los códigos» (sin filtros de inicio de sesión). */
export function setAccountCodesUnfiltered(accountId: number, unfiltered: boolean): void {
  db.prepare(`UPDATE access_accounts SET codes_unfiltered = ? WHERE id = ?`).run(unfiltered ? 1 : 0, accountId);
}

export function isAccountCodesUnfiltered(accountId: number): boolean {
  const row = db.prepare(`SELECT codes_unfiltered FROM access_accounts WHERE id = ?`).get(accountId) as { codes_unfiltered: number } | undefined;
  return row?.codes_unfiltered === 1;
}

/** Cuál página externa consultar para esta cuenta — null = sin configurar
 *  (ver services/codes-lookup.service.ts para los ids válidos). */
export function setAccountCodeSource(accountId: number, sourceId: string | null): void {
  db.prepare(`UPDATE access_accounts SET code_source = ? WHERE id IN (${SAME_EMAIL_GROUP})`).run(sourceId, accountId);
}

/** Fuentes que ve SOLO el admin (mismo listado que ADMIN_ONLY_SOURCES de
 *  codes-lookup.service.ts): nunca se le ofrecen al cliente ni al mayorista. */
export const ADMIN_ONLY_CODE_SOURCES = ["juanpa_hbo"];
const ADMIN_ONLY_SQL = ADMIN_ONLY_CODE_SOURCES.map(s => `'${s}'`).join(", ");

/** ¿Esta cuenta entrega códigos? (código habilitado + fuente configurada). */
export function getAccountCodesConfig(accountId: number): { enabled: boolean; sourceId: string | null } {
  const row = db.prepare(`SELECT codes_enabled, code_source FROM access_accounts WHERE id = ?`).get(accountId) as
    { codes_enabled: number; code_source: string | null } | undefined;
  // Fuentes solo-admin (HBO por Juanpa): para el mayorista no entrega códigos.
  const adminOnly = !!row?.code_source && ADMIN_ONLY_CODE_SOURCES.includes(row.code_source);
  return { enabled: !!row && row.codes_enabled === 1 && !!row.code_source && !adminOnly, sourceId: row?.code_source ?? null };
}

export function getAccountCodeSource(accountId: number): string | null {
  const row = db.prepare(`SELECT code_source FROM access_accounts WHERE id = ?`).get(accountId) as { code_source: string | null } | undefined;
  return row?.code_source ?? null;
}

/** Clave secreta de 2FA (TOTP) de esta cuenta — null = no usa TOTP (ver
 *  utils/totp.util.ts). Independiente de code_source: una cuenta usa UNO
 *  de los dos mecanismos, nunca ambos a la vez. */
export function setAccountTotpSecret(accountId: number, secret: string | null): void {
  db.prepare(`UPDATE access_accounts SET totp_secret = ? WHERE id IN (${SAME_EMAIL_GROUP})`).run(secret, accountId);
}

/** Link privado de la bandeja del proveedor ('' = sin link). */
export function setAccountCodeInboxUrl(accountId: number, url: string | null): void {
  db.prepare(`UPDATE access_accounts SET code_inbox_url = ? WHERE id IN (${SAME_EMAIL_GROUP})`).run(url ?? "", accountId);
}

/** Cuentas del mismo correo y plataforma que comparten el «🔑 Código» (sin contar esta). */
export function countCodeSiblings(accountId: number): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM (${SAME_EMAIL_GROUP})`).get(accountId) as { n: number };
  return Math.max(0, row.n - 1);
}

/** Copia el «🔑 Código» de una cuenta del mismo correo a esta, si esta no
 *  tiene uno (alta nueva). force = aunque ya tenga uno (cambió de correo). */
export function inheritCodeConfigFromSiblings(accountId: number, force = false): boolean {
  const donor = db.prepare(`
    SELECT codes_enabled, code_source, totp_secret, code_inbox_url FROM access_accounts
    WHERE id IN (${SAME_EMAIL_GROUP}) AND id <> ? AND codes_enabled = 1 AND code_source IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(accountId, accountId) as { codes_enabled: number; code_source: string; totp_secret: string | null; code_inbox_url: string | null } | undefined;
  if (!donor) return false;
  const r = db.prepare(`
    UPDATE access_accounts SET codes_enabled = 1, code_source = ?, totp_secret = ?, code_inbox_url = ?
    WHERE id = ? AND (? = 1 OR codes_enabled = 0 OR code_source IS NULL)
  `).run(donor.code_source, donor.totp_secret, donor.code_inbox_url ?? "", accountId, force ? 1 : 0);
  return r.changes > 0;
}

/** Una vez al arrancar: las cuentas sin «🔑 Código» toman el de otra cuenta
 *  con el mismo correo y plataforma. Devuelve cuántas se completaron. */
export function syncSharedCodeConfig(): number {
  const ids = db.prepare(`
    SELECT a.id FROM access_accounts a
    WHERE (a.codes_enabled = 0 OR a.code_source IS NULL) AND TRIM(a.email) <> ''
      AND EXISTS (
        SELECT 1 FROM access_accounts b
        WHERE b.id <> a.id AND b.codes_enabled = 1 AND b.code_source IS NOT NULL
          AND UPPER(TRIM(b.platform)) = UPPER(TRIM(a.platform))
          AND LOWER(TRIM(b.email)) = LOWER(TRIM(a.email)))
  `).all() as { id: number }[];
  let n = 0;
  for (const { id } of ids) if (inheritCodeConfigFromSiblings(id)) n++;
  return n;
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
           p.profile_name AS profileName, COALESCE(p.expires_override, a.expires_at) AS expiresAt, a.totp_secret AS totpSecret
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE a.codes_enabled = 1 AND COALESCE(a.code_source, '') NOT IN (${ADMIN_ONLY_SQL})
      AND substr(p.client_phone, -9) = substr(?, -9)
      AND COALESCE(p.expires_override, a.expires_at) IS NOT NULL AND COALESCE(p.expires_override, a.expires_at) >= ?
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

/** El último código ya entregado para este correo, en cualquiera de las
 *  cuentas que lo comparten — para no volver a entregarlo como "nuevo"
 *  (ver skipsRepeatedCodes en codes-lookup.service.ts). */
export function getLastSeenCodeForEmail(email: string): { value: string; providerReceivedAt?: string } | null {
  const row = db.prepare(`
    SELECT c.code AS code, c.snippet AS snippet
    FROM account_codes c
    JOIN access_accounts a ON a.id = c.account_id
    WHERE lower(a.email) = lower(?)
    ORDER BY c.received_at DESC, c.id DESC
    LIMIT 1
  `).get(email.trim()) as { code: string; snippet: string } | undefined;
  if (!row) return null;
  const received = row.snippet.replace(/^Recibido:\s*/, "").trim();
  return received ? { value: row.code, providerReceivedAt: received } : { value: row.code };
}

/** Borra códigos con más de CODE_MAX_AGE_HOURS — corrida periódica. */
export function cleanupOldCodes(): number {
  const result = db.prepare(`
    DELETE FROM account_codes WHERE received_at <= datetime('now', '-${CODE_MAX_AGE_HOURS} hours')
  `).run();
  return result.changes;
}

