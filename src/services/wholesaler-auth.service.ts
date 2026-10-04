import crypto from "crypto";
import bcrypt from "bcryptjs";
import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { findWholesalerById } from "../db/wholesaler.repository";

// ─────────────────────────────────────────────────────────────
// SESIÓN DE MAYORISTA — mismo patrón de token firmado que
// customer-auth.service.ts, con prefijo "wholesaler." en la firma para
// que un token de cliente nunca sea válido acá ni viceversa, aunque
// compartan env.SESSION_SECRET.
// ─────────────────────────────────────────────────────────────

export const WHOLESALER_SESSION_COOKIE = "ldp_wholesaler_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días
const BCRYPT_ROUNDS  = 10;

function sign(wholesalerId: number, expiry: number): string {
  return crypto.createHmac("sha256", env.SESSION_SECRET)
    .update(`wholesaler.${wholesalerId}.${expiry}`)
    .digest("hex");
}

export function createWholesalerSessionToken(wholesalerId: number): { token: string; expires: Date } {
  const expiry = Date.now() + SESSION_TTL_MS;
  const token  = `${wholesalerId}.${expiry}.${sign(wholesalerId, expiry)}`;
  return { token, expires: new Date(expiry) };
}

export function verifyWholesalerSessionToken(token: string | undefined): number | null {
  if (!token) return null;
  const [idStr, expiryStr, signature] = token.split(".");
  if (!idStr || !expiryStr || !signature) return null;

  const wholesalerId = Number(idStr);
  const expiry        = Number(expiryStr);
  if (!Number.isFinite(wholesalerId) || !Number.isFinite(expiry) || expiry < Date.now()) return null;

  const expected = sign(wholesalerId, expiry);
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  return wholesalerId;
}

export async function hashWholesalerPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function checkWholesalerPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export type RequestWithWholesaler = Request & { wholesalerId: number };

export function requireWholesalerSession(req: Request, res: Response, next: NextFunction): void {
  const wholesalerId = verifyWholesalerSessionToken(req.cookies?.[WHOLESALER_SESSION_COOKIE]);
  if (!wholesalerId) {
    res.status(401).json({ message: "Necesitás iniciar sesión." });
    return;
  }

  // Se revisa en cada request (no solo en /login) para que deshabilitar
  // a un mayorista corte también una sesión que ya estaba abierta.
  const wholesaler = findWholesalerById(wholesalerId);
  if (!wholesaler) {
    res.status(401).json({ message: "Necesitás iniciar sesión." });
    return;
  }
  if (wholesaler.status === "disabled") {
    res.clearCookie(WHOLESALER_SESSION_COOKIE);
    res.status(403).json({ message: "Tu cuenta está deshabilitada. Contáctanos si crees que es un error." });
    return;
  }

  (req as RequestWithWholesaler).wholesalerId = wholesalerId;
  next();
}
