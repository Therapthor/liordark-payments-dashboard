import bcrypt from "bcryptjs";
import crypto from "crypto";
import { env } from "../config/env";
import {
  createAdminSession, validateAdminSession, getAdminSetting, setAdminSetting, revokeAllAdminSessions,
} from "../db/security.repository";

// ─────────────────────────────────────────────────────────────
// SESIÓN DEL PANEL — cada inicio de sesión queda registrado (dispositivo,
// IP, última vez) en admin_sessions, así se puede ver dónde está abierto el
// panel y cerrar cualquier sesión (Configuración > Seguridad). La cookie
// lleva un token aleatorio; en la base solo se guarda su hash.
// ─────────────────────────────────────────────────────────────

export const SESSION_COOKIE = "ldp_session";
export const SESSION_TTL_DAYS = 30;

export function createSessionToken(ip = "", userAgent = ""): { token: string; expires: Date } {
  return createAdminSession(ip, userAgent, SESSION_TTL_DAYS);
}

export function verifySessionToken(token: string | undefined, ip?: string): boolean {
  return validateAdminSession(token, ip);
}

// ── Contraseña ──
// Si se cambió desde el panel, vale la guardada (hash bcrypt); si no, la
// de DASHBOARD_PASSWORD en .env.production.

const PASSWORD_HASH_KEY = "password_hash";

export function checkPassword(input: string): boolean {
  const stored = getAdminSetting(PASSWORD_HASH_KEY);
  if (stored) {
    try { return bcrypt.compareSync(input, stored); } catch { return false; }
  }
  const a = Buffer.from(input);
  const b = Buffer.from(env.DASHBOARD_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function setPanelPassword(plain: string): void {
  setAdminSetting(PASSWORD_HASH_KEY, bcrypt.hashSync(plain, 12));
}

// Cambio de contraseña pedido por el dueño (nov-2026, tras el ataque por el
// chat): se aplica una sola vez al arrancar y cierra TODAS las sesiones.
// Solo se guarda el hash; la contraseña se le entregó al dueño por privado.
const ROTATION_ID = "2026-11-07-chat-attack";
const ROTATION_HASH = "$2b$12$3W/NktPkxEjC3hfIOLy68OCdLfA/CBWARsiYS0QV3Wto2kAMGlsyu";

export function applyPendingPasswordRotation(): void {
  if (getAdminSetting("password_rotation") === ROTATION_ID) return;
  setAdminSetting(PASSWORD_HASH_KEY, ROTATION_HASH);
  const closed = revokeAllAdminSessions();
  setAdminSetting("password_rotation", ROTATION_ID);
  console.log(`🔐 Contraseña del panel cambiada y ${closed} sesiones cerradas.`);
}
