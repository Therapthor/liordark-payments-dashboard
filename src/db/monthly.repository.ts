import { db } from "./db";

export type MonthTotal = { month: string; total: number; count: number; updatedAt: string };

/** Guarda (o actualiza) el total ya calculado de un mes — el cálculo real vive en stats.service.ts. */
export function saveMonthTotal(month: string, total: number, count: number): MonthTotal {
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
