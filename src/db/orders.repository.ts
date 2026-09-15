import { db } from "./db";

export type ApprovedOrderRow = {
  id:        number;
  message:   string;
  createdAt: string;
};

/** Guarda una orden aprobada — el bot no las conserva una vez entregadas. */
export function insertApprovedOrder(message: string): number {
  const result = db.prepare(`
    INSERT INTO orders_log (message) VALUES (?)
  `).run(message);
  return result.lastInsertRowid as number;
}

export function getRecentApprovedOrders(limit: number): ApprovedOrderRow[] {
  return (db.prepare(`
    SELECT * FROM orders_log ORDER BY created_at DESC LIMIT ?
  `).all(limit) as any[]).map(row => ({
    id: row.id, message: row.message, createdAt: row.created_at,
  }));
}
