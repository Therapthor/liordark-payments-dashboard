import { db } from "./db";
import { getCatalogProductByPlatform } from "./catalog.repository";
import { findWholesalerById } from "./wholesaler.repository";

// ─────────────────────────────────────────────────────────────
// SOPORTES — reportes «sin suscripción» que el cliente manda desde el
// asistente de liordark.com (solo botones, sin chat) → panel > Soportes.
//
// Estados: pending (recién enviado) → seen (el admin tocó «En revisión»)
// → attended (resuelto: resolution = 'active' si la cuenta sí tenía
// suscripción, 'replaced' si se le cambió la cuenta).
// Un cliente no puede reportar la misma cuenta mientras su reporte siga
// abierto (ver findOpenTicketForAccount).
// ─────────────────────────────────────────────────────────────

export type SupportTicketStatus = "pending" | "seen" | "attended";
export type SupportTicketResolution = "" | "active" | "replaced";

export type SupportTicket = {
  id:              number;
  clientPhone:     string;
  wholesalerId:    number | null; // null = lo reportó un cliente de liordark.com
  wholesalerName:  string;
  platform:        string;
  platformTag:     string;
  accountEmail:    string;
  accountPassword: string;
  profileName:     string;
  provider:        string;
  problem:         string;
  status:          SupportTicketStatus;
  resolution:      SupportTicketResolution;
  resolutionMessage: string;
  createdAt:       string;
  reviewedAt:      string | null;
  attendedAt:      string | null;
  replacedAt:      string | null;
};

function toTicket(row: any): SupportTicket {
  return {
    id:              row.id,
    clientPhone:     row.client_phone,
    wholesalerId:    row.wholesaler_id,
    wholesalerName:  row.wholesaler_id ? (findWholesalerById(row.wholesaler_id)?.displayName || "") : "",
    platform:        row.platform,
    platformTag:     getCatalogProductByPlatform(row.platform)?.title || row.platform,
    accountEmail:    row.account_email,
    accountPassword: row.account_password,
    profileName:     row.profile_name || "",
    provider:        row.provider,
    problem:         row.problem,
    status:          row.status,
    resolution:      row.resolution || "",
    resolutionMessage: row.resolution_message || "",
    createdAt:       row.created_at,
    reviewedAt:      row.reviewed_at ?? null,
    attendedAt:      row.attended_at,
    replacedAt:      row.replaced_at,
  };
}

function last9(phone: string): string {
  return String(phone || "").replace(/\D/g, "").slice(-9);
}

export function createSupportTicket(params: {
  clientPhone: string; wholesalerId?: number | null; platform: string; accountEmail: string;
  accountPassword: string; profileName?: string; provider: string; problem: string;
}): SupportTicket {
  const info = db.prepare(`
    INSERT INTO support_tickets (client_phone, wholesaler_id, platform, account_email, account_password, profile_name, provider, problem)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.clientPhone, params.wholesalerId ?? null, params.platform.trim().toUpperCase(),
    params.accountEmail, params.accountPassword, params.profileName ?? "", params.provider, params.problem
  );
  return toTicket(db.prepare(`SELECT * FROM support_tickets WHERE id = ?`).get(info.lastInsertRowid));
}

export function getSupportTicketById(id: number): SupportTicket | null {
  const row = db.prepare(`SELECT * FROM support_tickets WHERE id = ?`).get(id);
  return row ? toTicket(row) : null;
}

/** Abiertos primero (más viejos arriba: se atienden en orden), luego los
 *  resueltos más recientes. */
export function listSupportTickets(limit = 300): SupportTicket[] {
  return (db.prepare(`
    SELECT * FROM support_tickets
    ORDER BY (status = 'attended') ASC,
             CASE WHEN status = 'attended' THEN 0 ELSE julianday(created_at) END ASC,
             COALESCE(attended_at, created_at) DESC
    LIMIT ?
  `).all(limit) as any[]).map(toTicket);
}

/** Reporte abierto (pendiente o en revisión) de ESTA cuenta de ESTE cliente. */
export function findOpenTicketForAccount(phone: string, platform: string, email: string): SupportTicket | null {
  const row = db.prepare(`
    SELECT * FROM support_tickets
    WHERE substr(client_phone, -9) = ? AND wholesaler_id IS NULL
      AND platform = ? AND lower(account_email) = lower(?) AND status IN ('pending', 'seen')
    ORDER BY id DESC LIMIT 1
  `).get(last9(phone), platform.trim().toUpperCase(), email.trim());
  return row ? toTicket(row) : null;
}

/** Reportes de hoy (hora Lima) de este cliente — tope anti-spam. */
export function countTicketsTodayForClient(phone: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM support_tickets
    WHERE substr(client_phone, -9) = ? AND wholesaler_id IS NULL
      AND date(created_at, '-5 hours') = date('now', '-5 hours')
  `).get(last9(phone)) as { n: number };
  return row.n;
}

export function countPendingSupportTickets(): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM support_tickets WHERE status IN ('pending', 'seen')
  `).get() as { n: number };
  return row.n;
}

/** «En revisión» — solo avanza pending→seen, nunca reabre uno resuelto. */
export function markSupportTicketSeen(id: number): SupportTicket | null {
  db.prepare(`
    UPDATE support_tickets SET status = 'seen', reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'
  `).run(id);
  return getSupportTicketById(id);
}

export function markSupportTicketResolved(
  id: number, resolution: Exclude<SupportTicketResolution, "">, message: string
): SupportTicket | null {
  db.prepare(`
    UPDATE support_tickets
    SET status = 'attended', attended_at = datetime('now'), resolution = ?, resolution_message = ?,
        replaced_at = CASE WHEN ? = 'replaced' THEN datetime('now') ELSE replaced_at END
    WHERE id = ?
  `).run(resolution, message.trim(), resolution, id);
  return getSupportTicketById(id);
}
