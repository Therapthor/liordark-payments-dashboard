import crypto from "crypto";

/** Compara dos claves sin filtrar por tiempo cuánto se parecen (auditoría M4). */
export function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || !given || !expected) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
