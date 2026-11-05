import crypto from "crypto";
import fs from "fs";
import path from "path";
import { db } from "../db/db";
import { env } from "../config/env";
import { normalizePeruPhone } from "../utils/phone.util";

// ─────────────────────────────────────────────────────────────
// CURSO "Tus Primeros S/ 1,000 – Cuentas Streaming" (liordark.com/curso)
//
// Es como un producto más: se paga con el mismo Yape automático (pedido
// web del bot con `course`), y al confirmarse el pago el bot llama a
// /api/stock/course-paid → markCoursePurchasePaid. El acceso es de por
// vida mientras exista una compra 'paid' del cliente.
//
// Videos (ep1..ep5.mp4) y la plantilla Excel viven en disco, en
// data/course-media/ — se suben desde el panel (🎓 Curso) por partes.
// ─────────────────────────────────────────────────────────────

export const COURSE_ID = "primeros-1000";
export const COURSE_TITLE = "Tus Primeros S/ 1,000 – Cuentas Streaming";
export const COURSE_DEFAULT_PRICE = 39.9;
export const COURSE_GIFT_CENTS = 1000; // S/ 10 de saldo mayorista de regalo
export const COMPLETE_RATIO = 0.9;     // episodio visto al 90%

export type CueType = "mayorista" | "plantilla" | "cupon";
export type Cue = { id: string; start: number; end: number; type: CueType };

export type Episode = {
  n: number;
  step: string;
  title: string;
  summary: string;
};

export const STEPS = ["INICIO", "ENTENDER", "PLANEAR", "GESTIONAR", "FIDELIZAR"];

export const EPISODES: Episode[] = [
  { n: 1, step: "INICIO", title: "Tus primeros S/ 1,000: el negocio de las cuentas streaming",
    summary: "Todos pagan streaming cada mes, y ese pago puede ser tu negocio. Mira lo que vas a aprender en 4 pasos." },
  { n: 2, step: "ENTENDER", title: "Cómo funcionan las cuentas: completas y perfiles",
    summary: "Qué es una cuenta completa y qué es un perfil, cuántos perfiles trae cada plataforma y por qué conviene la cuenta completa." },
  { n: 3, step: "PLANEAR", title: "Cuánto ganas y dónde consigues tus cuentas",
    summary: "Cuánto cobrar por perfil, cuánto ganas con cada plataforma y cómo comprar en el Panel Mayorista." },
  { n: 4, step: "GESTIONAR", title: "Cómo vender y organizar a tus clientes",
    summary: "Sube 2 videos al día y prueba un estilo distinto cada día. Repite el que funciona y organiza a tus clientes con la plantilla gratis." },
  { n: 5, step: "FIDELIZAR", title: "Que tus clientes te compren una y otra vez",
    summary: "Atención rápida, la regla de renovación y premios para tus clientes fieles. ¡Cierra el curso con tu regalo!" },
];

// Tiempos por defecto (segundos) — se ajustan desde el panel cuando los
// videos ya estén subidos. end = hasta cuándo el panel queda resaltado.
const DEFAULT_CUES: Record<number, Cue[]> = {
  1: [],
  2: [],
  3: [{ id: "mayorista", start: 120, end: 180, type: "mayorista" }],
  4: [{ id: "plantilla", start: 90, end: 150, type: "plantilla" }],
  5: [{ id: "cupon", start: 150, end: 210, type: "cupon" }],
};

const CUE_TYPES: CueType[] = ["mayorista", "plantilla", "cupon"];

// ─── Archivos ────────────────────────────────────────────────

export const MEDIA_DIR = path.resolve(process.cwd(), "data/course-media");
export const MEDIA_KINDS = ["ep1", "ep2", "ep3", "ep4", "ep5", "gestor"] as const;
export type MediaKind = typeof MEDIA_KINDS[number];

export function isMediaKind(k: string): k is MediaKind {
  return (MEDIA_KINDS as readonly string[]).includes(k);
}

