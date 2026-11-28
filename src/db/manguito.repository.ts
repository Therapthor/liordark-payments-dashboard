import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// MANGUITO PRO — chat con Claude dentro de liordark.com (prueba privada).
// Conversaciones y mensajes de cada cliente, imágenes que sube y lo que
// gasta cada llamada a la API (para los topes de gasto). Ver
// services/manguito.service.ts.
// ─────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS ai_conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    title       TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_conv_customer ON ai_conversations(customer_id, updated_at);

  CREATE TABLE IF NOT EXISTS ai_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role            TEXT    NOT NULL,              -- 'user' | 'assistant'
    text            TEXT    NOT NULL DEFAULT '',
    images          TEXT    NOT NULL DEFAULT '[]', -- ids de ai_uploads (solo user)
    tier            TEXT    NOT NULL DEFAULT '',   -- rapido | equilibrado | experto
    model           TEXT    NOT NULL DEFAULT '',
    status          TEXT    NOT NULL DEFAULT 'ok', -- ok | stopped | error | refusal
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_msg_conv ON ai_messages(conversation_id, id);

  CREATE TABLE IF NOT EXISTS ai_uploads (
    id          TEXT    PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    media_type  TEXT    NOT NULL,
    bytes       INTEGER NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ai_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id   INTEGER NOT NULL,
    kind          TEXT    NOT NULL,                -- chat | router | test
    tier          TEXT    NOT NULL DEFAULT '',
    model         TEXT    NOT NULL,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read    INTEGER NOT NULL DEFAULT 0,
    cache_write   INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL    NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);
  CREATE INDEX IF NOT EXISTS idx_ai_usage_customer ON ai_usage(customer_id, created_at);
`);
// Resumen de lo ya compactado de cada conversación (ver compactación en
// manguito.service.ts): los mensajes viejos se borran y queda su resumen.
{
  const cols = (db.prepare(`PRAGMA table_info(ai_conversations)`).all() as { name: string }[]).map(c => c.name);
  if (!cols.includes("summary")) db.exec(`ALTER TABLE ai_conversations ADD COLUMN summary TEXT NOT NULL DEFAULT ''`);
  if (!cols.includes("compacted")) db.exec(`ALTER TABLE ai_conversations ADD COLUMN compacted INTEGER NOT NULL DEFAULT 0`);
}
// Archivos adjuntos (además de imágenes): documentos (PDF o texto sacado de
// Word/Excel/etc. en el navegador) y cuadros de video. `files` del mensaje
// guarda nombre/tamaño aunque el archivo ya se haya borrado.
{
  const up = (db.prepare(`PRAGMA table_info(ai_uploads)`).all() as { name: string }[]).map(c => c.name);
  if (!up.includes("kind")) db.exec(`ALTER TABLE ai_uploads ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'`); // image | pdf | text | frame
  if (!up.includes("name")) db.exec(`ALTER TABLE ai_uploads ADD COLUMN name TEXT NOT NULL DEFAULT ''`);
  const msg = (db.prepare(`PRAGMA table_info(ai_messages)`).all() as { name: string }[]).map(c => c.name);
  if (!msg.includes("files")) db.exec(`ALTER TABLE ai_messages ADD COLUMN files TEXT NOT NULL DEFAULT '[]'`);
}
// «Cerebro» de cada cliente: lo que Manguito recuerda de él entre
// conversaciones, y la pausa de 1 hora cuando gasta mucho de golpe.
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_customer_state (
    customer_id       INTEGER PRIMARY KEY,
    memory            TEXT    NOT NULL DEFAULT '',
    memory_updated_at TEXT,
    msgs_since_memory INTEGER NOT NULL DEFAULT 0,
    cooldown_until    INTEGER NOT NULL DEFAULT 0
  );
