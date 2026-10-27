import crypto from "crypto";
import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// Enlace de renovación para el SMS de vencimiento — igual destino final
// que el botón "Renovar ahora" del correo (ver renewal-token.util.ts),
// pero el SMS no tiene espacio para un token largo firmado, así que acá
// se guarda un código corto por fila y el link solo lleva ese código.
// ─────────────────────────────────────────────────────────────

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // sin 0/O/1/I/l — mismo criterio que generatePassword()
const CODE_LENGTH   = 8;
const LINK_TTL_MS   = 10 * 24 * 60 * 60 * 1000; // igual vigencia que el token del correo

function generateCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

export function createSmsRenewalLink(phone: string, platform: string): string {
  const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
  // Colisión de código es prácticamente imposible (32^8), pero por las
  // dudas se reintenta si ya existe uno igual.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const exists = db.prepare(`SELECT 1 FROM sms_renewal_links WHERE code = ?`).get(code);
    if (exists) continue;
    db.prepare(`
      INSERT INTO sms_renewal_links (code, phone, platform, expires_at) VALUES (?, ?, ?, ?)
    `).run(code, phone, platform, expiresAt);
    return code;
  }
  throw new Error("No se pudo generar un código de renovación único.");
}

export type SmsRenewalLink = { phone: string; platform: string };

export function findSmsRenewalLink(code: string): SmsRenewalLink | null {
  const row = db.prepare(`
    SELECT phone, platform, expires_at AS expiresAt FROM sms_renewal_links WHERE code = ?
  `).get(code) as { phone: string; platform: string; expiresAt: string } | undefined;

  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) return null;
  return { phone: row.phone, platform: row.platform };
}

/** Borra los códigos ya vencidos — se llama de paso al mandar la tanda diaria. */
export function cleanExpiredSmsRenewalLinks(): void {
  db.prepare(`DELETE FROM sms_renewal_links WHERE expires_at < datetime('now')`).run();
}
