import { createHmac } from "crypto";

// ─────────────────────────────────────────────────────────────
// 2FA por TOTP (Google Authenticator / Microsoft Authenticator, etc.) —
// a diferencia de los códigos por correo (ver codes-lookup.service.ts),
// acá no se consulta ninguna página externa: el código se calcula al
// vuelo a partir de la clave secreta guardada en la cuenta
// (access_accounts.totp_secret). Estándar RFC 6238 (HMAC-SHA1) — 6
// dígitos, rota cada 30s.
//
// Solo usa crypto de Node: otplib rechazaba claves válidas de 16
// caracteres y claves cuyo último carácter trae bits de relleno distintos
// de cero (los proveedores las dan así).
// ─────────────────────────────────────────────────────────────

const PERIOD_SECONDS = 30;
const DIGITS = 6;
const MIN_SECRET_LENGTH = 16;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
// Largos posibles de Base32 sin "=" al final: el resto de dividir por 8
// solo puede ser 0, 2, 4, 5 o 7 (1, 3 y 6 no corresponden a bytes enteros).
const VALID_LENGTH_REMAINDERS = new Set([0, 2, 4, 5, 7]);

/** Limpia la clave como la pegue el admin (espacios, guiones, minúsculas)
 *  y la valida. Devuelve la clave lista para guardar, o null si no sirve. */
export function normalizeTotpSecret(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.replace(/[\s-]+/g, "").toUpperCase();
  if (!/^[A-Z2-7]+$/.test(key)) return null;
  if (key.length < MIN_SECRET_LENGTH) return null;
  if (!VALID_LENGTH_REMAINDERS.has(key.length % 8)) return null;
  return key;
}

/** Base32 (RFC 4648) → bytes. Los bits que sobran al final se ignoran
 *  aunque no sean cero. */
function base32Decode(key: string): Buffer {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of key) {
    buffer = ((buffer << 5) | BASE32_ALPHABET.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** Código TOTP (RFC 6238, HMAC-SHA1, pasos de 30 s, 6 dígitos) en el
 *  instante `timeMs`. Lanza un error si la clave no es válida. */
export function totpAt(secret: string, timeMs: number): string {
  const key = normalizeTotpSecret(secret);
  if (!key) throw new Error("La clave secreta 2FA no es válida.");

  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / PERIOD_SECONDS)));
  const hmac = createHmac("sha1", base32Decode(key)).update(counter).digest();

  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** Código vigente y cuántos segundos le quedan. Lanza un error si la
 *  clave no es válida — quien lo llama decide qué mostrar. */
export function getCurrentTotp(secret: string): { code: string; secondsRemaining: number } {
  const now = Date.now();
  const code = totpAt(secret, now);
  const secondsRemaining = PERIOD_SECONDS - (Math.floor(now / 1000) % PERIOD_SECONDS);
  return { code, secondsRemaining };
}
