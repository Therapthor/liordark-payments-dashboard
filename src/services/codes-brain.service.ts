import { db } from "../db/db";
import {
  onLookup, withLookupContext, lookupCode, fetchListedEmail, codeSourceLabel, listCodeSources,
  isAccountChangeResult, parseProviderDate, sanitizeEmailHtml, LIST_SOURCES, TOTP_SOURCE_ID,
  type LookupEvent, type CodeLookupResult, type ListedEmail,
} from "./codes-lookup.service";
import { listCodesEnabledAccounts } from "../db/codes.repository";
import { emitDashboardEvent } from "../utils/live-events.util";

// ─────────────────────────────────────────────────────────────
// CEREBRO DE CÓDIGOS
//  · Registro: cada consulta a un proveedor queda anotada con lo que de
//    verdad pasó (llegó / aún no llega / el correo no es de esa fuente /
//    sesión vencida / proveedor con error / sin conexión) y el mensaje que
//    mostró su página. Antes todo eso se veía igual: «esperando».
//  · Bandeja: todo correo con código que pase por cualquier consulta
//    (cliente, panel, asistente o vigilante) queda guardado, el más nuevo
//    arriba, para no perderse ninguno.
//  · Vigilante: las fuentes que listan TODOS los correos recientes
//    (Gralexander / latinocol) se revisan solas cada 2 minutos.
//  · Salud: por fuente, cuándo respondió bien por última vez y su último
//    error, para saber al toque si un proveedor se cayó.
// ─────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS code_lookup_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT    NOT NULL DEFAULT (datetime('now')),
    source_id  TEXT    NOT NULL,
    email      TEXT    NOT NULL,
    account_id INTEGER,
    origin     TEXT    NOT NULL,
    status     TEXT    NOT NULL,  -- found | not_found | wrong_source | session | provider | network | timeout | client_waiting
    message    TEXT    NOT NULL DEFAULT '',
    value      TEXT    NOT NULL DEFAULT '',
    relogged   INTEGER NOT NULL DEFAULT 0,
    ms         INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_code_lookup_log_at ON code_lookup_log(at);
  CREATE INDEX IF NOT EXISTS idx_code_lookup_log_source ON code_lookup_log(source_id, at);

  CREATE TABLE IF NOT EXISTS code_inbox (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id            TEXT    NOT NULL,
    email                TEXT    NOT NULL,
    account_id           INTEGER,
    platform             TEXT    NOT NULL DEFAULT '',
    subject              TEXT    NOT NULL DEFAULT '',
    kind                 TEXT    NOT NULL DEFAULT '',  -- code | link | '' (correo sin código)
    value                TEXT    NOT NULL DEFAULT '',
    provider_ref         TEXT    NOT NULL DEFAULT '',
    provider_received_at TEXT    NOT NULL DEFAULT '',
    received_iso         TEXT,
    expired              INTEGER NOT NULL DEFAULT 0,
    account_change       INTEGER NOT NULL DEFAULT 0,
    email_html           TEXT,
    origin               TEXT    NOT NULL DEFAULT '',
    first_seen_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_id, email, provider_ref, provider_received_at, value)
  );
  CREATE INDEX IF NOT EXISTS idx_code_inbox_seen ON code_inbox(first_seen_at);