`);

// Pausas de 1 hora: cuántas lleva hoy (máximo 2 al día, ver manguito.service.ts).
{
  const cols = (db.prepare(`PRAGMA table_info(ai_customer_state)`).all() as { name: string }[]).map(c => c.name);
  if (!cols.includes("pauses_day")) db.exec(`ALTER TABLE ai_customer_state ADD COLUMN pauses_day TEXT NOT NULL DEFAULT ''`);
  if (!cols.includes("pauses_count")) db.exec(`ALTER TABLE ai_customer_state ADD COLUMN pauses_count INTEGER NOT NULL DEFAULT 0`);
}
// Hasta qué mensaje cubre el resumen de cada conversación: lo anterior ya
// no se vuelve a mandar a la API (se manda el resumen, mucho más corto).
if (!(db.prepare(`PRAGMA table_info(ai_conversations)`).all() as { name: string }[]).some(c => c.name === "summary_upto")) {
  db.exec(`ALTER TABLE ai_conversations ADD COLUMN summary_upto INTEGER NOT NULL DEFAULT 0`);
}

// Venta de Manguito Pro: saldo de cada cliente (plan mensual y/o créditos),
// compras por Yape y links para compartir chats.
//  · ai_wallets: créditos (US$) y plan mensual vigente (inicio/fin en ms,
//    US$ por ciclo de 30 días) y el inicio de la ventana de 3 horas.
//  · ai_purchases: cada compra (pedido web del bot); al pagarse se acredita.
//  · ai_shares: copia fija de los mensajes elegidos + contraseña opcional.
//  · ai_usage.source: de dónde salió cada gasto (plan | credits | free).
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_wallets (
    customer_id  INTEGER PRIMARY KEY,
    credits_usd  REAL    NOT NULL DEFAULT 0,
    plan_start   INTEGER NOT NULL DEFAULT 0,
    plan_end     INTEGER NOT NULL DEFAULT 0,
    plan_usd     REAL    NOT NULL DEFAULT 0,
    window_start INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS ai_purchases (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id  INTEGER NOT NULL,
    order_name   TEXT    NOT NULL UNIQUE,
    kind         TEXT    NOT NULL,              -- plan | credits | gift
    amount_soles TEXT    NOT NULL DEFAULT '',
    usd          REAL    NOT NULL DEFAULT 0,
    status       TEXT    NOT NULL DEFAULT 'pending',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    paid_at      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ai_purch_customer ON ai_purchases(customer_id, status);
  CREATE TABLE IF NOT EXISTS ai_shares (
    token           TEXT    PRIMARY KEY,
    customer_id     INTEGER NOT NULL,
    conversation_id INTEGER NOT NULL,
    title           TEXT    NOT NULL DEFAULT '',
    mode            TEXT    NOT NULL DEFAULT 'all', -- all | result | selected
    messages        TEXT    NOT NULL DEFAULT '[]',
    pass_hash       TEXT    NOT NULL DEFAULT '',
    pass_salt       TEXT    NOT NULL DEFAULT '',
    views           INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_shares_customer ON ai_shares(customer_id, created_at);
`);
// Avisos de campanita ya mandados (para no repetirlos).
{
  const cols = (db.prepare(`PRAGMA table_info(ai_wallets)`).all() as { name: string }[]).map(c => c.name);
  for (const c of ["notice_expiring", "notice_expired", "notice_low", "notice_out"]) {
    if (!cols.includes(c)) db.exec(`ALTER TABLE ai_wallets ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
  }
}
if (!(db.prepare(`PRAGMA table_info(ai_usage)`).all() as { name: string }[]).some(c => c.name === "source")) {
  db.exec(`ALTER TABLE ai_usage ADD COLUMN source TEXT NOT NULL DEFAULT ''`);
}
// Lo «gratis» (celulares de la lista del panel) es lo que cuentan los topes
// del panel; lo pagado (plan o créditos) tiene sus propios límites.
const FREE = `source IN ('free', '')`;

// Qué clave de la lista se usó (para ver el gasto de cada una).
if (!(db.prepare(`PRAGMA table_info(ai_usage)`).all() as { name: string }[]).some(c => c.name === "cred_id")) {
  db.exec(`ALTER TABLE ai_usage ADD COLUMN cred_id TEXT NOT NULL DEFAULT ''`);
}

export type AiConversation = { id: number; title: string; createdAt: string; updatedAt: string; summary: string; compacted: number; summaryUpto: number };
/** Adjunto que no es imagen: documento (pdf/texto) o video (sus cuadros). */
export type AiFile =
  | { kind: "pdf" | "text"; id: string; name: string; bytes: number }
  | { kind: "video"; name: string; bytes: number; duration: number; frames: string[] };
export type AiMessage = {
  id: number; conversationId: number; role: "user" | "assistant"; text: string;
  images: string[]; files: AiFile[]; tier: string; model: string; status: string; createdAt: string;
};

function toMessage(r: any): AiMessage {
  let images: string[] = [];
  let files: AiFile[] = [];
  try { images = JSON.parse(r.images || "[]"); } catch { images = []; }
  try { files = JSON.parse(r.files || "[]"); } catch { files = []; }
  return {
    id: r.id, conversationId: r.conversation_id, role: r.role, text: r.text, images, files: Array.isArray(files) ? files : [],
    tier: r.tier, model: r.model, status: r.status, createdAt: r.created_at,
  };
}

/** Todos los archivos subidos de un mensaje (imágenes, documentos y cuadros de video). */
export function attachmentIds(m: AiMessage): string[] {
  return [...m.images, ...m.files.flatMap(f => f.kind === "video" ? f.frames : [f.id])];
}

export function listConversations(customerId: number, limit = 60): AiConversation[] {
  return db.prepare(`
    SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, summary, compacted
    FROM ai_conversations WHERE customer_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?
  `).all(customerId, limit) as AiConversation[];
}

export function getConversation(customerId: number, id: number): AiConversation | null {
  const row = db.prepare(`
    SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, summary, compacted, summary_upto AS summaryUpto
    FROM ai_conversations WHERE id = ? AND customer_id = ?
  `).get(id, customerId) as AiConversation | undefined;
  return row ?? null;
}

export function createConversation(customerId: number, title: string): AiConversation {
  const r = db.prepare(`INSERT INTO ai_conversations (customer_id, title) VALUES (?, ?)`).run(customerId, title);
  return getConversation(customerId, Number(r.lastInsertRowid))!;
}

export function touchConversation(id: number): void {
  db.prepare(`UPDATE ai_conversations SET updated_at = datetime('now') WHERE id = ?`).run(id);
}

/** Borra la conversación y devuelve los ids de las imágenes que tenía. */
export const deleteConversation = db.transaction((customerId: number, id: number): string[] | null => {
  if (!getConversation(customerId, id)) return null;
  const images = listMessages(id).flatMap(attachmentIds);
  db.prepare(`DELETE FROM ai_messages WHERE conversation_id = ?`).run(id);
  db.prepare(`DELETE FROM ai_conversations WHERE id = ?`).run(id);
  return images;
});

export function listMessages(conversationId: number): AiMessage[] {
  return (db.prepare(`SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY id ASC`).all(conversationId) as any[]).map(toMessage);
}

export function addMessage(m: {
  conversationId: number; role: "user" | "assistant"; text: string; images?: string[]; files?: AiFile[];
  tier?: string; model?: string; status?: string;
}): number {
  const r = db.prepare(`
    INSERT INTO ai_messages (conversation_id, role, text, images, files, tier, model, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(m.conversationId, m.role, m.text, JSON.stringify(m.images ?? []), JSON.stringify(m.files ?? []), m.tier ?? "", m.model ?? "", m.status ?? "ok");
  return Number(r.lastInsertRowid);
}

export type UploadKind = "image" | "pdf" | "text" | "frame";
export type AiUpload = { id: string; customerId: number; mediaType: string; kind: UploadKind; name: string; bytes: number };

export function saveUpload(id: string, customerId: number, mediaType: string, bytes: number, kind: UploadKind = "image", name = ""): void {
  db.prepare(`INSERT INTO ai_uploads (id, customer_id, media_type, bytes, kind, name) VALUES (?, ?, ?, ?, ?, ?)`).run(id, customerId, mediaType, bytes, kind, name);
}

export function getUpload(id: string): AiUpload | null {
  const r = db.prepare(`SELECT id, customer_id AS customerId, media_type AS mediaType, kind, name, bytes FROM ai_uploads WHERE id = ?`).get(id) as any;
  return r ?? null;
}

/** Cuánto subió el cliente en la última hora (para que nadie llene el disco). */
export function recentUploadBytes(customerId: number): { count: number; bytes: number } {
  return db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM ai_uploads
    WHERE customer_id = ? AND created_at >= datetime('now', '-1 hour')
  `).get(customerId) as { count: number; bytes: number };
}

export function deleteUploadRows(ids: string[]): void {
  const del = db.prepare(`DELETE FROM ai_uploads WHERE id = ?`);
  for (const id of ids) del.run(id);
}

export type UsageSource = "plan" | "credits" | "free";

/** Guarda el gasto; si salió de los créditos, los descuenta (nunca bajan de 0). */
export const logUsage = db.transaction((u: {
  customerId: number; kind: "chat" | "router" | "test" | "compact" | "memory"; tier?: string; model: string; credId?: string;
  inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; costUsd: number; source?: UsageSource;
}): void => {
  db.prepare(`
    INSERT INTO ai_usage (customer_id, kind, tier, model, cred_id, input_tokens, output_tokens, cache_read, cache_write, cost_usd, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(u.customerId, u.kind, u.tier ?? "", u.model, u.credId ?? "", u.inputTokens, u.outputTokens, u.cacheRead, u.cacheWrite, u.costUsd, u.source ?? "free");
  if (u.source === "credits" && u.costUsd > 0) {
    db.prepare(`UPDATE ai_wallets SET credits_usd = MAX(0, credits_usd - ?) WHERE customer_id = ?`).run(u.costUsd, u.customerId);
  }
});

// Días y meses en hora de Lima (UTC-5), igual que el resto del panel.
export function spentTodayByCustomer(customerId: number): number {
  const r = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS t FROM ai_usage
    WHERE customer_id = ? AND ${FREE} AND date(created_at, '-5 hours') = date('now', '-5 hours')
  `).get(customerId) as { t: number };
  return r.t;
}

/** Gasto gratis (de prueba) de todos este mes: lo que cuenta el tope total del panel. */
export function spentThisMonth(): number {
  const r = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS t FROM ai_usage
    WHERE ${FREE} AND strftime('%Y-%m', created_at, '-5 hours') = strftime('%Y-%m', 'now', '-5 hours')
  `).get() as { t: number };
  return r.t;
}

export function usageSummary() {
  const today = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS usd, SUM(kind = 'chat') AS messages FROM ai_usage
    WHERE date(created_at, '-5 hours') = date('now', '-5 hours')
  `).get() as { usd: number; messages: number | null };
  const month = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS usd, SUM(kind = 'chat') AS messages FROM ai_usage
    WHERE strftime('%Y-%m', created_at, '-5 hours') = strftime('%Y-%m', 'now', '-5 hours')
  `).get() as { usd: number; messages: number | null };
  const byTier = db.prepare(`
    SELECT CASE WHEN kind = 'chat' THEN tier ELSE kind END AS tier, COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS usd
    FROM ai_usage WHERE strftime('%Y-%m', created_at, '-5 hours') = strftime('%Y-%m', 'now', '-5 hours')
    GROUP BY 1 ORDER BY usd DESC
  `).all() as { tier: string; calls: number; usd: number }[];
  return {
    today: { usd: today.usd, messages: today.messages ?? 0 },
    month: { usd: month.usd, messages: month.messages ?? 0 },
    byTier,
  };
}

/** Gasto estimado de este mes por clave de la lista. */
export function monthSpendByCredential(): Record<string, number> {
  const rows = db.prepare(`
    SELECT cred_id AS id, COALESCE(SUM(cost_usd), 0) AS usd FROM ai_usage
    WHERE strftime('%Y-%m', created_at, '-5 hours') = strftime('%Y-%m', 'now', '-5 hours') AND cred_id != ''
    GROUP BY cred_id
  `).all() as { id: string; usd: number }[];
  return Object.fromEntries(rows.map(r => [r.id, r.usd]));
}

// ── Compactación y límites de espacio ──

/** Reemplaza los mensajes con id <= upto por su resumen (en una transacción). */
/** El resumen ahora cubre hasta el mensaje `upto` (esos ya no se mandan a la API). */
export function setSummary(conversationId: number, upto: number, summary: string): void {
  db.prepare(`UPDATE ai_conversations SET summary = ?, summary_upto = MAX(summary_upto, ?) WHERE id = ?`).run(summary, upto, conversationId);
}

/** Borra del servidor los mensajes hasta `upto` (ya están en el resumen). */
export const pruneMessages = db.transaction((conversationId: number, upto: number): number => {
  const n = db.prepare(`DELETE FROM ai_messages WHERE conversation_id = ? AND id <= ?`).run(conversationId, upto).changes;
  if (n) db.prepare(`UPDATE ai_conversations SET compacted = compacted + ? WHERE id = ?`).run(n, conversationId);
  return n;
});

export function countMessages(conversationId: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ai_messages WHERE conversation_id = ?`).get(conversationId) as { n: number }).n;
}

/** Conversaciones con muchos mensajes guardados (para compactar en segundo plano). */
export function conversationsToCompact(minMessages: number): { id: number; customerId: number }[] {
  return db.prepare(`
    SELECT c.id AS id, c.customer_id AS customerId FROM ai_conversations c
    WHERE (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) > ?
  `).all(minMessages) as { id: number; customerId: number }[];
}

/** Conversaciones que pasan del máximo por cliente (las más viejas primero). */
export function conversationsOverLimit(maxPerCustomer: number): { id: number; customerId: number }[] {
  return db.prepare(`
    SELECT id, customer_id AS customerId FROM (
      SELECT id, customer_id, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY updated_at DESC, id DESC) AS rn
      FROM ai_conversations
    ) WHERE rn > ?
  `).all(maxPerCustomer) as { id: number; customerId: number }[];
}

/** Archivos subidos hace más de `days` días; los cuadros de video, a las 24 horas. */
export function oldUploads(days: number): { id: string; mediaType: string }[] {
  return db.prepare(`
    SELECT id, media_type AS mediaType FROM ai_uploads
    WHERE created_at < datetime('now', ?) OR (kind = 'frame' AND created_at < datetime('now', '-24 hours'))
  `).all(`-${days} days`) as { id: string; mediaType: string }[];
}

// ── Estado del cliente: memoria («cerebro») y pausa ──

export type AiCustomerState = { memory: string; memoryUpdatedAt: string | null; msgsSinceMemory: number; cooldownUntil: number };

export function customerState(customerId: number): AiCustomerState {
  const r = db.prepare(`
    SELECT memory, memory_updated_at AS memoryUpdatedAt, msgs_since_memory AS msgsSinceMemory, cooldown_until AS cooldownUntil
    FROM ai_customer_state WHERE customer_id = ?
  `).get(customerId) as AiCustomerState | undefined;
  return r ?? { memory: "", memoryUpdatedAt: null, msgsSinceMemory: 0, cooldownUntil: 0 };
}

function ensureState(customerId: number): void {
  db.prepare(`INSERT OR IGNORE INTO ai_customer_state (customer_id) VALUES (?)`).run(customerId);
}

export function setMemory(customerId: number, memory: string): void {
  ensureState(customerId);
  db.prepare(`UPDATE ai_customer_state SET memory = ?, memory_updated_at = datetime('now'), msgs_since_memory = 0 WHERE customer_id = ?`).run(memory, customerId);
}

export function bumpMessagesSinceMemory(customerId: number): number {
  ensureState(customerId);
  db.prepare(`UPDATE ai_customer_state SET msgs_since_memory = msgs_since_memory + 1 WHERE customer_id = ?`).run(customerId);
  return customerState(customerId).msgsSinceMemory;
}

/** Pausa hasta `untilMs` si hoy (hora de Lima) aún no llegó a `maxPerDay` pausas. */
export const registerPause = db.transaction((customerId: number, untilMs: number, maxPerDay: number): boolean => {
  ensureState(customerId);
  const today = (db.prepare(`SELECT date('now', '-5 hours') AS d`).get() as { d: string }).d;
  const r = db.prepare(`SELECT pauses_day AS day, pauses_count AS n FROM ai_customer_state WHERE customer_id = ?`).get(customerId) as { day: string; n: number };
  const n = r.day === today ? r.n : 0;
  if (n >= maxPerDay) return false;
  db.prepare(`UPDATE ai_customer_state SET cooldown_until = ?, pauses_day = ?, pauses_count = ? WHERE customer_id = ?`).run(untilMs, today, n + 1, customerId);
  return true;
});

/** Pausas que ya tuvo hoy (hora de Lima). */
export function pausesToday(customerId: number): number {
  const r = db.prepare(`
    SELECT pauses_count AS n FROM ai_customer_state WHERE customer_id = ? AND pauses_day = date('now', '-5 hours')
  `).get(customerId) as { n: number } | undefined;
  return r?.n ?? 0;
}

/** Respuestas del chat desde `sinceMs` (para la tanda de mensajes antes de una pausa). */
export function chatsSince(customerId: number, sinceMs: number): number {
  const r = db.prepare(`
    SELECT COUNT(*) AS n FROM ai_usage WHERE customer_id = ? AND kind = 'chat' AND ${FREE} AND created_at >= datetime(?, 'unixepoch')
  `).get(customerId, Math.floor(sinceMs / 1000)) as { n: number };
  return r.n;
}


export function spentThisMonthByCustomer(customerId: number): number {
  const r = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS t FROM ai_usage
    WHERE customer_id = ? AND ${FREE} AND strftime('%Y-%m', created_at, '-5 hours') = strftime('%Y-%m', 'now', '-5 hours')
  `).get(customerId) as { t: number };
  return r.t;
}

