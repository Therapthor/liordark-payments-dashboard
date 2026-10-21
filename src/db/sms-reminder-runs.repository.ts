import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// CORRIDAS DE SMS DE VENCIMIENTO (panel > Renovaciones) — igual idea que
// reminder-runs.repository.ts (WhatsApp) pero para el canal SMS
// (ClickLab/Infobip). A diferencia de WhatsApp (tandas manuales de 5 por
// el bloqueador de pop-ups), acá un solo click manda a todos los
// pendientes del día — por eso el estado intermedio es "sending"
// (corrida en curso) en vez de "pending" (todavía no se mandó nada hoy).
// ─────────────────────────────────────────────────────────────

export type SmsReminderRunStatus = "pending" | "sending" | "incomplete" | "complete";

export type SmsReminderRun = {
  runDate:     string;
  sentCount:   number;
  failedCount: number;
  status:      SmsReminderRunStatus;
  startedAt:   string | null;
  completedAt: string | null;
};

/** Arranca (o reabre) la corrida del día — se llama apenas empieza el envío. */
export function startSmsReminderRun(runDate: string): void {
  db.prepare(`
    INSERT INTO sms_reminder_runs (run_date, status, started_at)
    VALUES (@runDate, 'sending', datetime('now'))
    ON CONFLICT(run_date) DO UPDATE SET status = 'sending', started_at = datetime('now')
  `).run({ runDate });
}

export function recordSmsReminderCounts(runDate: string, sent: number, failed: number): void {
  db.prepare(`
    UPDATE sms_reminder_runs SET sent_count = sent_count + @sent, failed_count = failed_count + @failed
    WHERE run_date = @runDate
  `).run({ runDate, sent, failed });
}

export function finishSmsReminderRun(runDate: string, status: "complete" | "incomplete"): void {
  db.prepare(`
    UPDATE sms_reminder_runs SET status = @status, completed_at = datetime('now') WHERE run_date = @runDate
  `).run({ runDate, status });
}

export function listSmsReminderRuns(limit: number): SmsReminderRun[] {
  return db.prepare(`
    SELECT run_date AS runDate, sent_count AS sentCount, failed_count AS failedCount, status,
           started_at AS startedAt, completed_at AS completedAt
    FROM sms_reminder_runs
    ORDER BY run_date DESC
    LIMIT @limit
  `).all({ limit }) as SmsReminderRun[];
}

export type SmsReminderLogEntry = {
  id:          number;
  clientPhone: string;
  platforms:   string;
  status:      "sent" | "failed";
  messageId:   string;
  error:       string;
  createdAt:   string;
};

export function logSmsReminderResult(entry: {
  runDate: string; clientPhone: string; platforms: string; status: "sent" | "failed"; messageId?: string; error?: string;
}): void {
  db.prepare(`
    INSERT INTO sms_reminder_log (run_date, client_phone, platforms, status, message_id, error)
    VALUES (@runDate, @clientPhone, @platforms, @status, @messageId, @error)
  `).run({
    runDate: entry.runDate, clientPhone: entry.clientPhone, platforms: entry.platforms,
    status: entry.status, messageId: entry.messageId || "", error: entry.error || "",
  });
}

/** Detalle de una corrida — quién recibió (o falló) el SMS ese día. */
export function listSmsReminderLogOn(runDate: string): SmsReminderLogEntry[] {
  return db.prepare(`
    SELECT id, client_phone AS clientPhone, platforms, status, message_id AS messageId, error, created_at AS createdAt
    FROM sms_reminder_log
    WHERE run_date = @runDate
    ORDER BY created_at ASC
  `).all({ runDate }) as SmsReminderLogEntry[];
}
