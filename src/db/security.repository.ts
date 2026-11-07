import crypto from "crypto";
import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// SEGURIDAD
//  · blocked_phones: números bloqueados (no pueden entrar, registrarse ni
//    usar el chat), por baneo del admin o automático (enlaces/código en el
//    chat). Se guarda por los últimos 9 dígitos.
//  · blocked_ips: IP desde donde se atacó — no puede crear cuentas nuevas
//    por unos días (no se bloquea el ingreso de cuentas ya existentes,
//    porque en Perú muchos celulares comparten IP).
//  · admin_sessions: sesiones del panel (para ver dispositivos y cerrarlas).
//  · admin_settings: contraseña del panel (hash) cuando se cambia desde acá.
// ─────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS blocked_phones (
    phone9     TEXT PRIMARY KEY,
    phone      TEXT NOT NULL,
    reason     TEXT NOT NULL DEFAULT '',
    evidence   TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL DEFAULT 'auto',
    ip         TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS blocked_ips (
    ip         TEXT PRIMARY KEY,
    reason     TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash   TEXT PRIMARY KEY,
    ip           TEXT NOT NULL DEFAULT '',
    user_agent   TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT NOT NULL,
    revoked_at   TEXT
  );
  CREATE TABLE IF NOT EXISTS admin_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS registration_log (
    ip         TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_registration_log_ip ON registration_log(ip, created_at);
`);

const last9 = (phone: string) => String(phone ?? "").replace(/\D/g, "").slice(-9);

// ── Números bloqueados ──

export type BlockedPhone = { phone: string; reason: string; evidence: string; source: string; ip: string; createdAt: string };

export function isPhoneBlocked(phone: string): boolean {
  const d = last9(phone);
  if (d.length < 9) return false;
  return !!db.prepare(`SELECT 1 FROM blocked_phones WHERE phone9 = ?`).get(d);
}

export function blockPhone(p: { phone: string; reason: string; evidence?: string; source: "auto" | "admin"; ip?: string }): boolean {
  const d = last9(p.phone);
  if (d.length < 9) return false;
  const r = db.prepare(`
    INSERT OR IGNORE INTO blocked_phones (phone9, phone, reason, evidence, source, ip) VALUES (?, ?, ?, ?, ?, ?)
  `).run(d, p.phone.replace(/\D/g, ""), p.reason, (p.evidence ?? "").slice(0, 2000), p.source, p.ip ?? "");
  return r.changes === 1;
}

export function unblockPhone(phone: string): void {
  db.prepare(`DELETE FROM blocked_phones WHERE phone9 = ?`).run(last9(phone));
}

export function listBlockedPhones(): BlockedPhone[] {
  return (db.prepare(`SELECT * FROM blocked_phones ORDER BY created_at DESC`).all() as any[]).map(r => ({
    phone: r.phone, reason: r.reason, evidence: r.evidence, source: r.source, ip: r.ip, createdAt: r.created_at,
  }));
}

// ── IPs que atacaron: no crean cuentas nuevas por 7 días ──

export function blockIp(ip: string, reason: string, days = 7): void {
  if (!ip) return;
  db.prepare(`
    INSERT INTO blocked_ips (ip, reason, expires_at) VALUES (?, ?, datetime('now', ?))
    ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, expires_at = excluded.expires_at
  `).run(ip, reason, `+${days} days`);
}

export function isIpBlocked(ip: string): boolean {
  if (!ip) return false;
  return !!db.prepare(`SELECT 1 FROM blocked_ips WHERE ip = ? AND expires_at > datetime('now')`).get(ip);
}

export function unblockIp(ip: string): void {
  db.prepare(`DELETE FROM blocked_ips WHERE ip = ?`).run(ip);
}

// ── Límite de cuentas nuevas por IP (anti-creación masiva de números) ──

export function countRegistrationsFromIp(ip: string, hours = 24): number {
  if (!ip) return 0;
  return (db.prepare(`SELECT COUNT(*) AS n FROM registration_log WHERE ip = ? AND created_at >= datetime('now', ?)`)
    .get(ip, `-${hours} hours`) as { n: number }).n;
}

export function logRegistration(ip: string): void {
  if (!ip) return;
  db.prepare(`INSERT INTO registration_log (ip) VALUES (?)`).run(ip);
  db.prepare(`DELETE FROM registration_log WHERE created_at < datetime('now', '-3 days')`).run();
}

// ── Sesiones del panel ──

export type AdminSession = { id: string; ip: string; userAgent: string; createdAt: string; lastSeenAt: string; expiresAt: string };

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createAdminSession(ip: string, userAgent: string, ttlDays: number): { token: string; expires: Date } {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + ttlDays * 86_400_000);
  db.prepare(`INSERT INTO admin_sessions (token_hash, ip, user_agent, expires_at) VALUES (?, ?, ?, ?)`)
    .run(hashToken(token), ip, userAgent.slice(0, 300), expires.toISOString().slice(0, 19).replace("T", " "));
  return { token, expires };
}

const lastTouch = new Map<string, number>();

/** true si la sesión existe, no venció y no fue cerrada. Actualiza "última vez" (cada 1 min). */
export function validateAdminSession(token: string | undefined, ip?: string): boolean {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
  const h = hashToken(token);
  const row = db.prepare(`
    SELECT 1 FROM admin_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now')
  `).get(h);
  if (!row) return false;
  const now = Date.now();
  if ((lastTouch.get(h) ?? 0) < now - 60_000) {
    lastTouch.set(h, now);
    db.prepare(`UPDATE admin_sessions SET last_seen_at = datetime('now')${ip ? ", ip = ?" : ""} WHERE token_hash = ?`)
      .run(...(ip ? [ip, h] : [h]));
  }
  return true;
}

export function listAdminSessions(): AdminSession[] {
  return (db.prepare(`
    SELECT * FROM admin_sessions WHERE revoked_at IS NULL AND expires_at > datetime('now') ORDER BY last_seen_at DESC
  `).all() as any[]).map(r => ({
    id: String(r.token_hash).slice(0, 16), ip: r.ip, userAgent: r.user_agent,
    createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at,
  }));
}

export function revokeAdminSessionById(shortId: string): void {
  if (!/^[a-f0-9]{16}$/.test(shortId)) return;
  db.prepare(`UPDATE admin_sessions SET revoked_at = datetime('now') WHERE substr(token_hash, 1, 16) = ? AND revoked_at IS NULL`).run(shortId);
}

export function revokeAdminSession(token: string | undefined): void {
  if (!token) return;
  db.prepare(`UPDATE admin_sessions SET revoked_at = datetime('now') WHERE token_hash = ?`).run(hashToken(token));
}

/** Cierra todas las sesiones menos (opcionalmente) la actual. */
export function revokeAllAdminSessions(exceptToken?: string): number {
  const keep = exceptToken ? hashToken(exceptToken) : "";
  return db.prepare(`UPDATE admin_sessions SET revoked_at = datetime('now') WHERE revoked_at IS NULL AND token_hash != ?`).run(keep).changes;
}

export function currentSessionShortId(token: string | undefined): string | null {
  return token ? hashToken(token).slice(0, 16) : null;
}

// ── Ajustes del panel ──

export function getAdminSetting(key: string): string | null {
  const r = db.prepare(`SELECT value FROM admin_settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return r ? r.value : null;
}

export function setAdminSetting(key: string, value: string): void {
  db.prepare(`INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}