// ── Saldo (plan mensual y créditos) ──

export type AiWallet = { credits: number; planStart: number; planEnd: number; planUsd: number; windowStart: number };

export function wallet(customerId: number): AiWallet {
  const r = db.prepare(`
    SELECT credits_usd AS credits, plan_start AS planStart, plan_end AS planEnd, plan_usd AS planUsd, window_start AS windowStart
    FROM ai_wallets WHERE customer_id = ?
  `).get(customerId) as AiWallet | undefined;
  return r ?? { credits: 0, planStart: 0, planEnd: 0, planUsd: 0, windowStart: 0 };
}

function ensureWallet(customerId: number): void {
  db.prepare(`INSERT OR IGNORE INTO ai_wallets (customer_id) VALUES (?)`).run(customerId);
}

export function setWindowStart(customerId: number, ms: number): void {
  ensureWallet(customerId);
  db.prepare(`UPDATE ai_wallets SET window_start = ? WHERE customer_id = ?`).run(ms, customerId);
}

const PLAN_DAYS_MS = 30 * 24 * 3600e3;

/** Suma créditos o 30 días de plan (si el plan sigue vigente, se alarga). */
function grant(customerId: number, kind: string, usd: number): void {
  ensureWallet(customerId);
  if (kind === "plan") {
    const w = wallet(customerId);
    const now = Date.now();
    if (w.planEnd > now) {
      db.prepare(`UPDATE ai_wallets SET plan_end = plan_end + ?, plan_usd = ? WHERE customer_id = ?`).run(PLAN_DAYS_MS, usd, customerId);
    } else {
      db.prepare(`UPDATE ai_wallets SET plan_start = ?, plan_end = ?, plan_usd = ?, window_start = 0 WHERE customer_id = ?`).run(now, now + PLAN_DAYS_MS, usd, customerId);
    }
  } else {
    db.prepare(`UPDATE ai_wallets SET credits_usd = credits_usd + ?, notice_low = 0, notice_out = 0 WHERE customer_id = ?`).run(usd, customerId);
  }
}

