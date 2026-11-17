import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// RESEÑAS de la tienda (liordark.com). Solo reales:
//  · «cliente»: la deja un cliente con compra desde «Mis cuentas»;
//    queda «pendiente» hasta que el dueño la publica en el panel.
//  · «panel»: el dueño copia una reseña que le mandó un cliente (por
//    WhatsApp, Facebook…) en Configuración › Reseñas.
// En la tienda solo se ven las «publicada».
// ─────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS store_reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,                              -- NULL si la cargó el dueño
    author      TEXT    NOT NULL,
    stars       INTEGER NOT NULL,
    body        TEXT    NOT NULL,
    source      TEXT    NOT NULL DEFAULT 'cliente',   -- cliente | panel
    status      TEXT    NOT NULL DEFAULT 'pendiente', -- pendiente | publicada | oculta
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_store_reviews_customer ON store_reviews(customer_id) WHERE customer_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_store_reviews_status ON store_reviews(status, updated_at);
`);

// Interruptores del panel: si la tienda muestra las reseñas y las
// preguntas frecuentes. Apagados por defecto (el dueño los prende).
db.exec(`
  CREATE TABLE IF NOT EXISTS store_sections (
    key   TEXT PRIMARY KEY,   -- 'reviews' | 'faq'
    value TEXT NOT NULL
  );
`);

export type StoreSections = { reviewsEnabled: boolean; faqEnabled: boolean };

export function getStoreSections(): StoreSections {
  const rows = db.prepare(`SELECT key, value FROM store_sections`).all() as { key: string; value: string }[];
  const on = (k: string) => rows.some(r => r.key === k && r.value === "1");
  return { reviewsEnabled: on("reviews"), faqEnabled: on("faq") };
}

export function setStoreSection(key: "reviews" | "faq", enabled: boolean): void {
  db.prepare(`
    INSERT INTO store_sections (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, enabled ? "1" : "0");
}

export type ReviewStatus = "pendiente" | "publicada" | "oculta";
export type ReviewSource = "cliente" | "panel";

export type StoreReview = {
  id: number;
  customerId: number | null;
  author: string;
  stars: number;
  body: string;
  source: ReviewSource;
  status: ReviewStatus;
  createdAt: string;
  updatedAt: string;
};

function toReview(r: any): StoreReview {
  return {
    id: r.id, customerId: r.customer_id ?? null, author: r.author, stars: r.stars, body: r.body,
    source: r.source === "panel" ? "panel" : "cliente",
    status: (["pendiente", "publicada", "oculta"].includes(r.status) ? r.status : "pendiente") as ReviewStatus,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function listPublishedReviews(limit = 20): StoreReview[] {
  return (db.prepare(`
    SELECT * FROM store_reviews WHERE status = 'publicada' ORDER BY updated_at DESC, id DESC LIMIT ?
  `).all(limit) as any[]).map(toReview);
}

export function publishedReviewsSummary(): { count: number; avg: number } {
  const r = db.prepare(`SELECT COUNT(*) AS n, AVG(stars) AS avg FROM store_reviews WHERE status = 'publicada'`).get() as { n: number; avg: number | null };
  return { count: r.n, avg: r.avg ? Math.round(r.avg * 10) / 10 : 0 };
}

export function listAllReviews(): StoreReview[] {
  return (db.prepare(`
    SELECT * FROM store_reviews
    ORDER BY CASE status WHEN 'pendiente' THEN 0 WHEN 'publicada' THEN 1 ELSE 2 END, updated_at DESC, id DESC
  `).all() as any[]).map(toReview);
}

export function countPendingReviews(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM store_reviews WHERE status = 'pendiente'`).get() as { n: number }).n;
}

export function getReviewById(id: number): StoreReview | null {
  const r = db.prepare(`SELECT * FROM store_reviews WHERE id = ?`).get(id);
  return r ? toReview(r) : null;
}

export function getCustomerReview(customerId: number): StoreReview | null {
  const r = db.prepare(`SELECT * FROM store_reviews WHERE customer_id = ?`).get(customerId);
  return r ? toReview(r) : null;
}

/** Una por cliente: si ya tenía, se reemplaza y vuelve a «pendiente». */
export function saveCustomerReview(customerId: number, author: string, stars: number, body: string): StoreReview {
  db.prepare(`
    INSERT INTO store_reviews (customer_id, author, stars, body, source, status)
    VALUES (?, ?, ?, ?, 'cliente', 'pendiente')
    ON CONFLICT(customer_id) WHERE customer_id IS NOT NULL DO UPDATE SET
      author = excluded.author, stars = excluded.stars, body = excluded.body,
      status = 'pendiente', updated_at = datetime('now')
  `).run(customerId, author, stars, body);
  return getCustomerReview(customerId)!;
}

export function createPanelReview(author: string, stars: number, body: string): StoreReview {
  const info = db.prepare(`
    INSERT INTO store_reviews (customer_id, author, stars, body, source, status)
    VALUES (NULL, ?, ?, ?, 'panel', 'publicada')
  `).run(author, stars, body);
  return getReviewById(Number(info.lastInsertRowid))!;
}

export function setReviewStatus(id: number, status: ReviewStatus): StoreReview | null {
  db.prepare(`UPDATE store_reviews SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  return getReviewById(id);
}

export function deleteReview(id: number): boolean {
  return db.prepare(`DELETE FROM store_reviews WHERE id = ?`).run(id).changes > 0;
}

// ─── Validación compartida (panel y tienda) ───

const CTRL = /[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩]/g;

export function cleanReviewInput(raw: any): { author: string; stars: number; body: string } | { error: string } {
  const author = String(raw?.author ?? "").replace(CTRL, " ").replace(/\s+/g, " ").trim();
  const body = String(raw?.body ?? "").replace(CTRL, " ").replace(/[ \t]+/g, " ").trim();
  const stars = Number(raw?.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return { error: "Elige de 1 a 5 estrellas." };
  if (author.length < 2 || author.length > 30) return { error: "El nombre debe tener entre 2 y 30 letras." };
  if (body.length < 8) return { error: "Cuéntanos un poquito más (mínimo 8 letras)." };
  if (body.length > 400) return { error: "Máximo 400 letras." };
  if (/https?:\/\/|www\.|\.(com|net|pe|org|xyz)\b/i.test(author + " " + body)) return { error: "La reseña no puede llevar links." };
  return { author, stars, body };
}
