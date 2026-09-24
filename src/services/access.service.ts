import {
  getAccountById,
  setAccountExpiry,
  resetRenewalMarkers,
  setRenewalPending,
  type AccessAccountWithProfiles,
} from "../db/access.repository";

const RENEW_DAYS = 30;

export type AccountStatus = "activo" | "por_vencer" | "vencido" | "sin_fecha";

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

/** Días restantes hasta el vencimiento. null si la cuenta no tiene fecha. */
export function daysLeft(expiresAt: string | null): number | null {
  if (!expiresAt) return null;
  return daysBetween(limaTodayISO(), expiresAt);
}

const WARNING_THRESHOLD_DAYS = 3;

/** Estado de la CUENTA — compartido por todos sus clientes/perfiles. */
export function accountStatus(expiresAt: string | null): AccountStatus {
  if (!expiresAt) return "sin_fecha";
  const left = daysLeft(expiresAt)!;
  if (left < 0) return "vencido";
  if (left <= WARNING_THRESHOLD_DAYS) return "por_vencer";
  return "activo";
}

// ─────────────────────────────────────────────────────────────
// RENOVAR CUENTA +30 DÍAS
// Renueva la cuenta entera (todos sus clientes comparten la misma
// fecha). Si ya venció, cuenta desde hoy, no desde la fecha vieja.
// ─────────────────────────────────────────────────────────────

export function renewAccount(id: number): AccessAccountWithProfiles | null {
  const account = getAccountById(id);
  if (!account) return null;

  const base = account.expiresAt && daysLeft(account.expiresAt)! >= 0
    ? account.expiresAt
    : limaTodayISO();

  setAccountExpiry(id, addDaysISO(base, RENEW_DAYS));

  // Ciclo nuevo, marca en blanco de nuevo — evita arrastrar un "renueva"
  // o "no renueva" que ya no aplica al período que recién empieza.
  resetRenewalMarkers(id);

  // Confirma cualquier renovación pendiente de pago que hubiera quedado
  // (ej. el cliente terminó pagando por el bot en vez de por acá).
  setRenewalPending(id, false);

  return getAccountById(id);
}
