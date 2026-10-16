import { db } from "./db";
import { normalizePeruPhone } from "../utils/phone.util";
import { getCatalogProductByPlatform } from "./catalog.repository";

// ─────────────────────────────────────────────────────────────
// NOTIFICACIONES DEL CLIENTE (campanita en liordark.com) — solo dos
// eventos: le asignaron una cuenta nueva, o le renovaron una que ya
// tenía. Se escriben desde sellProfile/createAccountFromRenewal (acá
// mismo, access.repository.ts) y desde renewAccount (access.service.ts).
// ─────────────────────────────────────────────────────────────

export type CustomerNotificationType = "new_account" | "renewed";

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
  return type === "new_account"
    ? `🎉 Tu cuenta de ${name} ya está lista. ¡Disfrútala!`
    : `✅ Tu cuenta de ${name} fue renovada con éxito.`;
}

export function createCustomerNotification(
  clientPhone: string, type: CustomerNotificationType, platform: string, accountEmail = ""
): void {
  const digits = normalizePeruPhone(clientPhone);
  if (!digits || !platform) return;
  db.prepare(`
    INSERT INTO customer_notifications (client_phone, type, platform, account_email, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(digits, type, platform, accountEmail, buildMessage(type, platform));
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