/** Quita los límites: termina el plan y lo que quedaba pasa a créditos. */
export function planToCredits(customerId: number, usd: number): void {
  ensureWallet(customerId);
  db.prepare(`UPDATE ai_wallets SET credits_usd = credits_usd + ?, plan_end = ?, notice_low = 0, notice_out = 0 WHERE customer_id = ?`)
    .run(Math.max(0, Math.round(usd * 10000) / 10000), Date.now(), customerId);
}

/** Gasto pagado con el plan desde `sinceMs`. */
export function planSpentSince(customerId: number, sinceMs: number): number {
  const r = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS t FROM ai_usage
    WHERE customer_id = ? AND source = 'plan' AND created_at >= datetime(?, 'unixepoch')
  `).get(customerId, Math.floor(sinceMs / 1000)) as { t: number };
  return r.t;
}

/** Créditos gastados desde `sinceMs` (para el ritmo de gasto). */
export function creditsSpentSince(customerId: number, sinceMs: number): { usd: number; messages: number } {
  const r = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS usd, SUM(kind = 'chat') AS messages FROM ai_usage
    WHERE customer_id = ? AND source = 'credits' AND created_at >= datetime(?, 'unixepoch')
  `).get(customerId, Math.floor(sinceMs / 1000)) as { usd: number; messages: number | null };
  return { usd: r.usd, messages: r.messages ?? 0 };
}

