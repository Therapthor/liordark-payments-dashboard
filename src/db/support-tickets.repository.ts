import { db } from "./db";
import { getCatalogProductByPlatform } from "./catalog.repository";

// ─────────────────────────────────────────────────────────────
// REPORTES DE SOPORTE — botón "Soporte" en Mis cuentas de liordark.com
// (todavía sin disparador real, ver public-store/js/app.js) → panel
// admin > Soportes, donde el admin los atiende. "Atender" nunca cambia
// el estado solo; hasta que no se toque "Marcar atendido" sigue pending.
// ─────────────────────────────────────────────────────────────

export type SupportTicketStatus = "pending" | "attended";

export type SupportTicket = {
  id:              number;
  clientPhone:     string;
  platform:        string;
  platformTag:     string;
  accountEmail:    string;
  accountPassword: string;
  provider:        string;
  problem:         string;
  status:          SupportTicketStatus;
  createdAt:       string;
  attendedAt:      string | null;
};

function toTicket(row: any): SupportTicket {
  return {
    id:              row.id,
    clientPhone:     row.client_phone,
    platform:        row.platform,
    platformTag:     getCatalogProductByPlatform(row.platform)?.title || row.platform,
    accountEmail:    row.account_email,
    accountPassword: row.account_password,
    provider:        row.provider,
    problem:         row.problem,
    status:          row.status,
    createdAt:       row.created_at,
    attendedAt:      row.attended_at,
  };
}

export function createSupportTicket(params: {
  clientPhone: string; platform: string; accountEmail: string;
  accountPassword: string; provider: string; problem: string;
}): SupportTicket {
  const info = db.prepare(`
    INSERT INTO support_tickets (client_phone, platform, account_email, account_password, provider, problem)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.clientPhone, params.platform.trim().toUpperCase(),
    params.accountEmail, params.accountPassword, params.provider, params.problem
  );
  return toTicket(db.prepare(`SELECT * FROM support_tickets WHERE id = ?`).get(info.lastInsertRowid));
}

/** Pendientes primero, más nuevos arriba dentro de cada grupo. */
export function listSupportTickets(limit = 200): SupportTicket[] {
  return (db.prepare(`
    SELECT * FROM support_tickets
    ORDER BY (status = 'pending') DESC, created_at DESC
    LIMIT ?
  `).all(limit) as any[]).map(toTicket);
}

export function countPendingSupportTickets(): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM support_tickets WHERE status = 'pending'`).get() as { n: number };
  return row.n;
}

export function countAttendedSupportTickets(): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM support_tickets WHERE status = 'attended'`).get() as { n: number };
  return row.n;
}

export function markSupportTicketAttended(id: number): SupportTicket | null {
  db.prepare(`
    UPDATE support_tickets SET status = 'attended', attended_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(id);
  const row = db.prepare(`SELECT * FROM support_tickets WHERE id = ?`).get(id);
  return row ? toTicket(row) : null;
}
