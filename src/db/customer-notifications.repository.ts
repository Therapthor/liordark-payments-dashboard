import { db } from "./db";
import { normalizePeruPhone } from "../utils/phone.util";
import { getCatalogProductByPlatform } from "./catalog.repository";

// ─────────────────────────────────────────────────────────────
// NOTIFICACIONES DEL CLIENTE (campanita en liordark.com) — cuenta nueva
// asignada, cuenta renovada, o reporte de soporte atendido. Se escriben
// desde sellProfile/createAccountFromRenewal (acá mismo, access.repository.ts),
// desde renewAccount (access.service.ts) y desde markSupportTicketAttended
// (support.routes.ts).
// ─────────────────────────────────────────────────────────────

export type CustomerNotificationType = "new_account" | "renewed" | "support_resolved" | "expiring" | "password_changed" | "account_replaced";

export type CustomerNotification = {
  id:          number;
  type:        CustomerNotificationType;
  platform:    string;
  accountEmail: string;
  message:     string;
  readAt:      string | null;
  createdAt:   string;
};

function last9(phone: string): string {
  return phone.replace(/\D/g, "").slice(-9);
}

function platformTitle(platform: string): string {
  return getCatalogProductByPlatform(platform)?.title || platform.trim();
}

function buildMessage(type: CustomerNotificationType, platform: string): string {
  const name = platformTitle(platform);
  if (type === "new_account") return `🎉 Tu cuenta de ${name} ya está lista. ¡Disfrútala!`;
  if (type === "expiring") return `⏰ Tu cuenta de ${name} vence pronto. Tócame para renovarla en "Mis cuentas".`;
  return `✅ Tu cuenta de ${name} fue renovada con éxito.`; // "renewed"
}

/** Encabezado fijo de "support_resolved" — avisa primero si hubo
 *  reemplazo de cuenta o fue soporte sin reemplazo, antes del mensaje
 *  que el admin haya dejado. */
function buildSupportResolvedHeadline(platform: string, replaced: boolean): string {
  const name = platformTitle(platform);
  return replaced
    ? `🔁 Tu cuenta de ${name} fue reemplazada.`
    : `🛟 Soporte realizado en tu cuenta de ${name}.`;
}

/** customMessage: el texto que escribió el admin al atender — en
 *  "support_resolved" va DESPUÉS del encabezado fijo (reemplazo o no),
 *  nunca lo reemplaza. En "password_changed" es la contraseña nueva. En
 *  "account_replaced" son los datos completos de la cuenta nueva (correo,
 *  contraseña, perfil, días restantes) — ver notify-replacement en
 *  access.routes.ts, que arma ese bloque; acá solo se le antepone el
 *  mismo encabezado fijo de "reemplazo" que usa support_resolved.
 *  replaced: si Soporte usó "Reemplazar" antes de atender este reporte
 *  (ver support.routes.ts). */
export function createCustomerNotification(
  clientPhone: string, type: CustomerNotificationType, platform: string, accountEmail = "", customMessage = "", replaced = false
): void {
  const digits = normalizePeruPhone(clientPhone);
  if (!digits || !platform) return;
  const message = type === "support_resolved"
    ? (customMessage.trim() ? `${buildSupportResolvedHeadline(platform, replaced)}\n\n${customMessage.trim()}` : buildSupportResolvedHeadline(platform, replaced))
    : type === "password_changed"
    ? `🔑 Tu cuenta de ${platformTitle(platform)} tiene una contraseña nueva: ${customMessage}`
    : type === "account_replaced"
    ? `${buildSupportResolvedHeadline(platform, true)}\n\n${customMessage}`
    : buildMessage(type, platform);
  db.prepare(`
    INSERT INTO customer_notifications (client_phone, type, platform, account_email, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(digits, type, platform, accountEmail, message);
}

/** Varios clientes de una (ej. todos los que comparten una cuenta recién renovada). */
export function createCustomerNotifications(entries: {
  clientPhone: string; type: CustomerNotificationType; platform: string; accountEmail?: string;
}[]): void {
  if (entries.length === 0) return;
  const run = db.transaction((rows: typeof entries) => {
    for (const r of rows) createCustomerNotification(r.clientPhone, r.type, r.platform, r.accountEmail || "");
  });
  run(entries);
}

export function listCustomerNotifications(phone: string, limit = 20): CustomerNotification[] {
  return (db.prepare(`
    SELECT * FROM customer_notifications WHERE substr(client_phone, -9) = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(last9(phone), limit) as any[]).map(row => ({
    id:           row.id,
    type:         row.type,
    platform:     row.platform,
    accountEmail: row.account_email || "",
    message:      row.message,
    readAt:       row.read_at,
    createdAt:    row.created_at,
  }));
}

export function countUnreadCustomerNotifications(phone: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM customer_notifications WHERE substr(client_phone, -9) = ? AND read_at IS NULL
  `).get(last9(phone)) as { n: number };
  return row.n;
}

export function markAllCustomerNotificationsRead(phone: string): void {
  db.prepare(`
    UPDATE customer_notifications SET read_at = datetime('now')
    WHERE substr(client_phone, -9) = ? AND read_at IS NULL
  `).run(last9(phone));
}

/** Tachito de la campanita — borra todo el historial de este cliente. */
export function deleteAllCustomerNotifications(phone: string): void {
  db.prepare(`DELETE FROM customer_notifications WHERE substr(client_phone, -9) = ?`).run(last9(phone));
}
