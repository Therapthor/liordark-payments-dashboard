import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// PENDIENTES DE CUENTA NUEVA (Accesos) — ver db.ts. Clientes que ya
// pagaron su renovación pero se quedaron sin cupo: su cuenta no convenía
// renovarse y no había otra cuenta con cupo que les durara hasta su fecha.
// ─────────────────────────────────────────────────────────────

export type PendingAssignment = {
  id:           number;
  platform:     string;
  clientPhone:  string;
  wholesalerId: number | null;
  profileName:  string;
  expiresAt:    string;
  fromEmail:    string;
  createdAt:    string;
};

function toPending(row: any): PendingAssignment {
  return {
    id:           row.id,
    platform:     row.platform,
    clientPhone:  row.client_phone,
    wholesalerId: row.wholesaler_id ?? null,
    profileName:  row.profile_name,
    expiresAt:    row.expires_at,
    fromEmail:    row.from_email,
    createdAt:    row.created_at,
  };
}

export function createPendingAssignment(params: {
  platform: string; clientPhone: string; wholesalerId: number | null;
  profileName: string; expiresAt: string; fromEmail: string;
}): void {
  db.prepare(`
    INSERT INTO pending_account_assignments (platform, client_phone, wholesaler_id, profile_name, expires_at, from_email)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(params.platform.trim().toUpperCase(), params.clientPhone, params.wholesalerId,
         params.profileName, params.expiresAt, params.fromEmail);
}

export function listPendingAssignments(): PendingAssignment[] {
  return (db.prepare(`
    SELECT * FROM pending_account_assignments WHERE assigned_at IS NULL ORDER BY expires_at ASC, id ASC
  `).all() as any[]).map(toPending);
}

export function countPendingAssignments(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM pending_account_assignments WHERE assigned_at IS NULL`).get() as { n: number }).n;
}

export function markPendingAssigned(id: number, accountId: number): void {
  db.prepare(`
    UPDATE pending_account_assignments SET assigned_at = datetime('now'), assigned_account_id = ? WHERE id = ?
  `).run(accountId, id);
}
