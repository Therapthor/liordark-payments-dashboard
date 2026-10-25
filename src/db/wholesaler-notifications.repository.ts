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

export type WholesalerNotificationType = "purchase_added" | "full_account_ready" | "client_expiring" | "support_resolved" | "password_changed";

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
  return `⏰ Un cliente tuyo de ${name} vence mañana.`; // "client_expiring"
}

/** Encabezado fijo de "support_resolved" — avisa primero si hubo
 *  reemplazo de cuenta o fue soporte sin reemplazo, antes del mensaje
 *  que el admin haya dejado. */
function buildSupportResolvedHeadline(platform: string, replaced: boolean): string {
  const name = platformTitle(platform);
  return replaced
    ? `🔁 La cuenta de ${name} de tu cliente fue reemplazada.`
    : `🛟 Soporte realizado en la cuenta de ${name} de tu cliente.`;
}

/** customMessage: el texto que escribió el admin al atender — en
 *  "support_resolved" va DESPUÉS del encabezado fijo (reemplazo o no),
 *  nunca lo reemplaza. En "password_changed" es la contraseña nueva.
 *  replaced: si Soporte usó "Reemplazar" antes de atender este reporte
 *  (ver support.routes.ts). */
export function createWholesalerNotification(
  wholesalerId: number, type: WholesalerNotificationType, platform: string, accountEmail = "", customMessage = "", replaced = false
): void {
  if (!wholesalerId || !platform) return;
  const message = type === "support_resolved"
    ? (customMessage.trim() ? `${buildSupportResolvedHeadline(platform, replaced)}\n\n${customMessage.trim()}` : buildSupportResolvedHeadline(platform, replaced))
    : type === "password_changed"
    ? `🔑 La cuenta de ${platformTitle(platform)} de tu cliente tiene una contraseña nueva: ${customMessage}`
    : buildMessage(type, platform);
  db.prepare(`
    INSERT INTO wholesaler_notifications (wholesaler_id, type, platform, account_email, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(wholesalerId, type, platform, accountEmail, message);
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