// ── Compras ──

export type AiPurchase = {
  id: number; customerId: number; orderName: string; kind: "plan" | "credits" | "gift";
  amountSoles: string; usd: number; status: "pending" | "paid"; createdAt: string; paidAt: string | null;
};
const PURCHASE_COLS = `id, customer_id AS customerId, order_name AS orderName, kind, amount_soles AS amountSoles, usd, status, created_at AS createdAt, paid_at AS paidAt`;

export function createAiPurchase(p: { customerId: number; orderName: string; kind: "plan" | "credits"; amountSoles: string; usd: number }): void {
  db.prepare(`
    INSERT OR IGNORE INTO ai_purchases (customer_id, order_name, kind, amount_soles, usd) VALUES (?, ?, ?, ?, ?)
  `).run(p.customerId, p.orderName, p.kind, p.amountSoles, p.usd);
}

export function findAiPurchase(orderName: string): AiPurchase | null {
  return (db.prepare(`SELECT ${PURCHASE_COLS} FROM ai_purchases WHERE order_name = ?`).get(orderName) as AiPurchase | undefined) ?? null;
}

/** Marca la compra como pagada y acredita. Idempotente. */
export const markAiPurchasePaid = db.transaction((orderName: string, amountSoles?: string): { ok: boolean; alreadyPaid?: boolean; purchase?: AiPurchase } => {
  const p = findAiPurchase(orderName);
  if (!p) return { ok: false };
  if (p.status === "paid") return { ok: true, alreadyPaid: true, purchase: p };
  db.prepare(`UPDATE ai_purchases SET status = 'paid', paid_at = datetime('now'), amount_soles = COALESCE(?, amount_soles) WHERE id = ?`)
    .run(amountSoles ?? null, p.id);
  grant(p.customerId, p.kind, p.usd);
  return { ok: true, purchase: { ...p, status: "paid" } };
});

