import crypto from "crypto";
import { env } from "../config/env";

export const SESSION_COOKIE = "ldp_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

function sign(expiry: number): string {
  return crypto.createHmac("sha256", env.SESSION_SECRET).update(String(expiry)).digest("hex");
}

/** Genera el valor de cookie de una sesión nueva, válida por 30 días. */
export function createSessionToken(): { token: string; expires: Date } {
  const expiry = Date.now() + SESSION_TTL_MS;
  const token  = `${expiry}.${sign(expiry)}`;
  return { token, expires: new Date(expiry) };
}

/** Verifica un token de sesión (firma + expiración). */
export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const [expiryStr, signature] = token.split(".");
  if (!expiryStr || !signature) return false;

  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;

  const expected = sign(expiry);
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Compara la contraseña ingresada contra DASHBOARD_PASSWORD, sin timing attack. */
export function checkPassword(input: string): boolean {
  const expected = env.DASHBOARD_PASSWORD;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
