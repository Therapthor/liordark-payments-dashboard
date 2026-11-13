import {
  getAccountById,
  setAccountExpiry,
  resetRenewalMarkers,
  setRenewalPending,
  listRenewableAccountsWithProfiles,
  applyRenewalExtension,
  listAccountsDueForRenewalCleanup,
  applyRenewalCleanup,
  setProfileRenewal,
  listAccountsWithFreeProfiles,
  replaceClientAccount,
  assignClientToFreeProfile,
  listAccountSubscribers,
  listPlacementSlots,
  type AccessAccountWithProfiles,
  type SubscriberProfile,
} from "../db/access.repository";
import {
  createPendingAssignment, listPendingAssignments, markPendingAssigned, countPendingAssignments,
} from "../db/pending-assignments.repository";
import { getCatalogProductByPlatform } from "../db/catalog.repository";
import { db } from "../db/db";
import { logRenewalHistory } from "../db/renewal-history.repository";
import { createCustomerNotifications, createCustomerNotification } from "../db/customer-notifications.repository";
import { createWholesalerNotification } from "../db/wholesaler-notifications.repository";

const RENEW_DAYS = 30;

// Al pasar a otra cuenta a un cliente que ya pagó (Pendientes de cuenta
// nueva, o cuentas que no conviene renovar), sirve una cuenta que le dure al
// menos 28 de sus 30 días: hasta 2 días antes de la fecha que pagó.
export const RENEW_TOLERANCE_DAYS = 2;

/** Hasta cuándo tiene que durar como mínimo la cuenta destino de un cliente
 *  que pagó hasta `paidUntilISO` (nunca antes de hoy). */
export function minTargetExpiry(paidUntilISO: string): string {
  const floor = addDaysISO(paidUntilISO, -RENEW_TOLERANCE_DAYS);
  const today = limaTodayISO();
  return floor > today ? floor : today;
}

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
// AVISO AUTOMÁTICO AL EDITAR UNA CUENTA (Accesos › ✏️ Editar cuenta) —
// reemplaza los botones "Enviar reemplazo a todos" / "Cambiar contraseña a
// todos". Solo a los clientes con suscripción vigente en esa cuenta (manda
// la fecha propia del perfil si Soporte se la congeló), y solo por la
// campanita de notificaciones: nunca por WhatsApp.
// ─────────────────────────────────────────────────────────────

export type AccountNotice = "replacement" | "password";

/** Qué aviso corresponde a una edición: cambió el correo (con la
 *  contraseña o sin ella) → reemplazo de cuenta; solo la contraseña →
 *  cambio de contraseña; ninguno de los dos → sin aviso. */
export function accountNoticeFor(
  before: { email: string; password: string }, after: { email: string; password: string },
): AccountNotice | null {
  if (before.email.trim().toLowerCase() !== after.email.trim().toLowerCase()) return "replacement";
  if (before.password !== after.password) return "password";
  return null;
}

/** Clientes de la cuenta con suscripción vigente (vence hoy o después, o
 *  sin fecha). */
export function listActiveSubscribers(accountId: number): SubscriberProfile[] {
  const today = limaTodayISO();
  return listAccountSubscribers(accountId).filter(p => !p.expiresAt || p.expiresAt >= today);
}

/** Avisa por la campanita (cliente de la tienda o su mayorista) con los
 *  datos que la cuenta YA tiene guardados. Devuelve a cuántos se avisó. */
export function notifyActiveSubscribers(accountId: number, notice: AccountNotice): number {
  const account = getAccountById(accountId);
  if (!account) return 0;
  const active = listActiveSubscribers(accountId);
  for (const p of active) {
    if (notice === "password") {
      if (p.wholesalerId != null) createWholesalerNotification(p.wholesalerId, "password_changed", account.platform, account.email, account.password);
      else createCustomerNotification(p.clientPhone, "password_changed", account.platform, account.email, account.password);
      continue;
    }
    const left = daysLeft(p.expiresAt);
    const detail = `📧 Correo: ${account.email}\n🔑 Contraseña: ${account.password}` +
      (p.profileName ? `\n👤 Perfil: ${p.profileName}` : "") +
      (left !== null ? `\n⏳ Días restantes: ${left}` : "") +
      `\n\nCualquier inconveniente adicional, estamos atentos. 😊`;
    if (p.wholesalerId != null) createWholesalerNotification(p.wholesalerId, "account_replaced", account.platform, account.email, detail);
    else createCustomerNotification(p.clientPhone, "account_replaced", account.platform, account.email, detail);
  }
  return active.length;
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
  // Cuentas que no convenía renovar: clientes movidos / que quedaron pendientes.
  relocated: number;
  pendingNew: number;
  // Pendientes de cuenta nueva que ya se pudieron acomodar.
  assignedPending: number;
};

