import { db } from "../db/db";
import {
  listAccountsByClientPhone, getActiveAccountForClient, getAccountById, listAccountsWithFreeProfiles,
  replaceClientAccount, replaceClientAccountManual,
} from "../db/access.repository";
import {
  createSupportTicket, findOpenTicketForAccount, countTicketsTodayForClient, getSupportTicketById,
  markSupportTicketSeen, markSupportTicketResolved, type SupportTicket,
} from "../db/support-tickets.repository";
import { createCustomerNotification } from "../db/customer-notifications.repository";
import { createWholesalerNotification } from "../db/wholesaler-notifications.repository";
import { findOpenWholesalerTicket, countWholesalerTicketsToday } from "../db/support-tickets.repository";
import { getProfileById } from "../db/access.repository";
import { resetWholesalerCodeQuota } from "../db/code-links.repository";
import { getCatalogProductByPlatform } from "../db/catalog.repository";
import { limaTodayISO } from "./access.service";

// ─────────────────────────────────────────────────────────────
// SOPORTES — el asistente de liordark.com ya no es un chat: el cliente
// solo elige botones y lo único que se guarda es el reporte de una cuenta
// «sin suscripción» (una vez por cuenta mientras siga abierto). Desde el
// panel > Soportes el admin avisa al cliente en su campanita de la web:
// «En revisión», «Tiene suscripción» o «Listo»; «Reemplazar cuenta»
// además da el mensaje con los datos nuevos para WhatsApp.
// ─────────────────────────────────────────────────────────────

const MAX_REPORTS_PER_DAY = 5;
export const NOSUB_PROBLEM = "Sin suscripción";

function last9(phone: string): string {
  return String(phone || "").replace(/\D/g, "").slice(-9);
}

