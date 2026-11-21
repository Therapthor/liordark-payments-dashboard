import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// CEREBRO DE CUENTAS — piezas de base (sin depender de servicios, para que
// access.repository pueda usarlas sin ciclos de import). La lógica de las
// 10 pm vive en services/brain.service.ts.
//
// En las plataformas del cerebro cada cliente tiene SU fecha
// (access_profiles.expires_override) y la cuenta guarda hasta cuándo está
// pagada al proveedor (access_accounts.expires_at). Plataformas:
//  · las de perfiles del catálogo (Netflix, Crunchyroll, Disney, HBO…);
//  · las de accesos compartidos que se cambian de correo cada mes
//    (ChatGPT, CapCut): nunca se renuevan, el cliente pasa a otra cuenta.
// Las de activación manual (Canva, Gemini, YouTube) siguen como siempre.
// ─────────────────────────────────────────────────────────────

export const ROTATE_PLATFORMS = new Set(["CHATGPT", "CAPCUT PRO"]);
const MANUAL_ACTIVATION_RE = /canva|gemini|youtube/i;
// Cuentas individuales (1 cliente por cuenta, sin perfiles) con planes por
// meses: el cliente tiene su fecha y la cuenta se le paga al proveedor mes a
// mes mientras siga (el cerebro la pide en «Pagos al proveedor»).
const SINGLE_RE = /spotify/i;

let cache: { at: number; set: Set<string> } | null = null;

export function brainPlatforms(): Set<string> {
  if (cache && Date.now() - cache.at < 60_000) return cache.set;
  const rows = db.prepare(`SELECT UPPER(TRIM(platform)) AS p, has_profiles AS hp FROM catalog_products`).all() as { p: string; hp: number }[];
  const set = new Set<string>(ROTATE_PLATFORMS);
  for (const r of rows) if ((r.hp === 1 && !MANUAL_ACTIVATION_RE.test(r.p)) || SINGLE_RE.test(r.p)) set.add(r.p);
  cache = { at: Date.now(), set };
  return set;
}

export function invalidateBrainPlatforms(): void { cache = null; }

export function isBrainPlatform(platform: string | null | undefined): boolean {
  return brainPlatforms().has(String(platform ?? "").trim().toUpperCase());
}

/** Plataforma del cerebro de cuentas individuales (Spotify). */
export function isSingleBrainPlatform(platform: string | null | undefined): boolean {
  return SINGLE_RE.test(String(platform ?? "")) && isBrainPlatform(platform);
}

export function isRotatePlatform(platform: string | null | undefined): boolean {
  return ROTATE_PLATFORMS.has(String(platform ?? "").trim().toUpperCase());
}

// ── Fechas (hora Lima), sin depender de access.service ──

export function limaToday(): string {
  return new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
}

export function addDays(dateISO: string, days: number): string {
  const t = Date.parse(dateISO + "T00:00:00Z") + days * 86400e3;
  return new Date(t).toISOString().slice(0, 10);
}

/** Fecha propia del cliente de un perfil (o la de la cuenta si no tiene). */
export function clientDateOf(profileId: number): string | null {
  const row = db.prepare(`
    SELECT COALESCE(p.expires_override, a.expires_at) AS d
    FROM access_profiles p JOIN access_accounts a ON a.id = p.account_id WHERE p.id = ?
  `).get(profileId) as { d: string | null } | undefined;
  return row?.d ?? null;
}

/** Fecha del cliente para una venta nueva: hoy + días del plan. */
export function setNewClientDate(profileId: number, days: number, months: number | null): string {
  const date = addDays(limaToday(), days);
  db.prepare(`
    UPDATE access_profiles
    SET expires_override = ?, plan_months = ?, renewal_status = '', reminder_sent_at = NULL, sms_reminder_sent_at = NULL,
        expiry_notified_at = NULL, email_reminder_3d_sent_at = NULL, email_reminder_1d_sent_at = NULL, moved_at = NULL
    WHERE id = ?
  `).run(date, months, profileId);
  return date;
}

/** Renovación pagada: suma los días a la fecha del cliente (desde su fecha si
 *  sigue vigente, o desde hoy si ya venció). Reinicia los avisos de
 *  vencimiento para el ciclo nuevo. Devuelve la fecha nueva. */
export function extendClientDate(profileId: number, days: number): string | null {
  const today = limaToday();
  const current = clientDateOf(profileId);
  const base = current && current >= today ? current : today;
  const date = addDays(base, days);
  const r = db.prepare(`
    UPDATE access_profiles
    SET expires_override = ?, renewal_status = '', reminder_sent_at = NULL, sms_reminder_sent_at = NULL,
        expiry_notified_at = NULL, email_reminder_3d_sent_at = NULL, email_reminder_1d_sent_at = NULL,
        updated_at = datetime('now')
    WHERE id = ? AND (client_phone != '' OR wholesaler_id IS NOT NULL)
  `).run(date, profileId);
  return r.changes > 0 ? date : null;
}

/** Ventas por plataforma (para calcular cuánto stock dejar libre). */
export function recordBrainSale(platform: string): void {
  try {
    db.prepare(`INSERT INTO brain_sales (platform) VALUES (?)`).run(String(platform).trim().toUpperCase());
  } catch { /* no crítico */ }
}