/** Regalo desde el panel (créditos o 30 días de plan), queda en la lista de compras. */
export const giftAi = db.transaction((customerId: number, kind: "plan" | "credits", usd: number): void => {
  const orderName = `regalo-${kind}-${customerId}-${Date.now()}`;
  db.prepare(`
    INSERT INTO ai_purchases (customer_id, order_name, kind, amount_soles, usd, status, paid_at) VALUES (?, ?, 'gift', '0', ?, 'paid', datetime('now'))
  `).run(customerId, orderName, usd);
  grant(customerId, kind, usd);
});

export function countConversations(customerId: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ai_conversations WHERE customer_id = ?`).get(customerId) as { n: number }).n;
}

export function hasPaidAiPurchase(customerId: number): boolean {
  return !!db.prepare(`SELECT 1 FROM ai_purchases WHERE customer_id = ? AND status = 'paid' LIMIT 1`).get(customerId);
}

export function recentAiPurchases(limit = 30): (AiPurchase & { phone: string })[] {
  return db.prepare(`
    SELECT ${PURCHASE_COLS.split(", ").map(c => "p." + c).join(", ")}, COALESCE(c.phone, '') AS phone
    FROM ai_purchases p LEFT JOIN customers c ON c.id = p.customer_id
    WHERE p.status = 'paid' ORDER BY p.id DESC LIMIT ?
  `).all(limit) as (AiPurchase & { phone: string })[];
}

/** Lo vendido que aún no se usa: créditos de todos + lo que queda del ciclo de cada plan vigente. */
export function outstandingBalance(): { credits: number; plans: number; activePlans: number } {
  const credits = (db.prepare(`SELECT COALESCE(SUM(credits_usd), 0) AS t FROM ai_wallets`).get() as { t: number }).t;
  const now = Date.now();
  const plans = db.prepare(`SELECT customer_id AS customerId, plan_start AS planStart, plan_usd AS planUsd FROM ai_wallets WHERE plan_end > ?`).all(now) as { customerId: number; planStart: number; planUsd: number }[];
  let left = 0;
  for (const p of plans) {
    const cycleStart = p.planStart + Math.floor((now - p.planStart) / PLAN_DAYS_MS) * PLAN_DAYS_MS;
    left += Math.max(0, p.planUsd - planSpentSince(p.customerId, cycleStart));
  }
  return { credits, plans: left, activePlans: plans.length };
}

/** Pagos pendientes viejos (nunca se pagaron) se limpian. */
export function cleanupPendingAiPurchases(): void {
  db.prepare(`DELETE FROM ai_purchases WHERE status = 'pending' AND created_at < datetime('now', '-2 days')`).run();
}

// ── Borrar todo el historial ──

/** Borra todas las conversaciones del cliente y devuelve los ids de sus imágenes. */
export const deleteAllConversations = db.transaction((customerId: number): string[] => {
  const ids = (db.prepare(`SELECT id FROM ai_conversations WHERE customer_id = ?`).all(customerId) as { id: number }[]).map(r => r.id);
  const images: string[] = [];
  for (const id of ids) images.push(...listMessages(id).flatMap(attachmentIds));
  db.prepare(`DELETE FROM ai_messages WHERE conversation_id IN (SELECT id FROM ai_conversations WHERE customer_id = ?)`).run(customerId);
  db.prepare(`DELETE FROM ai_conversations WHERE customer_id = ?`).run(customerId);
  const orphan = (db.prepare(`SELECT id FROM ai_uploads WHERE customer_id = ?`).all(customerId) as { id: string }[]).map(r => r.id);
  return [...new Set([...images, ...orphan])];
});

// ── Links para compartir ──

export type AiShareMessage = { role: "user" | "assistant"; text: string; label?: string; images?: number };
export type AiShare = {
  token: string; customerId: number; conversationId: number; title: string; mode: string;
  messages: AiShareMessage[]; locked: boolean; passHash: string; passSalt: string; views: number; createdAt: string;
};
function toShare(r: any): AiShare {
  let messages: AiShareMessage[] = [];
  try { messages = JSON.parse(r.messages || "[]"); } catch { /* vacío */ }
  return {
    token: r.token, customerId: r.customer_id, conversationId: r.conversation_id, title: r.title, mode: r.mode,
    messages, locked: !!r.pass_hash, passHash: r.pass_hash, passSalt: r.pass_salt, views: r.views, createdAt: r.created_at,
  };
}

export function createShare(s: { token: string; customerId: number; conversationId: number; title: string; mode: string; messages: AiShareMessage[]; passHash: string; passSalt: string }): void {
  db.prepare(`
    INSERT INTO ai_shares (token, customer_id, conversation_id, title, mode, messages, pass_hash, pass_salt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(s.token, s.customerId, s.conversationId, s.title, s.mode, JSON.stringify(s.messages), s.passHash, s.passSalt);
}

export function getShare(token: string): AiShare | null {
  const r = db.prepare(`SELECT * FROM ai_shares WHERE token = ?`).get(token);
  return r ? toShare(r) : null;
}

export function listShares(customerId: number): AiShare[] {
  return (db.prepare(`SELECT * FROM ai_shares WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100`).all(customerId) as any[]).map(toShare);
}

export function deleteShare(customerId: number, token: string): boolean {
  return db.prepare(`DELETE FROM ai_shares WHERE customer_id = ? AND token = ?`).run(customerId, token).changes > 0;
}

export function deleteAllShares(customerId: number): number {
  return db.prepare(`DELETE FROM ai_shares WHERE customer_id = ?`).run(customerId).changes;
}

export function bumpShareViews(token: string): void {
  db.prepare(`UPDATE ai_shares SET views = views + 1 WHERE token = ?`).run(token);
}

/** Costo promedio por mensaje del cliente (últimos 30 días; respuesta + selector + resúmenes). */
export function avgCostPerMessage(customerId: number): number {
  const r = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS usd, SUM(kind = 'chat') AS n FROM ai_usage
    WHERE customer_id = ? AND created_at >= datetime('now', '-30 days')
  `).get(customerId) as { usd: number; n: number | null };
  return r.n && r.n >= 3 ? r.usd / r.n : 0;
}

/** Suscriptores (plan o créditos) con lo que pagaron y lo que gastaron. */
export function subscribersSummary(): {
  customerId: number; phone: string; planEnd: number; planUsd: number; credits: number;
  paidSoles: number; giftsUsd: number; spentUsd: number; monthUsd: number; lastAt: string | null;
}[] {
  return db.prepare(`
    SELECT w.customer_id AS customerId, COALESCE(c.phone, '') AS phone, w.plan_end AS planEnd, w.plan_usd AS planUsd, w.credits_usd AS credits,
      (SELECT COALESCE(SUM(CAST(p.amount_soles AS REAL)), 0) FROM ai_purchases p WHERE p.customer_id = w.customer_id AND p.status = 'paid' AND p.kind != 'gift') AS paidSoles,
      (SELECT COALESCE(SUM(p.usd), 0) FROM ai_purchases p WHERE p.customer_id = w.customer_id AND p.status = 'paid' AND p.kind = 'gift') AS giftsUsd,
      (SELECT COALESCE(SUM(u.cost_usd), 0) FROM ai_usage u WHERE u.customer_id = w.customer_id AND u.source IN ('plan', 'credits')) AS spentUsd,
      (SELECT COALESCE(SUM(u.cost_usd), 0) FROM ai_usage u WHERE u.customer_id = w.customer_id AND u.source IN ('plan', 'credits')
         AND strftime('%Y-%m', u.created_at, '-5 hours') = strftime('%Y-%m', 'now', '-5 hours')) AS monthUsd,
      (SELECT MAX(u.created_at) FROM ai_usage u WHERE u.customer_id = w.customer_id AND u.kind = 'chat') AS lastAt
    FROM ai_wallets w LEFT JOIN customers c ON c.id = w.customer_id
    WHERE w.plan_end > 0 OR w.credits_usd > 0 OR EXISTS (SELECT 1 FROM ai_purchases p WHERE p.customer_id = w.customer_id AND p.status = 'paid')
    ORDER BY (w.plan_end > strftime('%s', 'now') * 1000 OR w.credits_usd > 0) DESC, lastAt DESC
    LIMIT 300
  `).all() as any[];
}

/** Ventas y gasto pagado de este mes (hora de Lima). */
export function salesThisMonth(): { soles: number; sales: number; costUsd: number } {
  const a = db.prepare(`
    SELECT COALESCE(SUM(CAST(amount_soles AS REAL)), 0) AS soles, COUNT(*) AS sales FROM ai_purchases
    WHERE status = 'paid' AND kind != 'gift' AND strftime('%Y-%m', paid_at, '-5 hours') = strftime('%Y-%m', 'now', '-5 hours')
  `).get() as { soles: number; sales: number };
  const b = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS t FROM ai_usage
    WHERE source IN ('plan', 'credits') AND strftime('%Y-%m', created_at, '-5 hours') = strftime('%Y-%m', 'now', '-5 hours')
  `).get() as { t: number };
  return { soles: a.soles, sales: a.sales, costUsd: b.t };
}