`);

export type LookupStatus =
  | "found" | "not_found" | "wrong_source" | "session" | "provider" | "network" | "timeout" | "client_waiting";

// El proveedor dice que ese correo no es suyo: la cuenta tiene mal la fuente.
const WRONG_SOURCE_RE = /(no est[aá] vinculad|no registrad|no pertenece|no existe (el|este) correo|correo no (v[aá]lido|encontrado|autorizado)|no tienes acceso a este correo)/i;

function statusOf(e: LookupEvent): LookupStatus {
  if (e.error) return e.error.kind === "session" ? "session" : e.error.kind;
  if (e.result?.found) return "found";
  if (e.result?.providerMessage && WRONG_SOURCE_RE.test(e.result.providerMessage)) return "wrong_source";
  return "not_found";
}

function messageOf(e: LookupEvent, status: LookupStatus): string {
  if (e.error) return e.error.message;
  const r = e.result!;
  const relog = r.relogged ? "Sesión renovada sola · " : "";
  if (status === "found") {
    const what = r.kind === "link" ? "enlace" : "código " + (r.value ?? "");
    return relog + `Llegó ${what}` + (r.subject ? ` («${r.subject}»)` : "") + (r.expired ? " — caducado" : "");
  }
  return relog + (r.providerMessage || "El proveedor aún no tiene ningún correo nuevo.");
}

// ── Salud por fuente (en memoria; se arma de nuevo con el uso) ──

type Health = {
  lastOkAt: number | null;      // última respuesta sin error
  lastFoundAt: number | null;   // último código encontrado
  lastError: { at: number; kind: string; message: string } | null;
  recent: { at: number; ok: boolean }[];
};
const health = new Map<string, Health>();

function touchHealth(sourceId: string, ok: boolean, status: LookupStatus, message: string): void {
  const h = health.get(sourceId) ?? { lastOkAt: null, lastFoundAt: null, lastError: null, recent: [] };
  const now = Date.now();
  if (ok) h.lastOkAt = now; else h.lastError = { at: now, kind: status, message };
  if (status === "found") h.lastFoundAt = now;
  h.recent.push({ at: now, ok });
  if (h.recent.length > 60) h.recent.splice(0, h.recent.length - 60);
  health.set(sourceId, h);
}

/** Último problema de una fuente si fue hace poco (para avisarle al cliente). */
export function recentProblem(sourceId: string, withinMs = 3 * 60 * 1000): { kind: string; message: string } | null {
  const h = health.get(sourceId);
  if (!h?.lastError) return null;
  if (Date.now() - h.lastError.at > withinMs) return null;
  if (h.lastOkAt && h.lastOkAt > h.lastError.at) return null;
  return { kind: h.lastError.kind, message: h.lastError.message };
}

// ── Registro ──

const insertLog = db.prepare(`
  INSERT INTO code_lookup_log (source_id, email, account_id, origin, status, message, value, relogged, ms)
  VALUES (@sourceId, @email, @accountId, @origin, @status, @message, @value, @relogged, @ms)
`);

export function logCodeEvent(params: {
  sourceId: string; email: string; accountId?: number | null; origin: string;
  status: LookupStatus; message: string; value?: string; relogged?: boolean; ms?: number;
}): void {
  insertLog.run({
    sourceId: params.sourceId, email: params.email.trim().toLowerCase(), accountId: params.accountId ?? null,
    origin: params.origin, status: params.status, message: params.message.slice(0, 400),
    value: params.value ?? "", relogged: params.relogged ? 1 : 0, ms: params.ms ?? 0,
  });
}

// ── Bandeja ──

const accountByEmail = db.prepare(`
  SELECT id, platform FROM access_accounts WHERE lower(email) = lower(?) ORDER BY codes_enabled DESC, id DESC LIMIT 1
`);

function platformFor(sourceId: string, email: string): { accountId: number | null; platform: string } {
  const row = accountByEmail.get(email) as { id: number; platform: string } | undefined;
  if (row) return { accountId: row.id, platform: row.platform };
  const label = codeSourceLabel(sourceId);
  const p = label.match(/(Netflix|Disney\+?|Prime Video|Crunchyroll|ChatGPT)/i)?.[1] ?? "";
  return { accountId: null, platform: p };
}

const findInbox = db.prepare(`
  SELECT id FROM code_inbox
  WHERE source_id = ? AND email = ? AND provider_ref = ? AND provider_received_at = ? AND value = ?
`);
const findInboxByRef = db.prepare(`SELECT id, value FROM code_inbox WHERE source_id = ? AND email = ? AND provider_ref = ? LIMIT 1`);
const insertInbox = db.prepare(`
  INSERT INTO code_inbox (source_id, email, account_id, platform, subject, kind, value, provider_ref,
    provider_received_at, received_iso, expired, account_change, email_html, origin)
  VALUES (@sourceId, @email, @accountId, @platform, @subject, @kind, @value, @ref,
    @receivedAt, @receivedIso, @expired, @accountChange, @html, @origin)
`);
const touchInbox = db.prepare(`
  UPDATE code_inbox SET last_seen_at = datetime('now'), expired = MAX(expired, ?) WHERE id = ?
`);
const fillInbox = db.prepare(`
  UPDATE code_inbox SET kind = @kind, value = @value, subject = @subject, email_html = @html,
    account_change = @accountChange, expired = @expired, last_seen_at = datetime('now')
  WHERE id = @id
