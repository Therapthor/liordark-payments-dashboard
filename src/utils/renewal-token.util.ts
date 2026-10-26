import crypto from "crypto";
import { env } from "../config/env";

// ─────────────────────────────────────────────────────────────
// Token del botón "Renovar ahora" del correo de recordatorio — identifica
// celular + plataforma sin necesitar login (igual que /renewals/checkout,
// que ya es público por celular). Firmado con SESSION_SECRET para que no
// se pueda armar un link a mano apuntando al celular de otra persona, y
// con vencimiento corto porque es de un solo uso puntual (clic desde el
// correo), no una sesión.
// ─────────────────────────────────────────────────────────────

const TOKEN_TTL_MS = 10 * 24 * 60 * 60 * 1000; // 10 días — cubre el aviso de 3 y de 1 día con margen

export type RenewalTokenPayload = { phone: string; platform: string; exp: number };

function sign(data: string): string {
  return crypto.createHmac("sha256", env.SESSION_SECRET).update(data).digest("hex");
}

export function createRenewalToken(phone: string, platform: string): string {
  const payload: RenewalTokenPayload = { phone, platform, exp: Date.now() + TOKEN_TTL_MS };
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${json}.${sign(json)}`;
}

export function verifyRenewalToken(token: string): RenewalTokenPayload | null {
  const [json, signature] = String(token).split(".");
  if (!json || !signature) return null;
  if (sign(json) !== signature) return null;

  try {
    const payload = JSON.parse(Buffer.from(json, "base64url").toString("utf8")) as RenewalTokenPayload;
    if (!payload.phone || !payload.platform || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