export function runRenewalCutover(): RenewalCutoverResult {
  const today = limaTodayISO();
  const result: RenewalCutoverResult = { extended: [], cleaned: [], relocated: 0, pendingNew: 0, assignedPending: 0 };

  // Paso 1 (extender a quien ya pagó) YA NO es automático: la cuenta entera
  // se renueva con el proveedor y eso lo confirma el admin en "Renovados"
  // (ver confirmCycleRenewal más abajo). Antes se sumaban 30 días solos
  // aunque el proveedor no hubiera renovado la cuenta — se terminaba
  // vendiendo una cuenta vencida.

  // Respaldo — cuentas que quedaron con una limpieza pendiente de un ciclo
  // anterior (ej. el job no corrió ese día) y todavía no se procesaron.
  const due = listAccountsDueForRenewalCleanup(today);
  for (const account of due) {
    const { freedCount } = applyRenewalCleanup(account.id);
    if (freedCount > 0) {
      result.cleaned.push({ accountId: account.id, platform: account.platform, email: account.email, freedCount });
    }
  }

  // Cuentas que no convenía renovar (la mitad o menos pagó), 1 día antes de
  // vencer: los que pagaron pasan a otra cuenta o a "Pendientes".
  const relocation = relocateUnworthyRenewals();
  result.relocated  = relocation.relocated;
  result.pendingNew = relocation.pending;
  result.assignedPending = assignPendingClients().assigned;

  return result;
}


// ─────────────────────────────────────────────────────────────
// RENOVADOS — CUENTAS CON PERFILES. Los clientes pagan la renovación de su
// perfil (marca "✅ Renueva"); la cuenta entera recién suma días cuando el
// admin confirma que ya la renovó con el proveedor.
// ─────────────────────────────────────────────────────────────

export type CycleRenewalAccount = {
  id: number; platform: string; email: string; provider: string;
  expiresAt: string | null; daysLeft: number | null; newExpiresAt: string | null;
  occupiedCount: number;
  // 🟢 conviene renovar: pagó MÁS de la mitad de los clientes de la cuenta.
  worthRenewing: boolean;
  percent: number;
  renewing: { profileId: number; clientPhone: string; profileName: string; wholesalerId: number | null }[];
};

/** Cuentas con perfiles donde alguien ya pagó y el admin todavía no
 *  confirmó la renovación de este ciclo. */
export function listCycleRenewalsAwaitingConfirmation(): CycleRenewalAccount[] {
  return listRenewableAccountsWithProfiles()
    .filter(a => !a.renewalCleanupDueAt)
    .map(a => {
      const renewing = a.profiles.filter(p => p.clientPhone && p.renewalStatus === "yes");
      return {
        id: a.id, platform: a.platform, email: a.email, provider: a.provider,
        expiresAt: a.expiresAt, daysLeft: daysLeft(a.expiresAt),
        newExpiresAt: a.expiresAt ? addDaysISO(a.expiresAt, RENEW_DAYS) : null,
        occupiedCount: a.profiles.filter(p => p.clientPhone).length,
        worthRenewing: renewing.length * 2 > a.profiles.filter(p => p.clientPhone).length,
        percent: Math.round(renewing.length * 100 / Math.max(1, a.profiles.filter(p => p.clientPhone).length)),
        renewing: renewing.map(p => ({ profileId: p.id, clientPhone: p.clientPhone, profileName: p.profileName, wholesalerId: p.wholesalerId })),
      };
    })
    .filter(a => a.renewing.length > 0)
    .sort((x, y) => Number(y.worthRenewing) - Number(x.worthRenewing) || (x.expiresAt ?? "").localeCompare(y.expiresAt ?? ""));
}

/** El admin ya renovó la cuenta con el proveedor: +30 días para todos
 *  desde el vencimiento actual. A quien no pagó se lo saca en la fecha de
 *  vencimiento original (si ya llegó, en este mismo momento). */
