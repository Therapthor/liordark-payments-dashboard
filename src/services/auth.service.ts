import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { Response } from "express";
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

// ── Dispositivos de confianza ──
// Cada navegador que entra al panel recibe una cookie firmada (1 año). Si
// alguien prueba contraseñas en masa cambiando de IP, el login se cierra
// para todos MENOS para esos dispositivos: el dueño sigue entrando.

export const TRUSTED_COOKIE = "ldp_trusted";
const TRUSTED_SECRET_KEY = "trusted_device_secret";
const TRUSTED_DAYS = 365;
let trustedSecret: string | null = null;

function getTrustedSecret(): string {
  if (trustedSecret) return trustedSecret;
  let s = getAdminSetting(TRUSTED_SECRET_KEY);
  if (!s) { s = crypto.randomBytes(32).toString("hex"); setAdminSetting(TRUSTED_SECRET_KEY, s); }
  trustedSecret = s;
  return s;
}

function trustedMac(id: string): Buffer {
  return crypto.createHmac("sha256", getTrustedSecret()).update(id).digest();
}

export function isTrustedDevice(token: unknown): boolean {
  if (typeof token !== "string") return false;
  const m = /^([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return false;
  return crypto.timingSafeEqual(Buffer.from(m[2]!, "hex"), trustedMac(m[1]!));
}

export function setTrustedDeviceCookie(res: Response): void {
  const id = crypto.randomBytes(16).toString("hex");
  res.cookie(TRUSTED_COOKIE, `${id}.${trustedMac(id).toString("hex")}`, {
    httpOnly: true,
    secure:   env.NODE_ENV === "production",
    sameSite: "strict",
    expires:  new Date(Date.now() + TRUSTED_DAYS * 86_400_000),
  });
}

/** Anula todos los dispositivos de confianza (al cerrar las demás sesiones
 *  o cambiar la contraseña). Cada uno vuelve a serlo al iniciar sesión. */
export function resetTrustedDevices(): void {
  trustedSecret = crypto.randomBytes(32).toString("hex");
  setAdminSetting(TRUSTED_SECRET_KEY, trustedSecret);
}

export function setPanelPassword(plain: string): void {
  setAdminSetting(PASSWORD_HASH_KEY, bcrypt.hashSync(plain, 12));
}

// Tras el ataque por el chat (nov-2026): al arrancar se cierran TODAS las
// sesiones del panel una sola vez. La contraseña nueva la genera el dueño
// en Configuración > Seguridad (nadie más la ve).
const LOGOUT_ALL_ID = "2026-11-07-chat-attack";

export function applyPendingPasswordRotation(): void {
  if (getAdminSetting("logout_all") === LOGOUT_ALL_ID) return;
  const closed = revokeAllAdminSessions();
  setAdminSetting("logout_all", LOGOUT_ALL_ID);
  console.log(`🔐 Se cerraron ${closed} sesiones del panel (cierre general por seguridad).`);
}
