import { randomInt } from "crypto";
import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// MANGUITO PRO — keys de mayoristas. El mayorista compra una key con su
// saldo y se la da a su cliente; el cliente entra en liordark.com/manguito/
// con esa key (sin cuenta en la tienda). Para el chat, cada key es un
// «cliente» con id NEGATIVO (-id de la key): así usa las mismas tablas de
// Manguito (saldo, conversaciones, memoria) sin chocar con los clientes de
// la tienda. Cambiar la key no cambia el id: el historial sigue.
// ─────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS ai_keys (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    wholesaler_id INTEGER NOT NULL,
    key           TEXT    NOT NULL UNIQUE,
    label         TEXT    NOT NULL DEFAULT '',
    status        TEXT    NOT NULL DEFAULT 'active', -- active | off (dada de baja)
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ai_keys_wholesaler ON ai_keys(wholesaler_id);
`);

export type AiKey = {
  id: number; wholesalerId: number; key: string; label: string; status: "active" | "off";
  createdAt: string; updatedAt: string; lastLoginAt: string | null;
};
const COLS = `id, wholesaler_id AS wholesalerId, key, label, status, created_at AS createdAt, updated_at AS updatedAt, last_login_at AS lastLoginAt`;

/** Id que usa el chat para esta key (negativo: nunca choca con un cliente). */
export const keyIdentity = (keyId: number): number => -keyId;

// Sin 0/O/1/I/L para que no se confundan al copiarla a mano.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function randomKey(): string {
  const part = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `MANGO-${part()}-${part()}-${part()}`;
}

/** Lo que escribió el cliente → formato MANGO-XXXX-XXXX-XXXX (o "" si no sirve). */
export function normalizeKey(raw: unknown): string {
  let s = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.startsWith("MANGO")) s = s.slice(5);
  if (s.length !== 12) return "";
  return `MANGO-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

export function getKey(id: number): AiKey | null {
  return (db.prepare(`SELECT ${COLS} FROM ai_keys WHERE id = ?`).get(id) as AiKey | undefined) ?? null;
}

export function findKey(key: string): AiKey | null {
  if (!key) return null;
  return (db.prepare(`SELECT ${COLS} FROM ai_keys WHERE key = ?`).get(key) as AiKey | undefined) ?? null;
}

export function listKeys(wholesalerId: number): AiKey[] {
  return db.prepare(`SELECT ${COLS} FROM ai_keys WHERE wholesaler_id = ? ORDER BY id DESC`).all(wholesalerId) as AiKey[];
}

export function createKey(wholesalerId: number, label: string): AiKey {
  for (let i = 0; i < 5; i++) {
    try {
      const r = db.prepare(`INSERT INTO ai_keys (wholesaler_id, key, label) VALUES (?, ?, ?)`).run(wholesalerId, randomKey(), label);
      return getKey(Number(r.lastInsertRowid))!;
    } catch (err: any) {
      if (!/UNIQUE/i.test(String(err?.message))) throw err;
    }
  }
  throw new Error("No se pudo crear la key.");
}

/** Key nueva para el mismo cliente: la anterior deja de servir; el historial sigue. */
export function rotateKey(id: number): AiKey | null {
  for (let i = 0; i < 5; i++) {
    try {
      db.prepare(`UPDATE ai_keys SET key = ?, updated_at = datetime('now') WHERE id = ?`).run(randomKey(), id);
      return getKey(id);
    } catch (err: any) {
      if (!/UNIQUE/i.test(String(err?.message))) throw err;
    }
  }
  return null;
}

export function setKeyStatus(id: number, status: "active" | "off"): void {
  db.prepare(`UPDATE ai_keys SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
}

export function setKeyLabel(id: number, label: string): void {
  db.prepare(`UPDATE ai_keys SET label = ?, updated_at = datetime('now') WHERE id = ?`).run(label, id);
}

export function touchKeyLogin(id: number): void {
  db.prepare(`UPDATE ai_keys SET last_login_at = datetime('now') WHERE id = ?`).run(id);
}

/** Para el panel: «🔑 Nombre · mayorista». */
export function keyDisplay(id: number): string {
  const r = db.prepare(`
    SELECT k.label, COALESCE(NULLIF(w.display_name, ''), w.phone, '') AS seller
    FROM ai_keys k LEFT JOIN wholesalers w ON w.id = k.wholesaler_id WHERE k.id = ?
  `).get(id) as { label: string; seller: string } | undefined;
  if (!r) return `🔑 Key #${id}`;
  return `🔑 ${r.label || "Key #" + id}${r.seller ? " · " + r.seller : ""}`;
}