export function mediaPath(kind: MediaKind): string {
  return path.join(MEDIA_DIR, kind === "gestor" ? "gestor.xlsx" : kind + ".mp4");
}

export function ensureMediaDir(): void {
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

export function mediaStatus(): Record<MediaKind, { exists: boolean; size: number; updatedAt: string | null }> {
  const out = {} as Record<MediaKind, { exists: boolean; size: number; updatedAt: string | null }>;
  for (const k of MEDIA_KINDS) {
    try {
      const st = fs.statSync(mediaPath(k));
      out[k] = { exists: true, size: st.size, updatedAt: st.mtime.toISOString() };
    } catch {
      out[k] = { exists: false, size: 0, updatedAt: null };
    }
  }
  return out;
}

// ─── Ajustes (precio y cues, editables desde el panel) ───────

function getSetting(key: string): string | null {
  const row = db.prepare(`SELECT value FROM course_settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

function setSetting(key: string, value: string): void {
  db.prepare(`
    INSERT INTO course_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function getCoursePrice(): number {
  const v = Number(getSetting("price"));
  return Number.isFinite(v) && v > 0 ? v : COURSE_DEFAULT_PRICE;
}

export function setCoursePrice(price: number): void {
  setSetting("price", String(Math.round(price * 100) / 100));
}

export function getCues(): Record<number, Cue[]> {
  const raw = getSetting("cues");
  if (!raw) return DEFAULT_CUES;
  try {
    const parsed = JSON.parse(raw);
    return sanitizeCues(parsed) ?? DEFAULT_CUES;
  } catch {
    return DEFAULT_CUES;
  }
}

/** Valida el JSON de cues que manda el panel. null = inválido. */
export function sanitizeCues(input: unknown): Record<number, Cue[]> | null {
  if (!input || typeof input !== "object") return null;
  const out: Record<number, Cue[]> = {};
  for (const ep of EPISODES) {
    const list = (input as Record<string, unknown>)[String(ep.n)];
    if (list === undefined) { out[ep.n] = []; continue; }
    if (!Array.isArray(list)) return null;
    const cues: Cue[] = [];
    for (const c of list) {
      const id = String((c as any)?.id ?? "").trim();
      const type = String((c as any)?.type ?? "") as CueType;
      const start = Number((c as any)?.start);
      const end = Number((c as any)?.end);
      if (!/^[a-z0-9_-]{2,30}$/i.test(id) || !CUE_TYPES.includes(type)) return null;
      if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end < start) return null;
      cues.push({ id, type, start, end });
    }
    out[ep.n] = cues;
  }
  return out;
}

export function setCues(cues: Record<number, Cue[]>): void {
  setSetting("cues", JSON.stringify(cues));
}

function allCueIds(): Set<string> {
  const ids = new Set<string>();
  for (const list of Object.values(getCues())) for (const c of list) ids.add(c.id);
  return ids;
}

function cueIdsOfType(type: CueType): string[] {
  const ids: string[] = [];
  for (const list of Object.values(getCues())) for (const c of list) if (c.type === type) ids.push(c.id);
  return ids;
}

// ─── Compras ─────────────────────────────────────────────────

export type CoursePurchase = {
  id: number; courseId: string; customerId: number; phone: string; orderName: string;
  amount: string; status: string; source: string; createdAt: string; paidAt: string | null;
};

function toPurchase(r: any): CoursePurchase {
  return {
    id: r.id, courseId: r.course_id, customerId: r.customer_id, phone: r.phone, orderName: r.order_name,
    amount: r.amount, status: r.status, source: r.source, createdAt: r.created_at, paidAt: r.paid_at,
  };
}

export function findPaidPurchase(customerId: number): CoursePurchase | null {
  const r = db.prepare(`
    SELECT * FROM course_purchases WHERE customer_id = ? AND course_id = ? AND status = 'paid'
    ORDER BY id ASC LIMIT 1
  `).get(customerId, COURSE_ID);
  return r ? toPurchase(r) : null;
}

export function hasCourseAccess(customerId: number): boolean {
  return !!findPaidPurchase(customerId);
}

export function createPendingPurchase(customerId: number, phone: string, orderName: string, amount: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO course_purchases (course_id, customer_id, phone, order_name, amount, status, source)
    VALUES (?, ?, ?, ?, ?, 'pending', 'yape')
  `).run(COURSE_ID, customerId, normalizePeruPhone(phone), orderName, amount);
}

export function findPurchaseByOrder(orderName: string): CoursePurchase | null {
  const r = db.prepare(`SELECT * FROM course_purchases WHERE order_name = ?`).get(orderName);
  return r ? toPurchase(r) : null;
}

/** Llamado por el bot al confirmarse el Yape. Idempotente. */
export function markCoursePurchasePaid(orderName: string, amount?: string): { ok: boolean; alreadyPaid?: boolean } {
  const p = findPurchaseByOrder(orderName);
  if (!p) return { ok: false };
  if (p.status === "paid") return { ok: true, alreadyPaid: true };
  db.prepare(`
    UPDATE course_purchases SET status = 'paid', paid_at = datetime('now'), amount = COALESCE(?, amount)
    WHERE id = ?
  `).run(amount ?? null, p.id);
  return { ok: true };
}

/** Acceso manual desde el panel (ej. pagó por otro medio). */
export function grantCourseManually(customerId: number, phone: string, amount: string): CoursePurchase {
  const existing = findPaidPurchase(customerId);
  if (existing) return existing;
  const orderName = "curso-admin-" + customerId + "-" + Date.now();
  db.prepare(`
    INSERT INTO course_purchases (course_id, customer_id, phone, order_name, amount, status, source, paid_at)
    VALUES (?, ?, ?, ?, ?, 'paid', 'admin', datetime('now'))
  `).run(COURSE_ID, customerId, normalizePeruPhone(phone), orderName, amount);
  return findPurchaseByOrder(orderName) as CoursePurchase;
}

export function revokeCoursePurchase(id: number): boolean {
  return db.prepare(`UPDATE course_purchases SET status = 'revoked' WHERE id = ? AND status = 'paid'`).run(id).changes > 0;
}

/** Pedidos que nunca se pagaron (el bot los borra a los 5 min) — limpieza diaria. */
export function cleanOldPendingPurchases(): number {
  return db.prepare(`
    DELETE FROM course_purchases WHERE status = 'pending' AND created_at < datetime('now', '-1 day')
  `).run().changes;
}

// ─── Progreso ────────────────────────────────────────────────

export type EpisodeProgress = { episode: number; lastSecond: number; maxSecond: number; duration: number; completed: boolean };

export function getProgress(customerId: number): EpisodeProgress[] {
  const rows = db.prepare(`
    SELECT episode, last_second, max_second, duration, completed_at FROM course_progress
    WHERE customer_id = ? AND course_id = ?
  `).all(customerId, COURSE_ID) as any[];
  return rows.map(r => ({
    episode: r.episode, lastSecond: r.last_second, maxSecond: r.max_second,
    duration: r.duration, completed: !!r.completed_at,
  }));
}

/**
 * Guarda el segundo actual. Se marca completo al pasar el 90%; una vez
 * completo queda así aunque vuelva a verlo desde el inicio. Al completar,
 * también se desbloquean los recursos de ese episodio (por si el alumno
 * adelantó el video y se saltó el momento del cue).
 */
export function saveProgress(customerId: number, episode: number, second: number, duration: number): EpisodeProgress {
  const sec = Math.max(0, second);
  const dur = Math.max(0, duration);
  const done = dur > 0 && sec >= dur * COMPLETE_RATIO;
  db.prepare(`
    INSERT INTO course_progress (customer_id, course_id, episode, last_second, max_second, duration, completed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? THEN datetime('now') ELSE NULL END, datetime('now'))
    ON CONFLICT(customer_id, course_id, episode) DO UPDATE SET
      last_second  = excluded.last_second,
      max_second   = MAX(course_progress.max_second, excluded.max_second),
      duration     = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE course_progress.duration END,
      completed_at = COALESCE(course_progress.completed_at, excluded.completed_at),
      updated_at   = datetime('now')
  `).run(customerId, COURSE_ID, episode, sec, sec, dur, done ? 1 : 0);

  if (done) {
    for (const c of getCues()[episode] ?? []) unlockCue(customerId, c.id);
  }
  return getProgress(customerId).find(p => p.episode === episode) as EpisodeProgress;
}

// ─── Recursos desbloqueados (cues) ───────────────────────────

export function getUnlocks(customerId: number): string[] {
  return (db.prepare(`SELECT cue_id FROM course_unlocks WHERE customer_id = ? AND course_id = ?`)
    .all(customerId, COURSE_ID) as { cue_id: string }[]).map(r => r.cue_id);
}

export function unlockCue(customerId: number, cueId: string): boolean {
  if (!allCueIds().has(cueId)) return false;
  db.prepare(`INSERT OR IGNORE INTO course_unlocks (customer_id, course_id, cue_id) VALUES (?, ?, ?)`)
    .run(customerId, COURSE_ID, cueId);
  return true;
}

export function hasUnlockedType(customerId: number, type: CueType): boolean {
  const unlocked = new Set(getUnlocks(customerId));
  return cueIdsOfType(type).some(id => unlocked.has(id));
}

// ─── Descargas ───────────────────────────────────────────────

export function recordDownload(customerId: number, resource: string): void {
  db.prepare(`INSERT INTO course_downloads (customer_id, course_id, resource) VALUES (?, ?, ?)`)
    .run(customerId, COURSE_ID, resource);
}

export function downloadCount(customerId: number, resource: string): number {
  const r = db.prepare(`
    SELECT COUNT(*) AS n FROM course_downloads WHERE customer_id = ? AND course_id = ? AND resource = ?
  `).get(customerId, COURSE_ID, resource) as { n: number };
  return r.n;
}

// ─── Cupón −30% (curso avanzado) ─────────────────────────────

const COUPON_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function getCoupon(customerId: number): string | null {
  const r = db.prepare(`SELECT code FROM course_coupons WHERE customer_id = ? AND course_id = ?`)
    .get(customerId, COURSE_ID) as { code: string } | undefined;
  return r ? r.code : null;
}

export function getOrCreateCoupon(customerId: number): string {
  const existing = getCoupon(customerId);
  if (existing) return existing;
  for (let attempt = 0; attempt < 10; attempt++) {
    let suffix = "";
    for (let i = 0; i < 5; i++) suffix += COUPON_CHARS[crypto.randomInt(COUPON_CHARS.length)];
    const code = "MANGO30-" + suffix;
    const info = db.prepare(`INSERT OR IGNORE INTO course_coupons (customer_id, course_id, code) VALUES (?, ?, ?)`)
      .run(customerId, COURSE_ID, code);
    if (info.changes > 0) return code;
    const again = getCoupon(customerId);
    if (again) return again;
  }
  throw new Error("No se pudo generar el cupón.");
}

// ─── Acceso mayorista de regalo ──────────────────────────────

export type WholesaleClaim = {
  id: number; purchaseId: number; phone: string; panelName: string;
  wholesalerId: number; createdNew: boolean; giftCents: number; createdAt: string;
};

export function findClaimForPurchase(purchaseId: number): WholesaleClaim | null {
  const r = db.prepare(`SELECT * FROM course_wholesale_claims WHERE purchase_id = ?`).get(purchaseId) as any;
  if (!r) return null;
  return {
    id: r.id, purchaseId: r.purchase_id, phone: r.phone, panelName: r.panel_name,
    wholesalerId: r.wholesaler_id, createdNew: !!r.created_new, giftCents: r.gift_cents, createdAt: r.created_at,
  };
}

export function insertClaim(c: Omit<WholesaleClaim, "id" | "createdAt"> & { customerId: number }): void {
  db.prepare(`
    INSERT INTO course_wholesale_claims (purchase_id, customer_id, phone, panel_name, wholesaler_id, created_new, gift_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(c.purchaseId, c.customerId, c.phone, c.panelName, c.wholesalerId, c.createdNew ? 1 : 0, c.giftCents);
}

/** "51987654412" → "9•• ••• •12" */
export function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, "").slice(-9);
  if (d.length < 9) return "•••";
  return d[0] + "•• ••• •" + d.slice(-2);
}

// ─── Link firmado del video (vence) ──────────────────────────

const STREAM_TTL_SEC = 4 * 60 * 60;

function signStream(customerId: number, ep: number, exp: number): string {
  return crypto.createHmac("sha256", env.SESSION_SECRET)
    .update("course-stream:" + customerId + ":" + ep + ":" + exp)
    .digest("base64url");
}

export function streamUrl(customerId: number, ep: number): string {
  const exp = Math.floor(Date.now() / 1000) + STREAM_TTL_SEC;
  return "/api/course/stream/" + ep + "?exp=" + exp + "&sig=" + signStream(customerId, ep, exp);
}

export function verifyStream(customerId: number, ep: number, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(signStream(customerId, ep, exp));
  const given = Buffer.from(String(sig));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// ─── Panel admin: resumen ────────────────────────────────────

export function adminOverview() {
  const purchases = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM course_progress g WHERE g.customer_id = p.customer_id AND g.course_id = p.course_id AND g.completed_at IS NOT NULL) AS completed_eps,
      (SELECT COUNT(*) FROM course_downloads d WHERE d.customer_id = p.customer_id AND d.course_id = p.course_id) AS downloads,
      (SELECT code FROM course_coupons c WHERE c.customer_id = p.customer_id AND c.course_id = p.course_id) AS coupon,
      (SELECT panel_name FROM course_wholesale_claims w WHERE w.purchase_id = p.id) AS panel_name,
      (SELECT gift_cents FROM course_wholesale_claims w WHERE w.purchase_id = p.id) AS gift_cents,
      (SELECT phone FROM course_wholesale_claims w WHERE w.purchase_id = p.id) AS claim_phone
    FROM course_purchases p
    WHERE p.course_id = ? AND p.status IN ('paid', 'revoked')
    ORDER BY p.id DESC
  `).all(COURSE_ID) as any[];

  const paid = purchases.filter(p => p.status === "paid");
  const incomeCents = paid.reduce((s, p) => s + Math.round(parseFloat(p.amount || "0") * 100), 0);
  const giftCents = (db.prepare(`SELECT COALESCE(SUM(gift_cents), 0) AS n FROM course_wholesale_claims`).get() as { n: number }).n;

  return {
    courseId: COURSE_ID,
    title: COURSE_TITLE,
    price: getCoursePrice(),
    episodes: EPISODES,
    cues: getCues(),
    media: mediaStatus(),
    totals: {
      students: paid.length,
      incomeCents,
      giftCents,
      netCents: incomeCents - giftCents,
      finished: paid.filter(p => p.completed_eps >= EPISODES.length).length,
    },
    students: purchases.map(p => ({
      id: p.id,
      phone: p.phone,
      amount: p.amount,
      status: p.status,
      source: p.source,
      paidAt: p.paid_at,
      completedEpisodes: p.completed_eps,
      downloads: p.downloads,
      coupon: p.coupon,
      panelName: p.panel_name,
      claimPhone: p.claim_phone,
      giftCents: p.gift_cents ?? 0,
    })),
  };
}
