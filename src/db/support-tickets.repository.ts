import { db } from "./db";
import { getCatalogProductByPlatform } from "./catalog.repository";
import { findWholesalerById } from "./wholesaler.repository";

// ─────────────────────────────────────────────────────────────
// REPORTES DE SOPORTE — botón "Soporte" en Mis cuentas de liordark.com
// (de prueba, solo para un celular — ver store.routes.ts), o del mayorista
// a nombre de uno de sus propios clientes (ver wholesaler.routes.ts) →
// panel admin > Soportes, donde el admin los junta y atiende a todos.
//
// 3 estados: pending (recién enviado) → seen (el admin abrió el modal
// "Atender" al menos una vez, ver markSupportTicketSeen) → attended
// (tocó "Marcar atendido" — el único botón que cierra el reporte).
// Abrir el modal nunca lo cierra solo.
// ─────────────────────────────────────────────────────────────

export type SupportTicketStatus = "pending" | "seen" | "attended";

export type SupportTicket = {
  id:              number;
  clientPhone:     string;
  wholesalerId:    number | null; // null = lo reportó un cliente de liordark.com
  wholesalerName:  string;        // "" si no es de mayorista
  platform:        string;
  platformTag:     string;
  accountEmail:    string;
  accountPassword: string;
  provider:        string;
  problem:         string;
  status:          SupportTicketStatus;
  resolutionMessage: string;
  createdAt:       string;
  attendedAt:      string | null;
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
    provider:        row.provider,
    problem:         row.problem,
    status:          row.status,
    resolutionMessage: row.resolution_message || "",
    createdAt:       row.created_at,
    attendedAt:      row.attended_at,
  };
}

export function createSupportTicket(params: {
  clientPhone: string; wholesalerId?: number | null; platform: string; accountEmail: string;
  accountPassword: string; provider: string; problem: string;
}): SupportTicket {
  const info = db.prepare(`
    INSERT INTO support_tickets (client_phone, wholesaler_id, platform, account_email, account_password, provider, problem)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.clientPhone, params.wholesalerId ?? null, params.platform.trim().toUpperCase(),
    params.accountEmail, params.accountPassword, params.provider, params.problem
  );
  return toTicket(db.prepare(`SELECT * FROM support_tickets WHERE id = ?`).get(info.lastInsertRowid));
}

export function getSupportTicketById(id: number): SupportTicket | null {
  const row = db.prepare(`SELECT * FROM support_tickets WHERE id = ?`).get(id);
  return row ? toTicket(row) : null;
}

/** Pendientes y vistos primero, más nuevos arriba dentro de cada grupo. */
export function listSupportTickets(limit = 200): SupportTicket[] {
  return (db.prepare(`
    SELECT * FROM support_tickets
    ORDER BY (status = 'attended') ASC, created_at DESC
    LIMIT ?
  `).all(limit) as any[]).map(toTicket);
}

/** Reportes de ESTE cliente de liordark.com — para que "Mis cuentas" sepa
 *  qué mostrar en el botón "Soporte" de cada tarjeta (enviado/en
 *  revisión/resuelto). Solo retail: excluye los de mayorista. */
export function listSupportTicketsForClient(phone: string): SupportTicket[] {
  const digits = phone.replace(/\D/g, "").slice(-9);
  return (db.prepare(`
    SELECT * FROM support_tickets WHERE substr(client_phone, -9) = ? AND wholesaler_id IS NULL
    ORDER BY created_at DESC
  `).all(digits) as any[]).map(toTicket);
}

/** Todos los reportes que ESTE mayorista presentó a nombre de sus
 *  clientes — para que "Clientes" sepa qué mostrar en el botón "Soporte"
 *  de cada tarjeta. */
export function listSupportTicketsForWholesaler(wholesalerId: number): SupportTicket[] {
  return (db.prepare(`
    SELECT * FROM support_tickets WHERE wholesaler_id = ?
    ORDER BY created_at DESC
  `).all(wholesalerId) as any[]).map(toTicket);
}

export function countPendingSupportTickets(): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM support_tickets WHERE status IN ('pending', 'seen')
  `).get() as { n: number };
  return row.n;
}

export function countAttendedSupportTickets(): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM support_tickets WHERE status = 'attended'`).get() as { n: number };
  return row.n;
}

/** El admin abrió el modal "Atender" — solo avanza pending→seen, nunca pisa attended. */
export function markSupportTicketSeen(id: number): SupportTicket | null {
  db.prepare(`UPDATE support_tickets SET status = 'seen' WHERE id = ? AND status = 'pending'`).run(id);
  const row = db.prepare(`SELECT * FROM support_tickets WHERE id = ?`).get(id);
  return row ? toTicket(row) : null;
}

export function markSupportTicketAttended(id: number, resolutionMessage = ""): SupportTicket | null {
  db.prepare(`
    UPDATE support_tickets SET status = 'attended', attended_at = datetime('now'), resolution_message = ?
    WHERE id = ? AND status IN ('pending', 'seen')
  `).run(resolutionMessage.trim(), id);
  const row = db.prepare(`SELECT * FROM support_tickets WHERE id = ?`).get(id);
  return row ? toTicket(row) : null;
}
