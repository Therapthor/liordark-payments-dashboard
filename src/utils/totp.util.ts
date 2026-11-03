import { generate } from "otplib";

// ─────────────────────────────────────────────────────────────
// 2FA por TOTP (Google Authenticator / Microsoft Authenticator, etc.) —
// a diferencia de los códigos por correo (ver codes-lookup.service.ts),
// acá no se consulta ninguna página externa: el código se calcula al
// vuelo a partir de la clave secreta guardada en la cuenta
// (access_accounts.totp_secret). Estándar RFC 6238 — 6 dígitos, rota
// cada 30s.
// ─────────────────────────────────────────────────────────────

const PERIOD_SECONDS = 30;

export async function getCurrentTotp(secret: string): Promise<{ code: string; secondsRemaining: number }> {
  const code = await generate({ secret });
  const nowSec = Math.floor(Date.now() / 1000);
  const secondsRemaining = PERIOD_SECONDS - (nowSec % PERIOD_SECONDS);
  return { code, secondsRemaining };
}
