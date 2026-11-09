import { db } from "../db/db";
import { getAccountById } from "../db/access.repository";
import { saveIncomingCode } from "../db/codes.repository";
import { findCodeLink, codeLinkState, sqliteDate, type CodeLink } from "../db/code-links.repository";
import {
  lookupCodeAction, withLookupContext, describeLookupError, parseProviderDate,
  isLoginCodeOnlySource, isLoginCode, loginLinkOf, isAdminOnlyResult, isAccountChangeResult,
  sanitizeEmailHtml, LIST_SOURCES, TOTP_SOURCE_ID, codeSourceLabel,
  type CodeLookupResult,
} from "./codes-lookup.service";
import { laneIdOf } from "./codes-lanes";
import { alertClientWaiting, logCodeEvent } from "./codes-brain.service";
import { emitDashboardEvent } from "../utils/live-events.util";

// ─────────────────────────────────────────────────────────────
// PEDIDOS DE CÓDIGO PENDIENTES
// Cada link de código que abre un cliente es un pedido. El servidor lo
// busca solo, por turnos y en la fila de su proveedor (una consulta a la
// vez), hasta que llega el código o el link de inicio de sesión — aunque
// el cliente cierre la página. La página del cliente solo lee el estado
// (ya no le pega al proveedor cada vez que se actualiza).
//  · Memoria: cuántas veces se buscó, qué dijo el proveedor la última vez,
//    qué código ya se entregó (para «¿No te sirvió? Buscar otro» solo
//    cuenta uno más nuevo) y cuánto tardó en llegar.
//  · Mientras el cliente siga mirando y no llegue nada, el link se alarga
//    solo (hasta 20 min) para que nadie quede esperando con el link vencido.
// ─────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS code_searches (
    token                TEXT PRIMARY KEY,
    account_id           INTEGER NOT NULL,
    email                TEXT    NOT NULL,
    source_id            TEXT    NOT NULL,
    platform             TEXT    NOT NULL DEFAULT '',
    client_phone         TEXT    NOT NULL DEFAULT '',
    created_by           TEXT    NOT NULL DEFAULT '',
    status               TEXT    NOT NULL DEFAULT 'searching', -- searching | found | delivered | unresolved | closed
    attempts             INTEGER NOT NULL DEFAULT 0,
    last_check_at        TEXT,
    last_state           TEXT    NOT NULL DEFAULT '',          -- not_found | old | problem | not_login | found
    last_message         TEXT    NOT NULL DEFAULT '',
    note                 TEXT    NOT NULL DEFAULT '',
    baseline_value       TEXT    NOT NULL DEFAULT '',
    baseline_received_at TEXT    NOT NULL DEFAULT '',
    found_kind           TEXT    NOT NULL DEFAULT '',
    found_value          TEXT    NOT NULL DEFAULT '',
    found_received_at    TEXT    NOT NULL DEFAULT '',
    found_html           TEXT,
    found_at             TEXT,
    client_seen_at       TEXT,
    extended_minutes     INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_code_searches_status ON code_searches(status, created_at);
`);

// Un correo que llegó bastante antes de que se creara el link es el código
// viejo (el que ya se usó): se trata como «todavía no llega».
const OLD_EMAIL_MARGIN_MS = 10 * 60 * 1000;
// Cada pedido se revisa cada ~8 s; la fila del proveedor pone el ritmo real.
const CHECK_EVERY_MS = 8_000;
// Si el cliente sigue mirando y no llegó nada, el link se alarga solo.
const EXTEND_WHEN_LEFT_MS = 45_000;
const EXTEND_MINUTES = 3;
const MAX_TOTAL_MINUTES = 20;
const SEEN_RECENTLY_MS = 45_000;

/** Minutos que suele tardar el correo en llegar (Disney+ es lento). */
export function codeWaitMinutes(sourceId: string, platform: string): number {
  if (LIST_SOURCES.includes(sourceId)) return 3;
  return /disney|netflix_sin_opciones|netflix_con_opciones/i.test(sourceId) || /disney/i.test(platform) ? 4 : 1;
}

function escalateAfterMinutes(sourceId: string, platform: string): number {
  return Math.max(3, codeWaitMinutes(sourceId, platform) + 2);
}

export type CodeRequestRow = {
  token: string; accountId: number; email: string; sourceId: string; platform: string; clientPhone: string; createdBy: string;
  status: string; attempts: number; lastCheckAt: string | null; lastState: string; lastMessage: string; note: string;
  baselineValue: string; baselineReceivedAt: string;
  foundKind: string; foundValue: string; foundReceivedAt: string; foundAt: string | null;
  clientSeenAt: string | null; extendedMinutes: number; createdAt: string; updatedAt: string;
};

function toRow(r: any): CodeRequestRow {
  return {
    token: r.token, accountId: r.account_id, email: r.email, sourceId: r.source_id, platform: r.platform, clientPhone: r.client_phone,
    createdBy: r.created_by, status: r.status, attempts: r.attempts, lastCheckAt: r.last_check_at, lastState: r.last_state,
    lastMessage: r.last_message, note: r.note, baselineValue: r.baseline_value, baselineReceivedAt: r.baseline_received_at,
    foundKind: r.found_kind, foundValue: r.found_value, foundReceivedAt: r.found_received_at, foundAt: r.found_at,
    clientSeenAt: r.client_seen_at, extendedMinutes: r.extended_minutes, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const COLS = `token, account_id, email, source_id, platform, client_phone, created_by, status, attempts, last_check_at,
  last_state, last_message, note, baseline_value, baseline_received_at, found_kind, found_value, found_received_at,
  found_at, client_seen_at, extended_minutes, created_at, updated_at`;

function getRequest(token: string): CodeRequestRow | null {
  const r = db.prepare(`SELECT ${COLS} FROM code_searches WHERE token = ?`).get(token);
  return r ? toRow(r) : null;
}

function update(token: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE code_searches SET ${keys.map(k => `${k} = @${k}`).join(", ")}, updated_at = datetime('now') WHERE token = @token`)
    .run({ ...fields, token });
}