function platformTitle(platform: string): string {
  return getCatalogProductByPlatform(platform)?.title || platform;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

// ── Cliente (liordark.com) ──

export type ReportableAccount = {
  platform: string; platformTag: string; email: string; profileName: string;
  expiresAt: string | null; reported: boolean; reportStatus: "pending" | "seen" | null;
};

/** Cuentas vigentes del cliente (sin repetir) y si ya tienen un reporte abierto. */
export function listReportableAccounts(phone: string): ReportableAccount[] {
  const today = limaTodayISO();
  const seen = new Set<string>();
  return listAccountsByClientPhone(phone)
    .filter(a => !a.expiresAt || a.expiresAt >= today)
    .filter(a => {
      const key = a.platform.toUpperCase() + "|" + a.email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(a => {
      const open = findOpenTicketForAccount(phone, a.platform, a.email);
      return {
        platform: a.platform, platformTag: platformTitle(a.platform), email: a.email,
        profileName: a.profileName || "", expiresAt: a.expiresAt,
        reported: !!open, reportStatus: open ? (open.status as "pending" | "seen") : null,
      };
    });
}

export type ReportResult =
  | { ok: true; ticket: SupportTicket }
  | { ok: false; status: number; message: string };

export function reportNoSubscription(phone: string, platform: string, email: string): ReportResult {
  const account = getActiveAccountForClient(phone, platform, email);
  if (!account) return { ok: false, status: 404, message: "Esa cuenta no está activa en tu perfil." };
  if (account.expiresAt && account.expiresAt < limaTodayISO()) {
    return { ok: false, status: 409, message: "Esa cuenta ya venció. Renuévala desde «Mis cuentas»." };
  }
  if (findOpenTicketForAccount(phone, account.platform, account.email)) {
    return { ok: false, status: 409, message: "Ya reportaste esta cuenta ✋. Está en revisión; te avisaremos apenas quede lista." };
  }
  if (countTicketsTodayForClient(phone) >= MAX_REPORTS_PER_DAY) {
    return { ok: false, status: 429, message: "Ya enviaste varios reportes hoy. Si es urgente, escríbenos por WhatsApp al +51 963 081 436." };
  }
  const profile = listAccountsByClientPhone(phone)
    .find(a => a.platform.toUpperCase() === account.platform.toUpperCase() && a.email === account.email);
  const ticket = createSupportTicket({
    clientPhone: phone, wholesalerId: null, platform: account.platform, accountEmail: account.email,
    accountPassword: account.password, profileName: profile?.profileName || "",
    provider: account.provider || "", problem: NOSUB_PROBLEM,
  });
  return { ok: true, ticket };
}

// ── Mensajes listos para WhatsApp ──

export function reviewMessage(platform: string): string {
  return `🔎 ¡Hola! Recibimos el reporte de tu cuenta de ${platformTitle(platform)} y ya está en revisión 🛠️\n` +
    `Te avisamos apenas quede lista. ¡Gracias por tu paciencia! 🥭`;
}

export function activeMessage(platform: string): string {
  return `✅ ¡Hola! Revisamos tu cuenta de ${platformTitle(platform)}: tiene su suscripción activa y no presenta caídas 🎬\n` +
    `Cierra sesión y vuelve a ingresar con tus datos para que se actualice. ¡Cualquier duda, aquí estamos! 🥭`;
}

export function solvedMessage(platform: string): string {
  return `🎉 ¡Listo! El problema de tu cuenta de ${platformTitle(platform)} ya está solucionado ✅\n` +
    `Si aún no carga, cierra sesión y vuelve a ingresar. ¡Gracias por tu paciencia! 🥭`;
}

export function replacementMessage(p: {
  platform: string; email: string; password: string; profileName: string; expiresAt: string | null; temporary: boolean;
}): string {
  const head = p.temporary
    ? `🔁 ¡Hola! Mientras solucionamos tu cuenta de ${platformTitle(p.platform)}, te dejamos esta cuenta temporal 🙌`
    : `🔁 ¡Hola! Te asignamos una nueva cuenta de ${platformTitle(p.platform)} 🎉`;
  const lines = [
    head, "",
    `📧 Correo: ${p.email}`,
    `🔑 Contraseña: ${p.password}`,
    ...(p.profileName ? [`👤 Perfil: ${p.profileName}`] : []),
    ...(p.expiresAt ? [`📅 Vence: ${fmtDate(p.expiresAt)} (tu misma fecha)`] : []),
    "", "¡Que la disfrutes! 🥭",
  ];
  return lines.join("\n");
}

// ── Panel mayorista (Soporte) ──
// El mayorista reporta un problema con la cuenta de un cliente suyo o
// pide que le restablezcan las consultas de códigos del día de una venta.
// Llega al mismo panel > Soportes; la respuesta le llega a su campanita.

export const WHOLESALE_REPORT_REASONS = [
  "No tiene suscripción / no funciona",
  "Pide código o verificación",
  "Contraseña incorrecta",
  "Otro",
] as const;
export const CODES_RESET_PROBLEM = "Restablecer límite de códigos";
const MAX_WHOLESALE_REPORTS_PER_DAY = 10;

export function reportWholesalerProblem(params: {
  wholesalerId: number; profileId: number; kind: "account" | "codes"; reason?: string; detail?: string;
  codesRemaining?: number | null;
}): ReportResult {
  const profile = getProfileById(params.profileId);
  if (!profile || profile.wholesalerId !== params.wholesalerId || !profile.clientPhone) {
    return { ok: false, status: 404, message: "No encontramos esa cuenta en tus clientes." };
  }
  const account = getAccountById(profile.accountId);
  if (!account) return { ok: false, status: 404, message: "No encontramos esa cuenta en tus clientes." };

  if (findOpenWholesalerTicket(params.wholesalerId, profile.id, params.kind)) {
    return { ok: false, status: 409, message: params.kind === "codes"
      ? "Ya pediste restablecer el límite de esta cuenta. Te avisamos apenas esté listo."
      : "Ya reportaste esta cuenta y está en revisión. Te avisamos apenas quede lista." };
  }
  if (countWholesalerTicketsToday(params.wholesalerId) >= MAX_WHOLESALE_REPORTS_PER_DAY) {
    return { ok: false, status: 429, message: "Ya enviaste varios reportes hoy. Si es urgente, escríbenos por WhatsApp." };
  }

  let problem: string;
  if (params.kind === "codes") {
    if (params.codesRemaining != null && params.codesRemaining > 0) {
      return { ok: false, status: 409, message: `Todavía te quedan ${params.codesRemaining} consultas hoy para esta cuenta.` };
    }
    problem = CODES_RESET_PROBLEM;
  } else {
    const reason = WHOLESALE_REPORT_REASONS.find(r => r === params.reason) ?? "Otro";
    const detail = String(params.detail ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (reason === "Otro" && !detail) return { ok: false, status: 400, message: "Cuéntanos qué pasa con la cuenta." };
    problem = detail ? `${reason} — ${detail}` : reason;
  }

  const ticket = createSupportTicket({
    clientPhone: profile.clientPhone, wholesalerId: params.wholesalerId, platform: account.platform,
    accountEmail: account.email, accountPassword: account.password, profileName: profile.profileName || "",
    provider: account.provider || "", problem, kind: params.kind, profileId: profile.id,
  });
  return { ok: true, ticket };
}

function wholesalerUpdate(t: SupportTicket, text: string): void {
  if (!t.wholesalerId) return;
  createWholesalerNotification(t.wholesalerId, "support_update", t.platform, t.accountEmail, text);
}

function clientRef(t: SupportTicket): string {
  return `${platformTitle(t.platform)} de tu cliente ${String(t.clientPhone).replace(/\D/g, "").slice(-9)}`;
}

// ── Panel ──

export function setTicketInReview(id: number): { ticket: SupportTicket; message: string } | null {
  const before = getSupportTicketById(id);
  if (!before) return null;
  const message = reviewMessage(before.platform);
  const ticket = before.status === "pending" ? markSupportTicketSeen(id) : before;
  if (before.status === "pending" && !before.wholesalerId) {
    createCustomerNotification(before.clientPhone, "support_update", before.platform, before.accountEmail, message);
  }
  if (before.status === "pending" && before.wholesalerId) {
    wholesalerUpdate(before, `🔎 Tu reporte de ${clientRef(before)} está en revisión. Te avisamos apenas quede listo.`);
  }
  return ticket ? { ticket, message } : null;
}

export function resolveTicketActive(id: number): { ticket: SupportTicket; message: string } | null {
  const before = getSupportTicketById(id);
  if (!before) return null;
  const message = activeMessage(before.platform);
  const ticket = markSupportTicketResolved(id, "active", message);
  if (before.status !== "attended" && !before.wholesalerId) {
    createCustomerNotification(before.clientPhone, "support_update", before.platform, before.accountEmail, message);
  }
  if (before.status !== "attended" && before.wholesalerId) {
    wholesalerUpdate(before, `✅ Revisamos ${clientRef(before)}: tiene su suscripción activa. Que cierre sesión y vuelva a entrar con sus datos.`);
  }
  return ticket ? { ticket, message } : null;
}

export function resolveTicketSolved(id: number): { ticket: SupportTicket; message: string } | null {
  const before = getSupportTicketById(id);
  if (!before) return null;
  const message = solvedMessage(before.platform);
  const ticket = markSupportTicketResolved(id, "solved", message);
  if (before.status !== "attended" && !before.wholesalerId) {
    createCustomerNotification(before.clientPhone, "support_update", before.platform, before.accountEmail, message);
  }
  if (before.status !== "attended" && before.wholesalerId) {
    wholesalerUpdate(before, `🎉 Listo: el problema de ${clientRef(before)} ya está solucionado.`);
  }
  return ticket ? { ticket, message } : null;
}

/** «Restablecer límite» (reporte de códigos del mayorista): las consultas de
 *  hoy de esa venta dejan de contar y se cierra el reporte. */
export function resetCodesForTicket(id: number): { ok: true; ticket: SupportTicket; message: string } | { ok: false; message: string } {
  const before = getSupportTicketById(id);
  if (!before) return { ok: false, message: "Reporte no encontrado." };
  if (before.kind !== "codes" || !before.profileId) return { ok: false, message: "Este reporte no es de códigos." };
  resetWholesalerCodeQuota(before.profileId);
  const message = `🔑 Listo: te restablecimos las consultas de códigos de hoy de ${clientRef(before)}. Ya puedes volver a consultar.`;
  const ticket = markSupportTicketResolved(id, "solved", message);
  if (before.status !== "attended") wholesalerUpdate(before, message);
  return { ok: true, ticket: ticket ?? before, message };
}

export type ReplaceOption = {
  id: number; email: string; expiresAt: string | null; freeCount: number; usedCount: number; totalCount: number;
};

/** Destinos para el reemplazo: cuentas vigentes de la misma plataforma.
 *  fresh = con perfil libre (el cliente ocupa ese perfil); shared = todas
 *  (uso temporal: se le pasan los datos sin ocupar perfil). */
export function replaceOptions(ticket: SupportTicket): { fresh: ReplaceOption[]; shared: ReplaceOption[] } {
  const today = limaTodayISO();
  const rows = db.prepare(`
    SELECT a.id AS id, a.email AS email, a.expires_at AS expiresAt,
           SUM(CASE WHEN p.id IS NOT NULL AND p.client_phone = '' THEN 1 ELSE 0 END) AS freeCount,
           SUM(CASE WHEN p.client_phone != '' THEN 1 ELSE 0 END) AS usedCount,
           COUNT(p.id) AS totalCount
    FROM access_accounts a
    LEFT JOIN access_profiles p ON p.account_id = a.id
    WHERE a.platform = ? AND (a.expires_at IS NULL OR a.expires_at >= ?) AND lower(a.email) != lower(?)
    GROUP BY a.id
    ORDER BY a.expires_at DESC
  `).all(ticket.platform.toUpperCase(), today, ticket.accountEmail) as ReplaceOption[];
  const freeIds = new Set(listAccountsWithFreeProfiles(ticket.platform, 1, today).map(a => a.id));
  return {
    fresh: rows.filter(r => r.freeCount > 0 && freeIds.has(r.id)),
    shared: rows,
  };
}

export function replaceTicketAccount(
  id: number, mode: "fresh" | "shared", targetAccountId: number, profileName: string
): { ok: true; ticket: SupportTicket; message: string } | { ok: false; message: string } {
  const ticket = getSupportTicketById(id);
  if (!ticket) return { ok: false, message: "Reporte no encontrado." };
  if (ticket.status === "attended") return { ok: false, message: "Este reporte ya está resuelto." };
  const target = getAccountById(targetAccountId);
  if (!target || target.platform.toUpperCase() !== ticket.platform.toUpperCase()) {
    return { ok: false, message: "Elige una cuenta de la misma plataforma." };
  }
  if (target.email.toLowerCase() === ticket.accountEmail.toLowerCase()) {
    return { ok: false, message: "Elige una cuenta distinta a la reportada." };
  }

  let newProfile = "";
  let expiresAt: string | null = null;
  try {
    if (mode === "fresh") {
      replaceClientAccount({
        clientPhone: ticket.clientPhone, platform: ticket.platform, email: ticket.accountEmail,
        targetAccountId, wholesalerId: ticket.wholesalerId,
      });
      const row = db.prepare(`
        SELECT p.profile_name AS profileName, COALESCE(p.expires_override, a.expires_at) AS expiresAt
        FROM access_profiles p JOIN access_accounts a ON a.id = p.account_id
        WHERE p.account_id = ? AND substr(p.client_phone, -9) = ? ORDER BY p.id DESC LIMIT 1
      `).get(targetAccountId, last9(ticket.clientPhone)) as { profileName: string; expiresAt: string | null } | undefined;
      newProfile = row?.profileName || "";
      expiresAt = row?.expiresAt ?? null;
    } else {
      replaceClientAccountManual({
        clientPhone: ticket.clientPhone, platform: ticket.platform, email: ticket.accountEmail,
        wholesalerId: ticket.wholesalerId,
        newEmail: target.email, newPassword: target.password,
        newProfileName: profileName.trim().slice(0, 60), newProvider: target.provider || "",
      });
      const row = db.prepare(`
        SELECT profile_name AS profileName, expires_at AS expiresAt FROM manual_account_overrides
        WHERE substr(client_phone, -9) = ? AND platform = ? AND email = ? ORDER BY id DESC LIMIT 1
      `).get(last9(ticket.clientPhone), ticket.platform.toUpperCase(), target.email) as { profileName: string; expiresAt: string | null } | undefined;
      newProfile = row?.profileName || "";
      expiresAt = row?.expiresAt ?? null;
    }
  } catch (err: any) {
    return { ok: false, message: err?.message || "No se pudo reemplazar la cuenta." };
  }

  const message = replacementMessage({
    platform: ticket.platform, email: target.email, password: target.password,
    profileName: newProfile, expiresAt, temporary: mode === "shared",
  });
  const resolved = markSupportTicketResolved(id, "replaced", message);
  if (ticket.wholesalerId) {
    const detail = [
      `Cliente: ${String(ticket.clientPhone).replace(/\D/g, "").slice(-9)}`,
      `📧 Correo: ${target.email}`, `🔑 Contraseña: ${target.password}`,
      ...(newProfile ? [`👤 Perfil: ${newProfile}`] : []),
      ...(expiresAt ? [`📅 Vence: ${fmtDate(expiresAt)}`] : []),
    ].join("\n");
    createWholesalerNotification(ticket.wholesalerId, "account_replaced", ticket.platform, target.email, detail);
  }
  if (!ticket.wholesalerId) {
    const detail = [
      `📧 Correo: ${target.email}`, `🔑 Contraseña: ${target.password}`,
      ...(newProfile ? [`👤 Perfil: ${newProfile}`] : []),
      ...(expiresAt ? [`📅 Vence: ${fmtDate(expiresAt)}`] : []),
    ].join("\n");
    createCustomerNotification(ticket.clientPhone, "account_replaced", ticket.platform, target.email, detail);
  }
  return { ok: true, ticket: resolved ?? ticket, message };
}
