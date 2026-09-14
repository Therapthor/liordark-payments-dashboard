import { db } from "./db";

// Lima es UTC-5 fijo, sin horario de verano — igual que en el bot principal.
const LIMA_OFFSET = "-5 hours";

export type PaymentRow = {
  id:           number;
  senderName:   string;
  amount:       string;
  securityCode: string;
  hasCode:      boolean;
  status:       string;
  orderName:    string;
  createdAt:    string;
};

export function upsertPayment(p: {
  id:           number;
  senderName:   string;
  amount:       string;
  securityCode: string;
  hasCode:      boolean;
  status:       string;
  orderName?:   string | undefined;
  createdAt:    string;
}): void {
  db.prepare(`
    INSERT INTO payments (id, sender_name, amount, security_code, has_code, status, order_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status     = excluded.status,
      order_name = excluded.order_name
  `).run(
    p.id, p.senderName, p.amount, p.securityCode,
    p.hasCode ? 1 : 0, p.status, p.orderName ?? "", p.createdAt
  );
}

export function updatePaymentStatus(id: number, status: string): void {
  db.prepare(`UPDATE payments SET status = ? WHERE id = ?`).run(status, id);
}

export function getRecentPayments(limit: number): PaymentRow[] {
  return (db.prepare(`
    SELECT * FROM payments ORDER BY created_at DESC LIMIT ?
  `).all(limit) as any[]).map(toPaymentRow);
}

/** Busca pagos por código de seguridad de 3 dígitos (coincidencia exacta). */
export function searchByCode(code: string): PaymentRow[] {
  return (db.prepare(`
    SELECT * FROM payments WHERE security_code = ? ORDER BY created_at DESC LIMIT 50
  `).all(code) as any[]).map(toPaymentRow);
}

export function getDayPayments(date: string): PaymentRow[] {
  return (db.prepare(`
    SELECT * FROM payments
    WHERE date(created_at, ?) = ?
    ORDER BY created_at DESC
  `).all(LIMA_OFFSET, date) as any[]).map(toPaymentRow);
}

export type DayTotal = { date: string; total: number; count: number };

export function getDailyTotals(sinceDaysAgo: number): DayTotal[] {
  return db.prepare(`
    SELECT date(created_at, ?) AS date,
           SUM(CAST(amount AS REAL)) AS total,
           COUNT(*) AS count
    FROM payments
    WHERE created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY date
    ORDER BY date DESC
  `).all(LIMA_OFFSET, sinceDaysAgo) as DayTotal[];
}

export function getTotalForDate(date: string): DayTotal | null {
  const row = db.prepare(`
    SELECT date(created_at, ?) AS date,
           SUM(CAST(amount AS REAL)) AS total,
           COUNT(*) AS count
    FROM payments
    WHERE date(created_at, ?) = ?
    GROUP BY date
  `).get(LIMA_OFFSET, LIMA_OFFSET, date) as DayTotal | undefined;
  return row ?? null;
}

export function getTotalForMonth(yearMonth: string): DayTotal {
  const row = db.prepare(`
    SELECT SUM(CAST(amount AS REAL)) AS total, COUNT(*) AS count
    FROM payments
    WHERE strftime('%Y-%m', datetime(created_at, ?)) = ?
  `).get(LIMA_OFFSET, yearMonth) as { total: number | null; count: number };
  return { date: yearMonth, total: row.total ?? 0, count: row.count ?? 0 };
}

export function getAllTimeTotal(): DayTotal {
  const row = db.prepare(`
    SELECT SUM(CAST(amount AS REAL)) AS total, COUNT(*) AS count FROM payments
  `).get() as { total: number | null; count: number };
  return { date: "all", total: row.total ?? 0, count: row.count ?? 0 };
}

export function getLatestSyncedCreatedAt(): string | null {
  const row = db.prepare(`SELECT MAX(created_at) AS m FROM payments`).get() as { m: string | null };
  return row.m;
}

function toPaymentRow(row: any): PaymentRow {
  return {
    id:           row.id,
    senderName:   row.sender_name,
    amount:       row.amount,
    securityCode: row.security_code,
    hasCode:      row.has_code === 1,
    status:       row.status,
    orderName:    row.order_name ?? "",
    createdAt:    row.created_at,
  };
}