export type WalletNoticeRow = {
  customerId: number; phone: string; planEnd: number; credits: number;
  noticeExpiring: number; noticeExpired: number; noticeLow: number; noticeOut: number; lastCreditsUsd: number;
};
export function walletsForNotices(): WalletNoticeRow[] {
  return db.prepare(`
    SELECT w.customer_id AS customerId, COALESCE(c.phone, '') AS phone, w.plan_end AS planEnd, w.credits_usd AS credits,
      w.notice_expiring AS noticeExpiring, w.notice_expired AS noticeExpired, w.notice_low AS noticeLow, w.notice_out AS noticeOut,
      (SELECT p.usd FROM ai_purchases p WHERE p.customer_id = w.customer_id AND p.status = 'paid' AND p.kind IN ('credits', 'gift') ORDER BY p.id DESC LIMIT 1) AS lastCreditsUsd
    FROM ai_wallets w LEFT JOIN customers c ON c.id = w.customer_id
    WHERE w.customer_id > 0 -- las keys de mayoristas no reciben avisos de la tienda
  `).all() as WalletNoticeRow[];
}
export function setWalletNotice(customerId: number, field: "notice_expiring" | "notice_expired" | "notice_low" | "notice_out", value: number): void {
  db.prepare(`UPDATE ai_wallets SET ${field} = ? WHERE customer_id = ?`).run(value, customerId);
}
