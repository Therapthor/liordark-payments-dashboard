import crypto from "crypto";
import { db } from "./db";
import { sqliteDate } from "./code-links.repository";

// ─────────────────────────────────────────────────────────────
// LINKS DE VENTA — el admin arma un pedido para un cliente de WhatsApp
// (celular + producto) y le manda liordark.com/v/<código>. Al abrirlo el
// cliente entra solo a su cuenta (se crea si no existía) y ve su pedido
// listo para pagar con Yape. Es una compra web normal: el pago se
// confirma solo y la cuenta queda en «Mis cuentas». Así no se mezcla con
// los pagos pendientes de WhatsApp.
// ─────────────────────────────────────────────────────────────

export const SALE_LINK_HOURS = 48;

db.exec(`
  CREATE TABLE IF NOT EXISTS sale_links (
    code           TEXT PRIMARY KEY,
    customer_id    INTEGER NOT NULL,
    phone          TEXT NOT NULL,
    kind           TEXT NOT NULL,              -- platform | combo | custom
    platforms_json TEXT NOT NULL DEFAULT '[]',
    months         INTEGER,
    combo_id       INTEGER,
    title          TEXT NOT NULL,
    price          TEXT NOT NULL,
    new_customer   INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at     TEXT NOT NULL,
    opened_at      TEXT,
    cancelled_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sale_links_created ON sale_links(created_at);
  CREATE TABLE IF NOT EXISTS sale_link_orders (
    order_name TEXT PRIMARY KEY,
    code       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sale_link_orders_code ON sale_link_orders(code);
`);

export type SaleLinkKind = "platform" | "combo" | "custom";
export type SaleLinkState = "pending" | "opened" | "paid" | "expired" | "cancelled";

export type SaleLink = {
  code: string; customerId: number; phone: string; kind: SaleLinkKind;
  platforms: string[]; months: number | null; comboId: number | null;
  title: string; price: string; newCustomer: boolean;
  createdAt: string; expiresAt: string; openedAt: string | null; cancelledAt: string | null;
};

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function toLink(r: any): SaleLink {
  let platforms: string[] = [];
  try { platforms = JSON.parse(r.platforms_json || "[]"); } catch { /* vacío */ }
  return {
    code: r.code, customerId: r.customer_id, phone: r.phone, kind: r.kind,
    platforms, months: r.months ?? null, comboId: r.combo_id ?? null,
    title: r.title, price: r.price, newCustomer: !!r.new_customer,
    createdAt: r.created_at, expiresAt: r.expires_at, openedAt: r.opened_at ?? null, cancelledAt: r.cancelled_at ?? null,
  };
}

export function createSaleLink(p: {
  customerId: number; phone: string; kind: SaleLinkKind; platforms: string[];
  months: number | null; comboId: number | null; title: string; price: string; newCustomer: boolean;
}): SaleLink {
  let code = "";
  for (let i = 0; i < 12; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  db.prepare(`
    INSERT INTO sale_links (code, customer_id, phone, kind, platforms_json, months, combo_id, title, price, new_customer, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
  `).run(code, p.customerId, p.phone, p.kind, JSON.stringify(p.platforms), p.months, p.comboId,
    p.title.slice(0, 160), p.price, p.newCustomer ? 1 : 0, `+${SALE_LINK_HOURS} hours`);
  return findSaleLink(code) as SaleLink;
}

export function findSaleLink(code: string): SaleLink | null {
  if (!/^[A-Za-z0-9]{8,20}$/.test(code)) return null;
  const r = db.prepare(`SELECT * FROM sale_links WHERE code = ?`).get(code);
  return r ? toLink(r) : null;
}

export function listSaleLinks(limit = 60): SaleLink[] {
  return (db.prepare(`SELECT * FROM sale_links ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(limit) as any[]).map(toLink);
}

export function markSaleLinkOpened(code: string): void {
  db.prepare(`UPDATE sale_links SET opened_at = COALESCE(opened_at, datetime('now')) WHERE code = ?`).run(code);
}

export function cancelSaleLink(code: string): boolean {
  return db.prepare(`UPDATE sale_links SET cancelled_at = datetime('now') WHERE code = ? AND cancelled_at IS NULL`).run(code).changes === 1;
}

export function addSaleLinkOrder(code: string, orderName: string): void {
  db.prepare(`INSERT OR IGNORE INTO sale_link_orders (order_name, code) VALUES (?, ?)`).run(orderName, code);
}

/** ¿Alguna orden del link ya se pagó? (pago Yape confirmado para esa orden). */
export function isSaleLinkPaid(code: string): boolean {
  return !!db.prepare(`
    SELECT 1 FROM sale_link_orders o JOIN payments p ON p.order_name = o.order_name
    WHERE o.code = ? AND p.status = 'matched' LIMIT 1
  `).get(code);
}

export function saleLinkState(link: SaleLink): SaleLinkState {
  if (isSaleLinkPaid(link.code)) return "paid";
  if (link.cancelledAt) return "cancelled";
  const exp = sqliteDate(link.expiresAt);
  if (exp && exp.getTime() <= Date.now()) return "expired";
  return link.openedAt ? "opened" : "pending";
}

/** Se puede usar para entrar y pagar. */
export function isSaleLinkUsable(state: SaleLinkState): boolean {
  return state === "pending" || state === "opened";
}
