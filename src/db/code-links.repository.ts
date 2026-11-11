import crypto from "crypto";
import { db } from "./db";

// Links temporales del visor de códigos (liordark.com/codigo/<token>).

export type CodeLink = {
  token: string; accountId: number; email: string; sourceId: string; clientPhone: string;
  createdBy: "admin" | "bot" | "client" | "wholesaler"; createdAt: string; expiresAt: string; openedAt: string | null; closedAt: string | null;
  profileId: number | null; // solo las del panel mayorista (límite por perfil)
};

const TOKEN_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function toLink(r: any): CodeLink {
  return {
    token: r.token, accountId: r.account_id, email: r.email, sourceId: r.source_id, clientPhone: r.client_phone,
    createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, openedAt: r.opened_at, closedAt: r.closed_at,
    profileId: r.profile_id ?? null,
  };
}

/** SQLite guarda datetime('now') en UTC sin zona — a Date. */
export function sqliteDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z"));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function createCodeLink(p: {
  accountId: number; email: string; sourceId: string; clientPhone: string; createdBy: CodeLink["createdBy"]; minutes: number;
  profileId?: number | null;
}): CodeLink {
  let token = "";
  for (let i = 0; i < 10; i++) token += TOKEN_CHARS[crypto.randomInt(TOKEN_CHARS.length)];
  db.prepare(`
    INSERT INTO code_links (token, account_id, email, source_id, client_phone, created_by, expires_at, profile_id)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?), ?)
  `).run(token, p.accountId, p.email, p.sourceId, p.clientPhone.replace(/\D/g, ""), p.createdBy, `+${Math.round(p.minutes)} minutes`, p.profileId ?? null);
  return findCodeLink(token) as CodeLink;
}

export function findCodeLink(token: string): CodeLink | null {
  const r = db.prepare(`SELECT * FROM code_links WHERE token = ?`).get(token);
  return r ? toLink(r) : null;
}

export function markCodeLinkOpened(token: string): void {
  db.prepare(`UPDATE code_links SET opened_at = COALESCE(opened_at, datetime('now')) WHERE token = ?`).run(token);
}

export function closeCodeLink(token: string): void {
  db.prepare(`UPDATE code_links SET closed_at = COALESCE(closed_at, datetime('now')) WHERE token = ?`).run(token);
}

export type CodeLinkState = "active" | "closed" | "expired";

export function codeLinkState(link: CodeLink): CodeLinkState {
  if (link.closedAt) return "closed";
  const exp = sqliteDate(link.expiresAt);
  return exp && exp.getTime() <= Date.now() ? "expired" : "active";
}

/** Links que el bot de soporte generó hoy (día de Lima) para este celular. */
export function countBotLinksToday(clientPhone: string): number {
  const digits = clientPhone.replace(/\D/g, "").slice(-9);
  // Medianoche de Lima (UTC-5) en UTC.
  const now = new Date();
  const lima = new Date(now.getTime() - 5 * 3600_000);
  const start = new Date(Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth(), lima.getUTCDate(), 5, 0, 0));
  const startSql = start.toISOString().slice(0, 19).replace("T", " ");
  const r = db.prepare(`
    SELECT COUNT(*) AS n FROM code_links
    WHERE created_by = 'bot' AND substr(client_phone, -9) = ? AND created_at >= ?
  `).get(digits, startSql) as { n: number };
  return r.n;
}

function limaMidnightUtcSql(): string {
  const now = new Date();
  const lima = new Date(now.getTime() - 5 * 3600_000);
  const start = new Date(Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth(), lima.getUTCDate(), 5, 0, 0));
  return start.toISOString().slice(0, 19).replace("T", " ");
}

/** Consultas que el cliente abrió hoy (día de Lima) desde «Códigos» para esta cuenta. */
export function countClientLinksToday(accountId: number, clientPhone: string): number {
  const digits = clientPhone.replace(/\D/g, "").slice(-9);
  const r = db.prepare(`
    SELECT COUNT(*) AS n FROM code_links
    WHERE created_by = 'client' AND account_id = ? AND substr(client_phone, -9) = ? AND created_at >= ?
  `).get(accountId, digits, limaMidnightUtcSql()) as { n: number };
  return r.n;
}

/** La consulta de «Códigos» que sigue abierta (no vencida ni cerrada), si hay. */
export function findOpenClientLink(accountId: number, clientPhone: string): CodeLink | null {
  const digits = clientPhone.replace(/\D/g, "").slice(-9);
  const r = db.prepare(`
    SELECT * FROM code_links
    WHERE created_by = 'client' AND account_id = ? AND substr(client_phone, -9) = ?
      AND closed_at IS NULL AND expires_at > datetime('now')
    ORDER BY created_at DESC LIMIT 1
  `).get(accountId, digits);
  return r ? toLink(r) : null;
}

/** Consultas de «Códigos» que el mayorista abrió hoy (día de Lima) para este perfil. */
export function countWholesalerLinksToday(profileId: number): number {
  const r = db.prepare(`
    SELECT COUNT(*) AS n FROM code_links
    WHERE created_by = 'wholesaler' AND profile_id = ? AND created_at >= ? AND quota_reset = 0
  `).get(profileId, limaMidnightUtcSql()) as { n: number };
  return r.n;
}

/** Soporte restablece el límite del día de este perfil: las consultas de
 *  hoy dejan de contar (siguen sirviendo las que estén abiertas). */
export function resetWholesalerCodeQuota(profileId: number): number {
  return db.prepare(`
    UPDATE code_links SET quota_reset = 1
    WHERE created_by = 'wholesaler' AND profile_id = ? AND created_at >= ?
  `).run(profileId, limaMidnightUtcSql()).changes;
}

/** La consulta del mayorista que sigue abierta para este perfil, si hay. */
export function findOpenWholesalerLink(profileId: number): CodeLink | null {
  const r = db.prepare(`
    SELECT * FROM code_links
    WHERE created_by = 'wholesaler' AND profile_id = ? AND closed_at IS NULL AND expires_at > datetime('now')
    ORDER BY created_at DESC LIMIT 1
  `).get(profileId);
  return r ? toLink(r) : null;
}

/** Limpieza: links de más de 7 días. */
export function cleanOldCodeLinks(): number {
  return db.prepare(`DELETE FROM code_links WHERE created_at < datetime('now', '-7 days')`).run().changes;
}
