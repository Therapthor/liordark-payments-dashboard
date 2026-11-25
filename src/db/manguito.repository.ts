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

// Qué clave de la lista se usó (para ver el gasto de cada una).
if (!(db.prepare(`PRAGMA table_info(ai_usage)`).all() as { name: string }[]).some(c => c.name === "cred_id")) {
  db.exec(`ALTER TABLE ai_usage ADD COLUMN cred_id TEXT NOT NULL DEFAULT ''`);
}

export type AiConversation = { id: number; title: string; createdAt: string; updatedAt: string; summary: string; compacted: number; summaryUpto: number };
export type AiMessage = {
  id: number; conversationId: number; role: "user" | "assistant"; text: string;
  images: string[]; tier: string; model: string; status: string; createdAt: string;
};

function toMessage(r: any): AiMessage {
  let images: string[] = [];
  try { images = JSON.parse(r.images || "[]"); } catch { images = []; }
  return {
    id: r.id, conversationId: r.conversation_id, role: r.role, text: r.text, images,
    tier: r.tier, model: r.model, status: r.status, createdAt: r.created_at,
  };
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
  const images = listMessages(id).flatMap(m => m.images);
  db.prepare(`DELETE FROM ai_messages WHERE conversation_id = ?`).run(id);
  db.prepare(`DELETE FROM ai_conversations WHERE id = ?`).run(id);
  return images;
});

export function listMessages(conversationId: number): AiMessage[] {
  return (db.prepare(`SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY id ASC`).all(conversationId) as any[]).map(toMessage);
}

export function addMessage(m: {
  conversationId: number; role: "user" | "assistant"; text: string; images?: string[];
  tier?: string; model?: string; status?: string;
}): number {
  const r = db.prepare(`
    INSERT INTO ai_messages (conversation_id, role, text, images, tier, model, status) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(m.conversationId, m.role, m.text, JSON.stringify(m.images ?? []), m.tier ?? "", m.model ?? "", m.status ?? "ok");
  return Number(r.lastInsertRowid);
}

export function saveUpload(id: string, customerId: number, mediaType: string, bytes: number): void {
  db.prepare(`INSERT INTO ai_uploads (id, customer_id, media_type, bytes) VALUES (?, ?, ?, ?)`).run(id, customerId, mediaType, bytes);
}

export function getUpload(id: string): { id: string; customerId: number; mediaType: string } | null {
  const r = db.prepare(`SELECT id, customer_id AS customerId, media_type AS mediaType FROM ai_uploads WHERE id = ?`).get(id) as any;
  return r ?? null;
}

export function deleteUploadRows(ids: string[]): void {
  const del = db.prepare(`DELETE FROM ai_uploads WHERE id = ?`);
  for (const id of ids) del.run(id);
}

export function logUsage(u: {
  customerId: number; kind: "chat" | "router" | "test" | "compact" | "memory"; tier?: string; model: string; credId?: string;
  inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; costUsd: number;
}): void {
  db.prepare(`
    INSERT INTO ai_usage (customer_id, kind, tier, model, cred_id, input_tokens, output_tokens, cache_read, cache_write, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(u.customerId, u.kind, u.tier ?? "", u.model, u.credId ?? "", u.inputTokens, u.outputTokens, u.cacheRead, u.cacheWrite, u.costUsd);
}

// Días y meses en hora de Lima (UTC-5), igual que el resto del panel.
export function spentTodayByCustomer(customerId: number): number {
  const r = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS t FROM ai_usage
    WHERE customer_id = ? AND date(created_at, '-5 hours') = date('now', '-5 hours')
  `).get(customerId) as { t: number };
  return r.t;
}

export function spentThisMonth(): number {
  const r = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS t FROM ai_usage
    WHERE strftime('%Y-%m', created_at, '-5 hours') = strftime('%Y-%m', 'now', '-5 hours')
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

/** Imágenes subidas hace más de `days` días. */
export function oldUploads(days: number): { id: string; mediaType: string }[] {
  return db.prepare(`
    SELECT id, media_type AS mediaType FROM ai_uploads WHERE created_at < datetime('now', ?)
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
    SELECT COUNT(*) AS n FROM ai_usage WHERE customer_id = ? AND kind = 'chat' AND created_at >= datetime(?, 'unixepoch')
  `).get(customerId, Math.floor(sinceMs / 1000)) as { n: number };
  return r.n;
}


export function spentThisMonthByCustomer(customerId: number): number {
  const r = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS t FROM ai_usage
    WHERE customer_id = ? AND strftime('%Y-%m', created_at, '-5 hours') = strftime('%Y-%m', 'now', '-5 hours')
  `).get(customerId) as { t: number };
  return r.t;
}
