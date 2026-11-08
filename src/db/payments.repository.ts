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

/** Devuelve true si el pago no existía (recién insertado) — false si ya estaba y solo se actualizó. */
export function upsertPayment(p: {
  id:           number;
  senderName:   string;
  amount:       string;
  securityCode: string;
  hasCode:      boolean;
  status:       string;
  orderName?:   string | undefined;
  createdAt:    string;
}): boolean {
  if (isFakePayment(p.id, p.senderName)) return false; // pago falso: nunca se guarda
  const existing = db.prepare(`SELECT 1 FROM payments WHERE id = ?`).get(p.id);

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

  return !existing;
}

// ─── Pagos falsos del ataque del 8-nov-2026 ───
// Avisos de Yape inventados (nunca entró ese dinero). No cuentan en la
// contabilidad: se borran al arrancar y la sincronización con el bot
// nunca los vuelve a traer.
const FAKE_PAYMENT_IDS = new Set([2407, 2408, 2409, 2410, 2411, 2412, 2413]);
const FAKE_SENDERS = new Set(["TEST CYBERSTRIKE", "TEST2", "MULTI", "MATCHTEST", "PROBE NONEXIST"]);

export function isFakePayment(id: number, senderName: string): boolean {
  return FAKE_PAYMENT_IDS.has(id) && FAKE_SENDERS.has(String(senderName || "").trim().toUpperCase());
}

/** Borra los pagos falsos y los «pedidos aprobados» del atacante. */
export function removeFakePayments(): { payments: number; orders: number } {
  const ids = [...FAKE_PAYMENT_IDS];
  const rows = db.prepare(`SELECT id, sender_name AS s FROM payments WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as { id: number; s: string }[];
  let payments = 0;
  for (const r of rows) {
    if (isFakePayment(r.id, r.s)) payments += db.prepare(`DELETE FROM payments WHERE id = ?`).run(r.id).changes;
  }
  const orders = db.prepare(`DELETE FROM orders_log WHERE message LIKE '%51902524991%'`).run().changes;
  return { payments, orders };
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

/** Total real (de `payments`) agrupado por mes, para el histórico completo. */
export function getAllMonthTotals(): { month: string; total: number; count: number }[] {
  return db.prepare(`
    SELECT strftime('%Y-%m', datetime(created_at, ?)) AS month,
           SUM(CAST(amount AS REAL)) AS total,
           COUNT(*) AS count
    FROM payments
    GROUP BY month
    ORDER BY month DESC
  `).all(LIMA_OFFSET) as { month: string; total: number; count: number }[];
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
