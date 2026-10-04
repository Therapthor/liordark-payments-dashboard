import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// CUENTAS COMPLETAS A PEDIDO — ver tables.sql (wholesale_full_account_orders).
// No sale de stock: el admin la prepara a mano (hasta 5 horas) y la
// entrega desde la cola del panel admin.
// ─────────────────────────────────────────────────────────────

export type FullAccountOrderStatus = "queued" | "prepared" | "delivered" | "cancelled";

export type FullAccountOrder = {
  id:                        number;
  wholesalerId:              number;
  platform:                  string;
  quantity:                  number;
  unitPriceCents:            number;
  totalCents:                number;
  endClientPhone:            string;
  status:                    FullAccountOrderStatus;
  dueBy:                     string;
  deliveredAccountEmail:     string;
  deliveredAccountPassword:  string;
  seenByWholesaler:          boolean;
  notes:                     string;
  createdAt:                 string;
  preparedAt:                string | null;
  deliveredAt:               string | null;
};

function toOrder(row: any): FullAccountOrder {
  return {
    id:                        row.id,
    wholesalerId:              row.wholesaler_id,
    platform:                  row.platform,
    quantity:                  row.quantity,
    unitPriceCents:            row.unit_price_cents,
    totalCents:                row.total_cents,
    endClientPhone:            row.end_client_phone,
    status:                    row.status,
    dueBy:                     row.due_by,
    deliveredAccountEmail:     row.delivered_account_email,
    deliveredAccountPassword:  row.delivered_account_password,
    seenByWholesaler:          !!row.seen_by_wholesaler,
    notes:                     row.notes,
    createdAt:                 row.created_at,
    preparedAt:                row.prepared_at,
    deliveredAt:               row.delivered_at,
  };
}

const DUE_HOURS = 5;

export function createFullAccountOrder(params: {
  wholesalerId: number; platform: string; quantity: number;
  unitPriceCents: number; endClientPhone: string;
}): FullAccountOrder {
  const totalCents = params.unitPriceCents * params.quantity;
  const dueBy = new Date(Date.now() + DUE_HOURS * 60 * 60 * 1000).toISOString();

  const info = db.prepare(`
    INSERT INTO wholesale_full_account_orders
      (wholesaler_id, platform, quantity, unit_price_cents, total_cents, end_client_phone, due_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(params.wholesalerId, params.platform.trim().toUpperCase(), params.quantity,
         params.unitPriceCents, totalCents, params.endClientPhone, dueBy);

  return getFullAccountOrderById(info.lastInsertRowid as number) as FullAccountOrder;
}

export function getFullAccountOrderById(id: number): FullAccountOrder | null {
  const row = db.prepare(`SELECT * FROM wholesale_full_account_orders WHERE id = ?`).get(id);
  return row ? toOrder(row) : null;
}

export function listFullAccountOrdersForWholesaler(wholesalerId: number): FullAccountOrder[] {
  const rows = db.prepare(`
    SELECT * FROM wholesale_full_account_orders WHERE wholesaler_id = ? ORDER BY created_at DESC
  `).all(wholesalerId);
  return rows.map(toOrder);
}

/** Cola completa para el admin — todo lo que no esté entregado/cancelado todavía. */
export function listPendingFullAccountQueue(): FullAccountOrder[] {
  const rows = db.prepare(`
    SELECT * FROM wholesale_full_account_orders WHERE status IN ('queued','prepared') ORDER BY due_by ASC
  `).all();
  return rows.map(toOrder);
}

export function markFullAccountPrepared(id: number, email: string, password: string): FullAccountOrder | null {
  db.prepare(`
    UPDATE wholesale_full_account_orders
    SET status = 'prepared', delivered_account_email = ?, delivered_account_password = ?, prepared_at = datetime('now')
    WHERE id = ? AND status = 'queued'
  `).run(email, password, id);
  return getFullAccountOrderById(id);
}

export function markFullAccountDelivered(id: number): FullAccountOrder | null {
  db.prepare(`
    UPDATE wholesale_full_account_orders
    SET status = 'delivered', delivered_at = datetime('now'), seen_by_wholesaler = 0
    WHERE id = ? AND status = 'prepared'
  `).run(id);
  return getFullAccountOrderById(id);
}

export function markFullAccountSeenByWholesaler(wholesalerId: number): void {
  db.prepare(`
    UPDATE wholesale_full_account_orders SET seen_by_wholesaler = 1
    WHERE wholesaler_id = ? AND seen_by_wholesaler = 0
  `).run(wholesalerId);
}

export function countUnseenFullAccountsForWholesaler(wholesalerId: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM wholesale_full_account_orders
    WHERE wholesaler_id = ? AND seen_by_wholesaler = 0 AND status = 'delivered'
  `).get(wholesalerId) as { n: number };
  return row.n;
}
