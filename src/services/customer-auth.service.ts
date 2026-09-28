import crypto from "crypto";
import bcrypt from "bcryptjs";
import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env";

// ─────────────────────────────────────────────────────────────
// SESIÓN DE CLIENTE (tienda web) — mismo patrón de token firmado que
// auth.service.ts (admin), pero acá el token lleva el customerId, porque
// hay muchas cuentas de cliente en vez de una sola contraseña compartida.
// ─────────────────────────────────────────────────────────────

export const CUSTOMER_SESSION_COOKIE = "ldp_customer_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días
const BCRYPT_ROUNDS  = 10;

function sign(customerId: number, expiry: number): string {
  return crypto.createHmac("sha256", env.SESSION_SECRET)
    .update(`customer.${customerId}.${expiry}`)
    .digest("hex");
}

export function createCustomerSessionToken(customerId: number): { token: string; expires: Date } {
  const expiry = Date.now() + SESSION_TTL_MS;
  const token  = `${customerId}.${expiry}.${sign(customerId, expiry)}`;
  return { token, expires: new Date(expiry) };
}

/** Devuelve el customerId si el token es válido (firma + no vencido), o null. */
export function verifyCustomerSessionToken(token: string | undefined): number | null {
  if (!token) return null;
  const [idStr, expiryStr, signature] = token.split(".");
  if (!idStr || !expiryStr || !signature) return null;

  const customerId = Number(idStr);
  const expiry      = Number(expiryStr);
  if (!Number.isFinite(customerId) || !Number.isFinite(expiry) || expiry < Date.now()) return null;

  const expected = sign(customerId, expiry);
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  return customerId;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function checkPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// Middleware para las rutas públicas de la tienda (catálogo/checkout/
// dashboard) que necesitan saber quién es el cliente logueado.
export type RequestWithCustomer = Request & { customerId: number };

export function requireCustomerSession(req: Request, res: Response, next: NextFunction): void {
  const customerId = verifyCustomerSessionToken(req.cookies?.[CUSTOMER_SESSION_COOKIE]);
  if (!customerId) {
    res.status(401).json({ message: "Necesitás iniciar sesión." });
    return;
  }
  (req as RequestWithCustomer).customerId = customerId;
  next();
}
