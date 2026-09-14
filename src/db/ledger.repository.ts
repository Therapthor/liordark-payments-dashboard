import { db } from "./db";

export type ManualEntry = {
  date:      string;
  amount:    number;
  note:      string;
  createdAt: string;
  updatedAt: string;
};

export function getManualEntry(date: string): ManualEntry | null {
  const row = db.prepare(`SELECT * FROM manual_ledger WHERE date = ?`).get(date) as any;
  return row ? toManualEntry(row) : null;
}

export function getAllManualEntries(): ManualEntry[] {
  return (db.prepare(`SELECT * FROM manual_ledger ORDER BY date DESC`).all() as any[])
    .map(toManualEntry);
}

export function upsertManualEntry(date: string, amount: number, note: string): void {
  db.prepare(`
    INSERT INTO manual_ledger (date, amount, note, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(date) DO UPDATE SET
      amount     = excluded.amount,
      note       = excluded.note,
      updated_at = datetime('now')
  `).run(date, amount, note);
}

export function deleteManualEntry(date: string): void {
  db.prepare(`DELETE FROM manual_ledger WHERE date = ?`).run(date);
}

function toManualEntry(row: any): ManualEntry {
  return {
    date:      row.date,
    amount:    row.amount,
    note:      row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
