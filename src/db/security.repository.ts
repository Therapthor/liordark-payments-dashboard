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
  CREATE TABLE IF NOT EXISTS security_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    phone      TEXT NOT NULL DEFAULT '',
    ip         TEXT NOT NULL DEFAULT '',
    reason     TEXT NOT NULL DEFAULT '',
    evidence   TEXT NOT NULL DEFAULT '',
    action     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS login_ip_failures (
    ip           TEXT PRIMARY KEY,
    count        INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- IPs bloqueadas para siempre SOLO en el login del panel (2 contraseñas
  -- mal). No afecta la tienda: en Perú muchos celulares comparten IP.
  CREATE TABLE IF NOT EXISTS panel_blocked_ips (
    ip         TEXT PRIMARY KEY,
    reason     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Llaves de acceso del panel (Face ID / huella). Solo la clave pública.
  CREATE TABLE IF NOT EXISTS admin_passkeys (
    id           TEXT PRIMARY KEY,
    public_key   TEXT NOT NULL,
    counter      INTEGER NOT NULL DEFAULT 0,
    transports   TEXT NOT NULL DEFAULT '',
    name         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );
`);

// ── IPs bloqueadas en el login del panel (permanente) ──

export function isPanelIpBlocked(ip: string): boolean {
  if (!ip) return false;
  return !!db.prepare(`SELECT 1 FROM panel_blocked_ips WHERE ip = ?`).get(ip);
}

export function blockPanelIp(ip: string, reason: string): void {
  if (!ip) return;
  db.prepare(`INSERT OR IGNORE INTO panel_blocked_ips (ip, reason) VALUES (?, ?)`).run(ip, reason);
}

export function unblockPanelIp(ip: string): void {
  db.prepare(`DELETE FROM panel_blocked_ips WHERE ip = ?`).run(ip);
}

export function listPanelBlockedIps(): { ip: string; reason: string; createdAt: string }[] {
  return (db.prepare(`SELECT * FROM panel_blocked_ips ORDER BY created_at DESC LIMIT 500`).all() as any[])
    .map(r => ({ ip: r.ip, reason: r.reason, createdAt: r.created_at }));
}

export function countPanelBlockedIps(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM panel_blocked_ips`).get() as { n: number }).n;
}

// ── Llaves de acceso (passkeys) del panel ──

export type AdminPasskey = {
  id: string; publicKey: string; counter: number; transports: string[];
  name: string; createdAt: string; lastUsedAt: string | null;
};

function toPasskey(r: any): AdminPasskey {
  return {
    id: r.id, publicKey: r.public_key, counter: r.counter,
    transports: String(r.transports || "").split(",").filter(Boolean),
    name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null,
  };
}

export function listPasskeys(): AdminPasskey[] {
  return (db.prepare(`SELECT * FROM admin_passkeys ORDER BY created_at`).all() as any[]).map(toPasskey);
}

export function getPasskey(id: string): AdminPasskey | null {
  const r = db.prepare(`SELECT * FROM admin_passkeys WHERE id = ?`).get(id);
  return r ? toPasskey(r) : null;
}

export function addPasskey(p: { id: string; publicKey: string; counter: number; transports: string[]; name: string }): void {
  db.prepare(`INSERT INTO admin_passkeys (id, public_key, counter, transports, name) VALUES (?, ?, ?, ?, ?)`)
    .run(p.id, p.publicKey, p.counter, p.transports.join(","), p.name);
}

export function touchPasskey(id: string, counter: number): void {
  db.prepare(`UPDATE admin_passkeys SET counter = ?, last_used_at = datetime('now') WHERE id = ?`).run(counter, id);
}

export function deletePasskey(id: string): boolean {
  return db.prepare(`DELETE FROM admin_passkeys WHERE id = ?`).run(id).changes === 1;
}

// Sesiones de clientes: un token emitido antes de esta marca ya no vale
// (se usa al resetear el PIN o al detectar un ataque).
try { db.exec(`ALTER TABLE customers ADD COLUMN sessions_valid_after INTEGER NOT NULL DEFAULT 0`); } catch { /* ya existe */ }

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

// ── Registro de ataques (lo que se detectó y qué se hizo) ──

export type SecurityEvent = { id: number; phone: string; ip: string; reason: string; evidence: string; action: string; createdAt: string };

export function logSecurityEvent(e: { phone: string; ip: string; reason: string; evidence: string; action: string }): void {
  db.prepare(`INSERT INTO security_events (phone, ip, reason, evidence, action) VALUES (?, ?, ?, ?, ?)`)
    .run(e.phone, e.ip, e.reason, e.evidence.slice(0, 2000), e.action);
}

export function listSecurityEvents(limit = 100): SecurityEvent[] {
  return (db.prepare(`SELECT * FROM security_events ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map(r => ({
    id: r.id, phone: r.phone, ip: r.ip, reason: r.reason, evidence: r.evidence, action: r.action, createdAt: r.created_at,
  }));
}

export function listBlockedIps(): { ip: string; reason: string; expiresAt: string; createdAt: string }[] {
  return (db.prepare(`SELECT * FROM blocked_ips WHERE expires_at > datetime('now') ORDER BY created_at DESC`).all() as any[])
    .map(r => ({ ip: r.ip, reason: r.reason, expiresAt: r.expires_at, createdAt: r.created_at }));
}

// ── Sesiones de clientes ──

export function revokeCustomerSessions(customerId: number): void {
  db.prepare(`UPDATE customers SET sessions_valid_after = ? WHERE id = ?`).run(Date.now(), customerId);
}

export function customerSessionsValidAfter(customerId: number): number {
  const r = db.prepare(`SELECT sessions_valid_after AS v FROM customers WHERE id = ?`).get(customerId) as { v: number } | undefined;
  return r?.v ?? 0;
}

// ── Intentos fallidos de inicio de sesión por IP (misma escalera que por número) ──

export function ipLoginFailures(ip: string): { count: number; lockedUntil: string | null } {
  const r = db.prepare(`SELECT count, locked_until FROM login_ip_failures WHERE ip = ?`).get(ip) as any;
  return { count: r?.count ?? 0, lockedUntil: r?.locked_until ?? null };
}

export function setIpLoginFailures(ip: string, count: number, lockedUntil: string | null): void {
  db.prepare(`
    INSERT INTO login_ip_failures (ip, count, locked_until, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(ip) DO UPDATE SET count = excluded.count, locked_until = excluded.locked_until, updated_at = excluded.updated_at
  `).run(ip, count, lockedUntil);
}

/** La IP se "olvida" tras 7 días sin fallar. */
export function cleanOldIpFailures(): void {
  db.prepare(`DELETE FROM login_ip_failures WHERE updated_at < datetime('now', '-7 days') AND (locked_until IS NULL OR locked_until < datetime('now'))`).run();
}

/** ¿Este celular ya tiene cuentas con nosotros (compró por WhatsApp)? */
export function phoneHasAccounts(phone: string): boolean {
  const d = last9(phone);
  if (d.length < 9) return false;
  return !!db.prepare(`SELECT 1 FROM access_profiles WHERE substr(client_phone, -9) = ? LIMIT 1`).get(d);
}
