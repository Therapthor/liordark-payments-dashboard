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

export type AiConversation = { id: number; title: string; createdAt: string; updatedAt: string };
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
    SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
    FROM ai_conversations WHERE customer_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?
  `).all(customerId, limit) as AiConversation[];
}

export function getConversation(customerId: number, id: number): AiConversation | null {
  const row = db.prepare(`
    SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
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
  customerId: number; kind: "chat" | "router" | "test"; tier?: string; model: string;
  inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; costUsd: number;
}): void {
  db.prepare(`
    INSERT INTO ai_usage (customer_id, kind, tier, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(u.customerId, u.kind, u.tier ?? "", u.model, u.inputTokens, u.outputTokens, u.cacheRead, u.cacheWrite, u.costUsd);
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
