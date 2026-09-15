import {
  getProfileById,
  setProfileExpiry,
  type AccessProfile,
} from "../db/access.repository";

const RENEW_DAYS = 30;

export type ProfileStatus = "libre" | "activo" | "por_vencer" | "vencido";

// ─────────────────────────────────────────────────────────────
// FECHAS — Lima es UTC-5 fijo, sin horario de verano.
// Todo se maneja como YYYY-MM-DD, comparado como fecha pura
// (sin hora) para no arrastrar bugs de zona horaria.
// ─────────────────────────────────────────────────────────────

export function limaTodayISO(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
}

function daysBetween(fromISO: string, toISO: string): number {
  const [fy, fm, fd] = fromISO.split("-").map(Number);
  const [ty, tm, td] = toISO.split("-").map(Number);
  const a = Date.UTC(fy as number, (fm as number) - 1, fd);
  const b = Date.UTC(ty as number, (tm as number) - 1, td);
  return Math.round((b - a) / 86_400_000);
}

export function addDaysISO(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const dt = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Días restantes hasta el vencimiento. null si el perfil está libre. */
export function daysLeft(expiresAt: string | null): number | null {
  if (!expiresAt) return null;
  return daysBetween(limaTodayISO(), expiresAt);
}

const WARNING_THRESHOLD_DAYS = 3;

export function statusOf(profile: Pick<AccessProfile, "clientPhone" | "expiresAt">): ProfileStatus {
  if (!profile.clientPhone || !profile.expiresAt) return "libre";
  const left = daysLeft(profile.expiresAt)!;
  if (left < 0) return "vencido";
  if (left <= WARNING_THRESHOLD_DAYS) return "por_vencer";
  return "activo";
}

// ─────────────────────────────────────────────────────────────
// RENOVAR +30 DÍAS
// Si ya venció, cuenta desde hoy (no desde la fecha vieja) para
// no dejar "deuda" de días arrastrada de un vencimiento pasado.
// ─────────────────────────────────────────────────────────────

export function renewProfile(id: number): AccessProfile | null {
  const profile = getProfileById(id);
  if (!profile) return null;

  const base = profile.expiresAt && daysLeft(profile.expiresAt)! >= 0
    ? profile.expiresAt
    : limaTodayISO();

  return setProfileExpiry(id, addDaysISO(base, RENEW_DAYS));
}