// Consultas en curso o en la fila, por pedido (para no encolar dos veces).
const inFlight = new Set<string>();
// Pedido que el cliente o el admin quieren revisar ya mismo.
const rushed = new Set<string>();

/** El pedido del link (se crea la primera vez que el cliente abre la página). */
export function ensureCodeRequest(link: CodeLink): CodeRequestRow {
  const existing = getRequest(link.token);
  if (existing) return existing;
  const account = getAccountById(link.accountId);
  db.prepare(`
    INSERT OR IGNORE INTO code_searches (token, account_id, email, source_id, platform, client_phone, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(link.token, link.accountId, link.email, link.sourceId, account?.platform ?? "", link.clientPhone, link.createdBy, link.createdAt);
  const row = getRequest(link.token)!;
  announce(row);
  rushed.add(link.token);
  return row;
}

export function markClientSeen(token: string): void {
  db.prepare(`UPDATE code_searches SET client_seen_at = datetime('now') WHERE token = ?`).run(token);
}

/** «Buscar ahora»: pasa adelante en su turno. */
export function rushRequest(token: string): void {
  rushed.add(token);
}

/** «¿No te sirvió? Buscar otro»: el que se mostró ya no cuenta; se espera uno más nuevo. */
export function searchAgain(token: string): void {
  const r = getRequest(token);
  if (!r) return;
  update(token, {
    status: "searching", baseline_value: r.foundValue || r.baselineValue, baseline_received_at: r.foundReceivedAt || r.baselineReceivedAt,
    found_kind: "", found_value: "", found_received_at: "", found_html: null, found_at: null, note: "", last_state: "",
  });
  rushed.add(token);
  const row = getRequest(token);
  if (row) announce(row);
}

export function closeCodeRequest(token: string): void {
  const r = getRequest(token);
  if (!r) return;
  update(token, { status: r.status === "found" ? "delivered" : "closed" });
  const row = getRequest(token);
  if (row) announce(row);
}

export function isChecking(token: string): boolean {
  return inFlight.has(token);
}

export function foundHtml(token: string): string | null {
  const r = db.prepare(`SELECT found_html FROM code_searches WHERE token = ?`).get(token) as { found_html: string | null } | undefined;
  return r?.found_html ?? null;
}

// ── Qué se le entrega al cliente ──

type Outcome =
  | { state: "found"; result: CodeLookupResult; value: string }
  | { state: "not_found" | "old" | "problem" | "not_login"; note: string; message: string };

const NOT_LOGIN_NOTE = "Llegó un correo que no es de inicio de sesión. Pide el código o link de inicio de sesión en la app y espera aquí.";

function evaluate(req: CodeRequestRow, result: CodeLookupResult, problem: { message: string } | null): Outcome {
  if (problem) return { state: "problem", note: "Reconectando con el proveedor… sigue esperando aquí.", message: problem.message };
  if (!result.found || !result.value) {
    return { state: "not_found", note: "", message: result.providerMessage || "Todavía no llega ningún correo nuevo." };
  }
  const created = sqliteDate(req.createdAt);
  const when = parseProviderDate(result.providerReceivedAt);
  const what = result.kind === "link" ? "link" : "código";
  if (result.expired || (when && created && when.getTime() < created.getTime() - OLD_EMAIL_MARGIN_MS)) {
    return { state: "old", note: `El último ${what} de inicio de sesión ya venció. Pide uno nuevo en la app y espera aquí.`, message: `El último ${what} es anterior al pedido o ya venció.` };
  }
  const value = result.kind === "link" ? (loginLinkOf(result) ?? result.value) : result.value;
  if (req.baselineValue && value === req.baselineValue && (!req.baselineReceivedAt || !result.providerReceivedAt || req.baselineReceivedAt === result.providerReceivedAt)) {
    return { state: "not_found", note: "", message: "Sigue el mismo de antes; esperando uno nuevo." };
  }
  if (isAccountChangeResult(result)) {
    return { state: "not_login", note: NOT_LOGIN_NOTE, message: "Llegó un correo de cambio de datos de la cuenta (no se entrega)." };
  }
  if (isLoginCodeOnlySource(req.sourceId) && !isLoginCode(result) && !loginLinkOf(result)) {
    return { state: "not_login", note: NOT_LOGIN_NOTE, message: "Llegó un correo que no es de inicio de sesión (no se entrega)." };
  }
  if (isAdminOnlyResult(req.sourceId, result)) {
    return { state: "not_login", note: NOT_LOGIN_NOTE, message: "Llegó un código que solo ve el admin (6 dígitos / Hogar)." };
  }
  return { state: "found", result, value };
}

// Pally con opciones: una opción por consulta. Código dos veces, link una.
function actionFor(req: CodeRequestRow): string | undefined {
  if (req.sourceId !== "netflix_con_opciones") return undefined;
  return req.attempts % 3 === 2 ? "link_login" : "codigo_login";
}

async function checkRequest(req: CodeRequestRow): Promise<void> {
  let result: CodeLookupResult = { found: false, kind: null, value: null };
  let problem: { message: string } | null = null;
  try {
    result = await withLookupContext({ origin: "cliente", accountId: req.accountId },
      () => lookupCodeAction(req.sourceId, req.email, actionFor(req)));
  } catch (err) {
    problem = describeLookupError(err);
  }
  const current = getRequest(req.token);
  if (!current || current.status !== "searching") return;
  const outcome = evaluate(current, result, problem);
  if (outcome.state === "found") {
    const r = outcome.result;
    update(req.token, {
      status: "found", attempts: current.attempts + 1, last_check_at: sqlNow(), last_state: "found",
      last_message: `Llegó ${r.kind === "link" ? "el link" : "el código"}${r.subject ? ` («${r.subject}»)` : ""}`, note: "",
      found_kind: r.kind ?? "code", found_value: outcome.value, found_received_at: r.providerReceivedAt ?? "",
      found_html: r.emailHtml ? sanitizeEmailHtml(r.emailHtml, true) : null, found_at: sqlNow(),
    });
    saveIncomingCode({
      accountId: req.accountId, code: outcome.value,
      snippet: r.providerReceivedAt ? `Recibido: ${r.providerReceivedAt}` : "", source: "external",
    });
  } else {
    update(req.token, {
      attempts: current.attempts + 1, last_check_at: sqlNow(), last_state: outcome.state,
      last_message: outcome.message.slice(0, 300), note: outcome.note,
    });
    const created = sqliteDate(current.createdAt);
    const minutes = created ? Math.floor((Date.now() - created.getTime()) / 60000) : 0;
    if (minutes >= escalateAfterMinutes(current.sourceId, current.platform)) {
      alertClientWaiting({
        token: current.token, accountId: current.accountId, email: current.email, sourceId: current.sourceId,
        platform: current.platform, clientPhone: current.clientPhone, minutes,
      });
    }
  }
  const row = getRequest(req.token);
  if (row && (row.status !== current.status || row.lastState !== current.lastState || row.attempts % 5 === 0)) announce(row);
}

function sqlNow(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// ── Buscador: recorre los pedidos abiertos ──

function linkLeftMs(link: CodeLink): number {
  const exp = sqliteDate(link.expiresAt);
  return exp ? exp.getTime() - Date.now() : 0;
}

function extendLink(token: string, minutes: number): void {
  db.prepare(`UPDATE code_links SET expires_at = datetime(expires_at, ?) WHERE token = ?`).run(`+${minutes} minutes`, token);
}

function tick(): void {
  const rows = (db.prepare(`SELECT ${COLS} FROM code_searches WHERE status IN ('searching', 'found')`).all() as any[]).map(toRow);
  for (const req of rows) {
    if (req.sourceId === TOTP_SOURCE_ID) continue;
    const link = findCodeLink(req.token);
    if (!link) { update(req.token, { status: req.status === "found" ? "delivered" : "closed" }); continue; }
    const state = codeLinkState(link);
    // Ya llegó: cuando el link se cierra o vence, queda como entregado.
    if (req.status === "found") {
      if (state !== "active") {
        update(req.token, { status: "delivered" });
        const row = getRequest(req.token);
        if (row) announce(row);
      }
      continue;
    }
    const seen = sqliteDate(req.clientSeenAt);
    const watching = !!seen && Date.now() - seen.getTime() < SEEN_RECENTLY_MS;
    const created = sqliteDate(req.createdAt);
    const ageMin = created ? (Date.now() - created.getTime()) / 60000 : 0;

    // El cliente sigue mirando y no llegó nada: se alarga el link.
    if (state === "active" && watching && linkLeftMs(link) < EXTEND_WHEN_LEFT_MS && ageMin + EXTEND_MINUTES <= MAX_TOTAL_MINUTES) {
      extendLink(req.token, EXTEND_MINUTES);
      update(req.token, { extended_minutes: req.extendedMinutes + EXTEND_MINUTES });
    }
    if (state !== "active") {
      const status = state === "closed" ? "closed" : "unresolved";
      update(req.token, { status });
      if (status === "unresolved") {
        logCodeEvent({
          sourceId: req.sourceId, email: req.email, accountId: req.accountId, origin: "cliente", status: "client_waiting",
          message: `Se venció el link de ${req.clientPhone || "un cliente"} sin que llegue el código (${req.attempts} búsquedas). Último: ${req.lastMessage || "sin respuesta"}`,
        });
      }
      const row = getRequest(req.token);
      if (row) announce(row);
      continue;
    }
    if (inFlight.has(req.token)) continue;
    const last = sqliteDate(req.lastCheckAt);
    const due = rushed.has(req.token) || !last || Date.now() - last.getTime() >= CHECK_EVERY_MS;
    if (!due) continue;
    rushed.delete(req.token);
    inFlight.add(req.token);
    checkRequest(req)
      .catch(err => console.error("⚠️ pedido de código:", req.sourceId, err?.message))
      .finally(() => inFlight.delete(req.token));
  }
}

// ── Panel: pedidos de las últimas horas ──

export type CodeRequestView = Omit<CodeRequestRow, "baselineValue" | "baselineReceivedAt"> & {
  sourceLabel: string; lane: string; checking: boolean; linkState: string; expiresAt: string | null; waitedSec: number;
};

function toView(r: CodeRequestRow): CodeRequestView {
  const link = findCodeLink(r.token);
  const created = sqliteDate(r.createdAt);
  const end = r.status === "searching" ? Date.now() : (sqliteDate(r.foundAt) ?? sqliteDate(r.updatedAt) ?? new Date()).getTime();
  const { baselineValue: _b, baselineReceivedAt: _br, ...rest } = r;
  return {
    ...rest,
    sourceLabel: codeSourceLabel(r.sourceId), lane: laneIdOf(r.sourceId), checking: inFlight.has(r.token),
    linkState: link ? codeLinkState(link) : "expired", expiresAt: link ? sqliteDate(link.expiresAt)?.toISOString() ?? null : null,
    waitedSec: created ? Math.max(0, Math.round((end - created.getTime()) / 1000)) : 0,
  };
}

function announce(r: CodeRequestRow): void {
  emitDashboardEvent({ type: "code_request", request: toView(r) });
}

export function listCodeRequests(hours = 24): CodeRequestView[] {
  const rows = (db.prepare(`
    SELECT ${COLS} FROM code_searches
    WHERE created_at >= datetime('now', ?)
    ORDER BY (status = 'searching') DESC, created_at DESC
    LIMIT 80
  `).all(`-${Math.max(1, Math.min(168, hours))} hours`) as any[]).map(toRow);
  return rows.map(toView);
}

/** Cuánto suele tardar en llegar, por fuente (pedidos de los últimos 7 días). */
export function typicalArrivalSeconds(): Record<string, number> {
  const rows = db.prepare(`
    SELECT source_id, CAST(AVG((julianday(found_at) - julianday(created_at)) * 86400) AS INTEGER) AS sec, COUNT(*) AS n
    FROM code_searches WHERE found_at IS NOT NULL AND created_at >= datetime('now', '-7 days')
    GROUP BY source_id HAVING n >= 3
  `).all() as { source_id: string; sec: number }[];
  return Object.fromEntries(rows.map(r => [r.source_id, r.sec]));
}

export function startCodeRequests(): void {
  setInterval(() => { try { tick(); } catch (err: any) { console.error("⚠️ buscador de códigos:", err?.message); } }, 1000);
  const clean = () => {
    db.prepare(`DELETE FROM code_searches WHERE created_at < datetime('now', '-7 days')`).run();
    db.prepare(`UPDATE code_searches SET found_html = NULL WHERE found_html IS NOT NULL AND created_at < datetime('now', '-1 day')`).run();
  };
  clean();
  setInterval(clean, 6 * 60 * 60 * 1000);
}
