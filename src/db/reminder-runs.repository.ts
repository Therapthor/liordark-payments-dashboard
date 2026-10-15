import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// CORRIDAS DE RECORDATORIOS (panel > Renovaciones) — una fila por día,
// reemplaza el historial que antes venía del bot de Meta. Se actualiza
// cada vez que el admin manda una tanda manual (ver renewals.routes.ts).
// ─────────────────────────────────────────────────────────────

export type ReminderRunStatus = "pending" | "incomplete" | "complete";

export type ReminderRun = {
  runDate:     string;
  sentCount:   number;
  status:      ReminderRunStatus;
  lastSentAt:  string | null;
  completedAt: string | null;
};

/** Suma 1 al contador de hoy (crea la fila si todavía no existe). */
export function recordReminderSent(runDate: string): void {
  db.prepare(`
    INSERT INTO reminder_runs (run_date, sent_count, status, last_sent_at)
    VALUES (@runDate, 1, 'incomplete', datetime('now'))
    ON CONFLICT(run_date) DO UPDATE SET
      sent_count   = sent_count + 1,
      last_sent_at = datetime('now')
  `).run({ runDate });
}

/** Marca el estado de la corrida de ese día (se recalcula después de cada tanda, ver renewals.routes.ts). */
export function setReminderRunStatus(runDate: string, status: ReminderRunStatus): void {
  db.prepare(`
    INSERT INTO reminder_runs (run_date, status, completed_at)
    VALUES (@runDate, @status, CASE WHEN @status = 'complete' THEN datetime('now') ELSE NULL END)
    ON CONFLICT(run_date) DO UPDATE SET
      status       = @status,
      completed_at = CASE WHEN @status = 'complete' THEN datetime('now') ELSE completed_at END
  `).run({ runDate, status });
}

export function listReminderRuns(limit: number): ReminderRun[] {
  return db.prepare(`
    SELECT run_date AS runDate, sent_count AS sentCount, status,
           last_sent_at AS lastSentAt, completed_at AS completedAt
    FROM reminder_runs
    ORDER BY run_date DESC
    LIMIT @limit
  `).all({ limit }) as ReminderRun[];
}