export function confirmCycleRenewal(accountId: number):
  { ok: true; newExpiresAt: string; renewedCount: number; freedCount: number } | { ok: false; error: string } {
  const account = getAccountById(accountId);
  if (!account || !account.hasProfiles || !account.expiresAt) return { ok: false, error: "Cuenta no encontrada." };
  if (account.renewalCleanupDueAt) return { ok: false, error: "Esta cuenta ya se confirmó en este ciclo." };

  const renewing = account.profiles.filter(p => p.clientPhone && p.renewalStatus === "yes");
  if (renewing.length === 0) return { ok: false, error: "Nadie pagó la renovación de esta cuenta todavía." };

  const originalExpiresAt = account.expiresAt;
  const newExpiresAt = addDaysISO(originalExpiresAt, RENEW_DAYS);
  applyRenewalExtension(account.id, newExpiresAt, originalExpiresAt);

  const platformTag = getCatalogProductByPlatform(account.platform)?.title || "";
  logRenewalHistory(renewing.map(p => ({
    accountId: account.id, platform: account.platform, platformTag,
    clientPhone: p.clientPhone, profileName: p.profileName, newExpiresAt,
  })));
  createCustomerNotifications(renewing.filter(p => p.wholesalerId == null).map(p => ({
    clientPhone: p.clientPhone, type: "renewed" as const,
    platform: account.platform, accountEmail: account.email,
  })));
  for (const wid of new Set(renewing.map(p => p.wholesalerId).filter((w): w is number => w != null))) {
    createWholesalerNotification(wid, "renewal_active", account.platform, account.email);
  }

  // Si ya llegó (o pasó) la fecha original, se saca hoy mismo a quien no
  // pagó; si no, lo hace el corte diario en esa fecha (renewal_cleanup_due_at).
  const left = daysLeft(originalExpiresAt);
  const freedCount = left !== null && left <= 1 ? applyRenewalCleanup(account.id).freedCount : 0;
  return { ok: true, newExpiresAt, renewedCount: renewing.length, freedCount };
}


// ─────────────────────────────────────────────────────────────
// CUENTAS QUE NO CONVIENE RENOVAR (la mitad o menos pagó) — 1 día antes de
// vencer, a los que sí pagaron se los mueve a un cupo libre de otra cuenta
// que les dure hasta su fecha nueva; si no hay, quedan en "Pendientes de
// cuenta nueva" (Accesos) hasta que el admin cargue cuentas nuevas. La
// cuenta vieja se deja vencer (no se renueva con el proveedor).
// ─────────────────────────────────────────────────────────────

function notifyNewAccount(clientPhone: string, wholesalerId: number | null, platform: string, accountId: number, expiresAt: string): void {
  const acc = getAccountById(accountId);
  if (!acc) return;
  const profile = acc.profiles.find(p => p.clientPhone && p.clientPhone.slice(-9) === clientPhone.replace(/\D/g, "").slice(-9));
  const detail = `📧 Correo: ${acc.email}` + (acc.password ? `\n🔑 Contraseña: ${acc.password}` : "") +
    (profile?.profileName ? `\n👤 Perfil: ${profile.profileName}` : "") +
    `\n📅 Vence: ${expiresAt}\n\n¡Tu renovación ya está activa en esta cuenta nueva! Cualquier inconveniente, estamos atentos. 😊`;
  if (wholesalerId != null) createWholesalerNotification(wholesalerId, "account_replaced", platform, acc.email, detail);
  else createCustomerNotification(clientPhone, "account_replaced", platform, acc.email, detail);
}

export type RelocationResult = { relocated: number; pending: number; accounts: string[] };

export function relocateUnworthyRenewals(): RelocationResult {
  const result: RelocationResult = { relocated: 0, pending: 0, accounts: [] };
  for (const a of listCycleRenewalsAwaitingConfirmation()) {
    if (a.worthRenewing || a.daysLeft === null || a.daysLeft > 1 || !a.newExpiresAt) continue;
    result.accounts.push(`${a.platform} — ${a.email}`);
    for (const p of a.renewing) {
      const target = listAccountsWithFreeProfiles(a.platform, 1, minTargetExpiry(a.newExpiresAt)).find(t => t.id !== a.id);
      if (target) {
        replaceClientAccount({
          clientPhone: p.clientPhone, platform: a.platform, email: a.email,
          targetAccountId: target.id, wholesalerId: p.wholesalerId, expiresAt: a.newExpiresAt,
        });
        notifyNewAccount(p.clientPhone, p.wholesalerId, a.platform, target.id, a.newExpiresAt);
        result.relocated++;
      } else {
        createPendingAssignment({
          platform: a.platform, clientPhone: p.clientPhone, wholesalerId: p.wholesalerId,
          profileName: p.profileName, expiresAt: a.newExpiresAt, fromEmail: a.email,
        });
        // Ya no "renueva" en esta cuenta (que no se renovará): sigue usándola
        // hasta que venza, y deja de bloquear su archivado.
        setProfileRenewal(p.profileId, "");
        result.pending++;
      }
    }
  }
  return result;
}