`);

const MAX_HTML = 300_000;

export type InboxItem = {
  id: number; sourceId: string; sourceLabel: string; email: string; accountId: number | null; platform: string;
  subject: string; kind: string; value: string; receivedAt: string; receivedIso: string | null;
  expired: boolean; accountChange: boolean; origin: string; firstSeenAt: string; hasHtml: boolean;
};

function rowToItem(r: any): InboxItem {
  return {
    id: r.id, sourceId: r.source_id, sourceLabel: codeSourceLabel(r.source_id), email: r.email,
    accountId: r.account_id ?? null, platform: r.platform, subject: r.subject, kind: r.kind, value: r.value,
    receivedAt: r.provider_received_at, receivedIso: r.received_iso ?? null,
    expired: !!r.expired, accountChange: !!r.account_change, origin: r.origin,
    firstSeenAt: r.first_seen_at, hasHtml: !!r.has_html,
  };
}

const ITEM_COLUMNS = `id, source_id, email, account_id, platform, subject, kind, value, provider_received_at,
  received_iso, expired, account_change, origin, first_seen_at, (email_html IS NOT NULL AND email_html <> '') AS has_html`;

/** Guarda un correo en la bandeja. Devuelve el id si es NUEVO (null si ya estaba). */
function saveToInbox(sourceId: string, email: string, origin: string, r: CodeLookupResult | null, listed?: ListedEmail): number | null {
  const mail = email.trim().toLowerCase();
  const ref = r?.providerRef ?? listed?.ref ?? "";
  const receivedAt = r?.providerReceivedAt ?? listed?.receivedAt ?? "";
  const value = r?.found && r.value ? r.value : "";
  const expired = (r?.expired ?? listed?.expired) ? 1 : 0;

  // Correo listado del que ya se guardó el aviso sin código: se completa.
  if (ref) {
    const prev = findInboxByRef.get(sourceId, mail, ref) as { id: number; value: string } | undefined;
    if (prev) {
      if (!prev.value && r) {
        fillInbox.run({
          id: prev.id, kind: r.found ? (r.kind ?? "") : "", value, subject: r.subject ?? listed?.subject ?? "",
          html: r.emailHtml ? r.emailHtml.slice(0, MAX_HTML) : null, accountChange: isAccountChangeResult(r) ? 1 : 0, expired,
        });
        return value ? prev.id : null;
      }
      touchInbox.run(expired, prev.id);
      return null;
    }
  } else {
    const prev = findInbox.get(sourceId, mail, ref, receivedAt, value) as { id: number } | undefined;
    if (prev) { touchInbox.run(expired, prev.id); return null; }
  }

  const { accountId, platform } = platformFor(sourceId, mail);
  const when = parseProviderDate(receivedAt);
  const info = insertInbox.run({
    sourceId, email: mail, accountId, platform,
    subject: r?.subject ?? listed?.subject ?? "",
    kind: r?.found ? (r.kind ?? "") : "", value, ref, receivedAt,
    receivedIso: when ? when.toISOString() : null, expired,
    accountChange: r && isAccountChangeResult(r) ? 1 : 0,
    html: r?.emailHtml ? r.emailHtml.slice(0, MAX_HTML) : null, origin,
  });
  return Number(info.lastInsertRowid);
}

function announce(id: number): void {
  const row = db.prepare(`SELECT ${ITEM_COLUMNS} FROM code_inbox WHERE id = ?`).get(id);
  if (row) emitDashboardEvent({ type: "code_inbox", item: rowToItem(row) });
}

// Cuerpos de los demás correos de una lista (latinocol): de a uno, en segundo plano.
let bodyQueue: Promise<unknown> = Promise.resolve();
function fetchBodiesLater(sourceId: string, email: string, origin: string, items: ListedEmail[]): void {
  for (const item of items.slice(0, 5)) {
    bodyQueue = bodyQueue.then(async () => {
      try {
        const r = await fetchListedEmail(sourceId, email, item);
        if (!r) return;
        const id = saveToInbox(sourceId, email, origin, r, item);
        if (id) announce(id);
      } catch (err: any) {
        console.warn("⚠️ bandeja de códigos (correo de la lista):", sourceId, err?.message);
      }
    });
  }
}

function recordInbox(e: LookupEvent): void {
  const r = e.result;
  if (!r) return;
  if (r.found || r.emailHtml) {
    const id = saveToInbox(e.sourceId, e.email, e.ctx.origin, r);
    if (id) announce(id);
  }
  // El resto de correos de la lista: primero el aviso, luego su contenido.
  const others = (r.items ?? []).filter(i => i.ref !== r.providerRef);
  const pending: ListedEmail[] = [];
  for (const item of others) {
    const id = saveToInbox(e.sourceId, e.email, e.ctx.origin, null, item);
    if (id) { announce(id); pending.push(item); }
  }
  if (pending.length) fetchBodiesLater(e.sourceId, e.email, e.ctx.origin, pending);
}

onLookup(e => {
  const status = statusOf(e);
  const message = messageOf(e, status);
  const ok = !e.error;
  touchHealth(e.sourceId, ok, status, message);

  // Sin ruido: el vigilante y la búsqueda libre (que prueba todas las
  // fuentes) solo anotan cuando pasa algo; el resto anota todo.
  const quiet = (e.ctx.origin === "vigilante" || e.ctx.origin === "busqueda") && (status === "not_found" || status === "wrong_source");
  if (!quiet) {
    logCodeEvent({
      sourceId: e.sourceId, email: e.email, accountId: e.ctx.accountId ?? null, origin: e.ctx.origin,
      status, message, value: e.result?.found ? (e.result.value ?? "") : "", relogged: !!e.result?.relogged, ms: e.ms,
    });
  }
  if (e.result) recordInbox(e);
  if (!ok) console.warn(`⚠️ códigos [${e.sourceId}] ${e.email}: ${message}`);
});

// ── Consultas para el panel ──

export function listInbox(opts: { limit?: number; q?: string; sourceId?: string; onlyCodes?: boolean } = {}): InboxItem[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.q) { where.push("(email LIKE ? OR subject LIKE ? OR value LIKE ?)"); const q = `%${opts.q.trim().toLowerCase()}%`; args.push(q, q, q); }
  if (opts.sourceId) { where.push("source_id = ?"); args.push(opts.sourceId); }
  if (opts.onlyCodes) where.push("value <> ''");
  const limit = Math.min(Math.max(Number(opts.limit) || 120, 1), 500);
  const rows = db.prepare(`
    SELECT ${ITEM_COLUMNS} FROM code_inbox
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(received_iso, replace(first_seen_at, ' ', 'T') || 'Z') DESC, id DESC
    LIMIT ${limit}
  `).all(...args);
  return rows.map(rowToItem);
}

export function getInboxHtml(id: number): { item: InboxItem; html: string | null } | null {
  const row = db.prepare(`SELECT ${ITEM_COLUMNS}, email_html FROM code_inbox WHERE id = ?`).get(id) as any;
  if (!row) return null;
  return { item: rowToItem(row), html: row.email_html ? sanitizeEmailHtml(row.email_html, false) : null };
}

export type ActivityRow = {
  id: number; at: string; sourceId: string; sourceLabel: string; email: string; accountId: number | null;
  origin: string; status: LookupStatus; message: string; value: string; relogged: boolean; ms: number;
};

export function listActivity(opts: { limit?: number; onlyProblems?: boolean } = {}): ActivityRow[] {
  const limit = Math.min(Math.max(Number(opts.limit) || 150, 1), 500);
  const rows = db.prepare(`
    SELECT * FROM code_lookup_log
    ${opts.onlyProblems ? "WHERE status NOT IN ('found', 'not_found')" : ""}
    ORDER BY id DESC LIMIT ${limit}
  `).all() as any[];
  return rows.map(r => ({
    id: r.id, at: r.at, sourceId: r.source_id, sourceLabel: codeSourceLabel(r.source_id), email: r.email,
    accountId: r.account_id ?? null, origin: r.origin, status: r.status, message: r.message, value: r.value,
    relogged: !!r.relogged, ms: r.ms,
  }));
}

export type SourceHealth = {
  id: string; label: string; watched: boolean; accounts: number;
  state: "ok" | "warn" | "down" | "idle";
  lastOkAt: string | null; lastFoundAt: string | null;
  lastError: { at: string; kind: string; message: string } | null;
  last24h: { found: number; notFound: number; problems: number };
};

export function sourcesHealth(): SourceHealth[] {
  const counts = new Map<string, number>();
  for (const a of listCodesEnabledAccounts()) {
    if (a.codeSource) counts.set(a.codeSource, (counts.get(a.codeSource) ?? 0) + 1);
  }
  const stats = db.prepare(`
    SELECT source_id,
      SUM(status = 'found') AS found,
      SUM(status IN ('not_found', 'wrong_source')) AS notFound,
      SUM(status NOT IN ('found', 'not_found', 'wrong_source', 'client_waiting')) AS problems,
      MAX(CASE WHEN status NOT IN ('found', 'not_found', 'wrong_source', 'client_waiting') THEN id END) AS lastProblemId
    FROM code_lookup_log WHERE at >= datetime('now', '-1 day') GROUP BY source_id
  `).all() as any[];
  const byId = new Map(stats.map(s => [s.source_id, s]));
  const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);

  return listCodeSources().filter(s => s.id !== TOTP_SOURCE_ID).map(s => {
    const h = health.get(s.id);
    const st = byId.get(s.id);
    let lastError = h?.lastError ? { at: iso(h.lastError.at)!, kind: h.lastError.kind, message: h.lastError.message } : null;
    if (!lastError && st?.lastProblemId) {
      const row = db.prepare(`SELECT at, status, message FROM code_lookup_log WHERE id = ?`).get(st.lastProblemId) as any;
      if (row) lastError = { at: row.at.replace(" ", "T") + "Z", kind: row.status, message: row.message };
    }
    const recent = (h?.recent ?? []).filter(x => Date.now() - x.at < 30 * 60 * 1000);
    const fails = recent.filter(x => !x.ok).length;
    const lastOk = h?.lastOkAt ?? null;
    const lastErrAt = h?.lastError?.at ?? null;
    let state: SourceHealth["state"] = "idle";
    if (recent.length) {
      if (lastErrAt && (!lastOk || lastErrAt > lastOk) && fails >= 2) state = "down";
      else if (fails > 0) state = "warn";
      else state = "ok";
    }
    return {
      id: s.id, label: s.label, watched: LIST_SOURCES.includes(s.id), accounts: counts.get(s.id) ?? 0,
      state, lastOkAt: iso(lastOk), lastFoundAt: iso(h?.lastFoundAt ?? null), lastError,
      last24h: { found: Number(st?.found ?? 0), notFound: Number(st?.notFound ?? 0), problems: Number(st?.problems ?? 0) },
    };
  });
}

// ── Vigilante: fuentes con lista (Gralexander), cada 2 minutos ──

const WATCH_INTERVAL_MS = 2 * 60 * 1000;
const WATCH_GAP_MS = 1500;
let watching = false;
let lastWatch: { at: string; checked: number; ms: number } | null = null;

export function watcherInfo(): { intervalMinutes: number; running: boolean; last: typeof lastWatch } {
  return { intervalMinutes: WATCH_INTERVAL_MS / 60000, running: watching, last: lastWatch };
}

export async function runCodeWatch(): Promise<{ checked: number }> {
  if (watching) return { checked: 0 };
  watching = true;
  const started = Date.now();
  let checked = 0;
  try {
    const seen = new Set<string>();
    for (const a of listCodesEnabledAccounts()) {
      if (!a.codeSource || !LIST_SOURCES.includes(a.codeSource) || !a.email) continue;
      const key = a.codeSource + "|" + a.email.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      await withLookupContext({ origin: "vigilante", accountId: a.id }, () => lookupCode(a.codeSource!, a.email)).catch(() => {});
      checked++;
      await new Promise(r => setTimeout(r, WATCH_GAP_MS));
    }
  } finally {
    watching = false;
    lastWatch = { at: new Date().toISOString(), checked, ms: Date.now() - started };
  }
  return { checked };
}

export function startCodeBrain(): void {
  setTimeout(() => { runCodeWatch().catch(() => {}); }, 30_000);
  setInterval(() => { runCodeWatch().catch(() => {}); }, WATCH_INTERVAL_MS);
  // Limpieza: registro 7 días; bandeja 7 días (el correo completo, 2 días).
  const clean = () => {
    db.prepare(`DELETE FROM code_lookup_log WHERE at < datetime('now', '-7 days')`).run();
    db.prepare(`DELETE FROM code_inbox WHERE first_seen_at < datetime('now', '-7 days')`).run();
    db.prepare(`UPDATE code_inbox SET email_html = NULL WHERE email_html IS NOT NULL AND first_seen_at < datetime('now', '-2 days')`).run();
  };
  clean();
  setInterval(clean, 6 * 60 * 60 * 1000);
}

// ── Cliente esperando de más: avisar al admin (una vez por link) ──

const stuckAlerted = new Set<string>();

export function alertClientWaiting(params: {
  token: string; accountId: number; email: string; sourceId: string; platform: string; clientPhone: string; minutes: number;
}): boolean {
  if (stuckAlerted.has(params.token)) return false;
  stuckAlerted.add(params.token);
  if (stuckAlerted.size > 2000) stuckAlerted.clear();
  const problem = recentProblem(params.sourceId, 10 * 60 * 1000);
  const message = `Cliente ${params.clientPhone || "(link del panel)"} espera su código hace ${params.minutes} min` +
    (problem ? ` — el proveedor tuvo un problema: ${problem.message}` : " — el proveedor no muestra ningún correo nuevo");
  logCodeEvent({ sourceId: params.sourceId, email: params.email, accountId: params.accountId, origin: "cliente", status: "client_waiting", message });
  emitDashboardEvent({
    type: "code_stuck", accountId: params.accountId, email: params.email, platform: params.platform,
    clientPhone: params.clientPhone, minutes: params.minutes, message,
  });
  return true;
}
