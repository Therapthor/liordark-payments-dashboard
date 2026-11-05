import crypto from "crypto";
import { db } from "./db";
import { sqliteDate } from "./code-links.repository";

// Links de un solo uso para que el cliente cambie su PIN
// (liordark.com/cambiar-pin/<token>). Duran PIN_LINK_MINUTES.

export const PIN_LINK_MINUTES = 10;

export type PinLink = {
  token: string; customerId: number; createdAt: string; expiresAt: string; openedAt: string | null; usedAt: string | null;
};

const TOKEN_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function toLink(r: any): PinLink {
  return { token: r.token, customerId: r.customer_id, createdAt: r.created_at, expiresAt: r.expires_at, openedAt: r.opened_at, usedAt: r.used_at };
}

/** Crea un link nuevo; los anteriores sin usar del mismo cliente se anulan. */
export function createPinLink(customerId: number): PinLink {
  let token = "";
  for (let i = 0; i < 12; i++) token += TOKEN_CHARS[crypto.randomInt(TOKEN_CHARS.length)];
  db.prepare(`DELETE FROM pin_links WHERE customer_id = ? AND used_at IS NULL`).run(customerId);
  db.prepare(`INSERT INTO pin_links (token, customer_id, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .run(token, customerId, `+${PIN_LINK_MINUTES} minutes`);
  return findPinLink(token) as PinLink;
}

export function findPinLink(token: string): PinLink | null {
  const r = db.prepare(`SELECT * FROM pin_links WHERE token = ?`).get(token);
  return r ? toLink(r) : null;
}

export function markPinLinkOpened(token: string): void {
  db.prepare(`UPDATE pin_links SET opened_at = COALESCE(opened_at, datetime('now')) WHERE token = ?`).run(token);
}

/** Marca el link como usado. Devuelve false si ya estaba usado (carrera). */
export function usePinLink(token: string): boolean {
  return db.prepare(`UPDATE pin_links SET used_at = datetime('now') WHERE token = ? AND used_at IS NULL`).run(token).changes === 1;
}

export type PinLinkState = "active" | "used" | "expired";

export function pinLinkState(link: PinLink): PinLinkState {
  if (link.usedAt) return "used";
  const exp = sqliteDate(link.expiresAt);
  return exp && exp.getTime() <= Date.now() ? "expired" : "active";
}

/** Borra los vencidos sin usar y los usados de más de 1 día. */
export function cleanPinLinks(): number {
  return db.prepare(`
    DELETE FROM pin_links
    WHERE (used_at IS NULL AND expires_at <= datetime('now'))
       OR (used_at IS NOT NULL AND used_at < datetime('now', '-1 day'))
  `).run().changes;
}
