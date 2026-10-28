import {
  getAccountById,
  setAccountExpiry,
  resetRenewalMarkers,
  setRenewalPending,
  listRenewableAccountsWithProfiles,
  applyRenewalExtension,
  listAccountsDueForRenewalCleanup,
  applyRenewalCleanup,
  type AccessAccountWithProfiles,
} from "../db/access.repository";
import { getCatalogProductByPlatform } from "../db/catalog.repository";
import { logRenewalHistory } from "../db/renewal-history.repository";
import { createCustomerNotifications } from "../db/customer-notifications.repository";

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

  const newExpiresAt = addDaysISO(base, RENEW_DAYS);
  setAccountExpiry(id, newExpiresAt);

  // Registro permanente — quién estaba ocupando la cuenta en el momento
  // de renovarla, para el resumen exportable "Renovados — registro".
  const platformTag = getCatalogProductByPlatform(account.platform)?.title || "";
  logRenewalHistory(
    account.profiles
      .filter(p => p.clientPhone)
      .map(p => ({
        accountId: id, platform: account.platform, platformTag,
        clientPhone: p.clientPhone, profileName: p.profileName, newExpiresAt,
      }))
  );

  // Ciclo nuevo, marca en blanco de nuevo — evita arrastrar un "renueva"
  // o "no renueva" que ya no aplica al período que recién empieza.
  resetRenewalMarkers(id);

  createCustomerNotifications(
    account.profiles
      .filter(p => p.clientPhone)
      .map(p => ({
        clientPhone: p.clientPhone, type: "renewed" as const,
        platform: account.platform, accountEmail: account.email,
      }))
  );

  // Confirma cualquier renovación pendiente de pago que hubiera quedado
  // (ej. el cliente terminó pagando por el bot en vez de por acá).
  setRenewalPending(id, false);

  return getAccountById(id);
}

// ─────────────────────────────────────────────────────────────
// CORTE AUTOMÁTICO DE CICLO — reemplaza tener que entrar cuenta por cuenta
// a renovar a mano. Los clientes se autogestionan (pagan desde
// liordark.com y eso marca su perfil "✅ Renueva" — ver confirmRenewalLog
// en renewal-log.repository.ts). Esto corre una vez al día (ver index.ts)
// y también se puede disparar a mano desde el panel:
//
//   1) 1 día antes de vencer: si alguien ya marcó "renueva", se extiende
//      la cuenta 30 días YA (para que a quien pagó no se le corte el
//      acceso ni un segundo) y se anota la fecha original de vencimiento
//      como "limpieza pendiente" — no se usa expires_at para el paso 2
//      porque acá mismo ya se movió 30 días para adelante.
//   2) En la fecha que quedó anotada (el día real de vencimiento del
//      ciclo viejo): se saca a quien no renovó, se les avisa al admin
//      que hay que cambiarle la contraseña a la cuenta.
//
// Si nadie renovó, no se hace nada acá — la cuenta sigue su curso normal
// y la recoge el archivado automático de siempre cuando de verdad vence.
// ─────────────────────────────────────────────────────────────

export type RenewalCutoverResult = {
  extended: { accountId: number; platform: string; email: string; renewedCount: number }[];
  cleaned:  { accountId: number; platform: string; email: string; freedCount: number }[];
};

export function runRenewalCutover(): RenewalCutoverResult {
  const today = limaTodayISO();
  const result: RenewalCutoverResult = { extended: [], cleaned: [] };

  // Paso 1 — extender a quien ya pagó, 1 día antes de vencer.
  const accounts = listRenewableAccountsWithProfiles();
  for (const account of accounts) {
    if (account.renewalCleanupDueAt) continue; // ya se procesó este ciclo (evita duplicar si el job corre 2 veces el mismo día)
    const left = daysLeft(account.expiresAt);
    if (left !== 1) continue;

    const renewing = account.profiles.filter(p => p.clientPhone && p.renewalStatus === "yes");
    if (renewing.length === 0) continue;

    const originalExpiresAt = account.expiresAt as string;
    const newExpiresAt = addDaysISO(originalExpiresAt, RENEW_DAYS);
    applyRenewalExtension(account.id, newExpiresAt, originalExpiresAt);

    const platformTag = getCatalogProductByPlatform(account.platform)?.title || "";
    logRenewalHistory(renewing.map(p => ({
      accountId: account.id, platform: account.platform, platformTag,
      clientPhone: p.clientPhone, profileName: p.profileName, newExpiresAt,
    })));
    createCustomerNotifications(renewing.map(p => ({
      clientPhone: p.clientPhone, type: "renewed" as const,
      platform: account.platform, accountEmail: account.email,
    })));

    result.extended.push({ accountId: account.id, platform: account.platform, email: account.email, renewedCount: renewing.length });
  }

  // Paso 2 — sacar a quien no renovó, en la fecha que le tocaba a ese ciclo.
  const due = listAccountsDueForRenewalCleanup(today);
  for (const account of due) {
    const { freedCount } = applyRenewalCleanup(account.id);
    if (freedCount > 0) {
      result.cleaned.push({ accountId: account.id, platform: account.platform, email: account.email, freedCount });
    }
  }

  return result;
}