export type PendingAssigned = {
  pendingId: number; platform: string; clientPhone: string; wholesalerId: number | null; paidUntil: string;
  accountId: number; accountEmail: string; accountExpiresAt: string | null;
};
export type PendingNotPlaced = {
  pendingId: number; platform: string; clientPhone: string; wholesalerId: number | null; paidUntil: string;
  reason: string;
};
export type AssignPendingResult = {
  assigned: number; stillPending: number; assignedList: PendingAssigned[]; notPlaced: PendingNotPlaced[];
};

function ddmm(dateISO: string): string {
  const [, m, d] = dateISO.split("-");
  return `${d}/${m}`;
}

/** "Asignar pendientes" (Accesos) — y también en el corte diario: todos de
 *  una vez, los más antiguos primero, repartidos entre TODAS las cuentas de
 *  su plataforma con cupo libre. Cada uno va a la cuenta con cupo que vence
 *  antes pero igual le dura lo suficiente (ver minTargetExpiry): así las
 *  cuentas más largas quedan para quien las necesita. Los que no entran
 *  siguen pendientes, con el motivo. */
export const assignPendingClients = db.transaction((): AssignPendingResult => {
  const today = limaTodayISO();
  const result: AssignPendingResult = { assigned: 0, stillPending: 0, assignedList: [], notPlaced: [] };
  const slotsByPlatform = new Map<string, { id: number; email: string; expiresAt: string | null; free: number }[]>();
  const pending = [...listPendingAssignments()].sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id - y.id);

  for (const pend of pending) {
    let slots = slotsByPlatform.get(pend.platform);
    if (!slots) {
      // Las que vencen antes primero; sin fecha, al final.
      slots = listPlacementSlots(pend.platform, today)
        .map(a => ({ id: a.id, email: a.email, expiresAt: a.expiresAt, free: a.freeCount }))
        .sort((x, y) => (x.expiresAt ?? "9999-12-31").localeCompare(y.expiresAt ?? "9999-12-31") || x.id - y.id);
      slotsByPlatform.set(pend.platform, slots);
    }
    const need = minTargetExpiry(pend.expiresAt);
    const base = { pendingId: pend.id, platform: pend.platform, clientPhone: pend.clientPhone, wholesalerId: pend.wholesalerId, paidUntil: pend.expiresAt };

    let placed: { id: number; email: string; expiresAt: string | null; free: number } | null = null;
    for (;;) {
      const target = slots.find(t => t.free > 0 && (!t.expiresAt || t.expiresAt >= need));
      if (!target) break;
      const profileId = assignClientToFreeProfile({
        accountId: target.id, clientPhone: pend.clientPhone, wholesalerId: pend.wholesalerId, expiresAt: pend.expiresAt,
      });
      if (profileId) { target.free--; placed = target; break; }
      target.free = 0; // ya no le quedaba cupo de verdad
    }

    if (!placed) {
      const withRoom = slots.filter(t => t.free > 0);
      const latest = withRoom.map(t => t.expiresAt ?? "").sort().pop() ?? "";
      result.notPlaced.push({
        ...base,
        reason: withRoom.length === 0
          ? `No hay cupos libres de ${pend.platform}`
          : `Las cuentas con cupo de ${pend.platform} vencen el ${ddmm(latest)}; necesita una que dure hasta el ${ddmm(need)} (pagó hasta el ${ddmm(pend.expiresAt)})`,
      });
      continue;
    }

    markPendingAssigned(pend.id, placed.id);
    notifyNewAccount(pend.clientPhone, pend.wholesalerId, pend.platform, placed.id, pend.expiresAt);
    result.assignedList.push({ ...base, accountId: placed.id, accountEmail: placed.email, accountExpiresAt: placed.expiresAt });
  }

  result.assigned = result.assignedList.length;
  result.stillPending = countPendingAssignments();
  return result;
});
