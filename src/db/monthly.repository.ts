import { db } from "./db";
import { getTotalForMonth } from "./payments.repository";

export type MonthTotal = { month: string; total: number; count: number; updatedAt: string };

/**
 * Recalcula el total real del mes (desde `payments`) y lo guarda —
 * nunca queda "congelado" mal si se corrige un dato viejo (siempre se
 * recalcula al pedirlo), pero queda persistido para tener historial
 * en vez de recomputar todo desde cero cada vez.
 */
export function refreshMonthTotal(month: string): MonthTotal {
  const { total, count } = getTotalForMonth(month);
  db.prepare(`
    INSERT INTO monthly_totals (month, total, count, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(month) DO UPDATE SET
      total      = excluded.total,
      count      = excluded.count,
      updated_at = datetime('now')
  `).run(month, total, count);

  return { month, total, count, updatedAt: new Date().toISOString() };
}

export function getStoredMonthTotal(month: string): MonthTotal | null {
  const row = db.prepare(`SELECT * FROM monthly_totals WHERE month = ?`).get(month) as any;
  return row ? { month: row.month, total: row.total, count: row.count, updatedAt: row.updated_at } : null;
}
