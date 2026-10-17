import { db } from "./db";
import { getCatalogProductByPlatform } from "./catalog.repository";

// ─────────────────────────────────────────────────────────────
// NOTIFICACIONES DEL MAYORISTA (campanita en mayorista.liordark.com) —
// mismo criterio que customer-notifications.repository.ts: se le añadió
// una compra a su registro (sellProfileForWholesaler /
// createManualActivationForWholesaler), una cuenta completa a pedido ya
// se le entregó (markFullAccountDelivered), un sub-cliente suyo vence en
// 1 día (generado al pedir GET /notifications, ver wholesaler.routes.ts),
// o un reporte de soporte que presentó a nombre de un cliente ya fue
// atendido (ver support.routes.ts).
// ─────────────────────────────────────────────────────────────

export type WholesalerNotificationType = "purchase_added" | "full_account_ready" | "client_expiring" | "support_resolved";

export type WholesalerNotification = {
  id:           number;
  type:         WholesalerNotificationType;
  platform:     string;
  accountEmail: string;
  message:      string;
  readAt:       string | null;
  createdAt:    string;
};

function platformTitle(platform: string): string {
  return getCatalogProductByPlatform(platform)?.title || platform.trim();
}

function buildMessage(type: WholesalerNotificationType, platform: string): string {
  const name = platformTitle(platform);
  if (type === "purchase_added")      return `🛒 Se agregó tu compra de ${name} a tu registro.`;
  if (type === "full_account_ready")  return `🎉 Tu cuenta completa de ${name} ya está lista.`;
  if (type === "support_resolved")    return `🛟 Tu reporte de soporte sobre ${name} fue atendido.`;
  return `⏰ Un cliente tuyo de ${name} vence mañana.`;
}

/** customMessage: para "support_resolved", el texto que escribió el admin
 *  al atender — reemplaza el mensaje automático. */
export function createWholesalerNotification(
  wholesalerId: number, type: WholesalerNotificationType, platform: string, accountEmail = "", customMessage = ""
): void {
  if (!wholesalerId || !platform) return;
  db.prepare(`
    INSERT INTO wholesaler_notifications (wholesaler_id, type, platform, account_email, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(wholesalerId, type, platform, accountEmail, customMessage.trim() || buildMessage(type, platform));
}

export function listWholesalerNotifications(wholesalerId: number, limit = 20): WholesalerNotification[] {
  return (db.prepare(`
    SELECT * FROM wholesaler_notifications WHERE wholesaler_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(wholesalerId, limit) as any[]).map(row => ({
    id:           row.id,
    type:         row.type,
    platform:     row.platform,
    accountEmail: row.account_email || "",
    message:      row.message,
    readAt:       row.read_at,
    createdAt:    row.created_at,
  }));
}

export function countUnreadWholesalerNotifications(wholesalerId: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM wholesaler_notifications WHERE wholesaler_id = ? AND read_at IS NULL
  `).get(wholesalerId) as { n: number };
  return row.n;
}

export function markAllWholesalerNotificationsRead(wholesalerId: number): void {
  db.prepare(`
    UPDATE wholesaler_notifications SET read_at = datetime('now')
    WHERE wholesaler_id = ? AND read_at IS NULL
  `).run(wholesalerId);
}
