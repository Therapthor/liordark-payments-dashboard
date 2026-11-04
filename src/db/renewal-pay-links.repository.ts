import crypto from "crypto";
import { db } from "./db";
import { getProfileById, setProfileRenewal, limaTodayISOLocal, addDaysISOLocal } from "./access.repository";

// ─────────────────────────────────────────────────────────────
// LINK DE PAGO DE RENOVACIÓN (botón 💬 Reno-manual del panel)
//
// El admin elige las cuentas por vencer de un cliente; se arma UN link
// (liordark.com/renovar.html?pack=CODE). El link vale hasta la medianoche
// (hora Lima) del día en que se creó. En la página el cliente marca qué
// renovar; cada selección reserva un monto Yape único en el bot (5 min,
// luego el bot lo borra y la página pide otro). Cuando el bot detecta el
// pago, confirmRenewalLog → applyPayLinkPayment marca "✅ Renueva" a los
// perfiles de lo que eligió en ESA orden.
//
// Ítems:
//   - "single": un perfil suelto, precio del catálogo.
//   - "combo":  todos los perfiles de un combo (order_ref "combo:<orden>"),
//               se renueva completo al precio que pagó la vez anterior.
// Descuento: 10% sobre las plataformas sueltas si elige 2 o más a la vez
// (los combos ya tienen su propio precio).
// ─────────────────────────────────────────────────────────────

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH   = 8;
export const MULTI_DISCOUNT_MIN = 2;
export const MULTI_DISCOUNT_PCT = 10;

export type PayLinkItem = {
  key:         string;           // "p<profileId>" o "c:<orderName del combo>"
  kind:        "single" | "combo";
  label:       string;           // "Netflix" o "Combo Netflix + Disney+"
  platforms:   string[];
  profileIds:  number[];
  profileName: string;
  email:       string;
  expiresAt:   string | null;    // la fecha más próxima (en combos, la del ítem que vence antes)
  price:       string;           // "10.00"
  priceSource?: "catalog" | "paid" | "catalog_sum";
};

export type PayLink = {
  code:           string;
  clientPhone:    string;
  items:          PayLinkItem[];
  expiresAt:      string;
  currentOrder:   string | null;
  currentAmount:  string | null;
  currentOrderAt: string | null;
  currentKeys:    string[];
};

function last9(phone: string): string {
  return String(phone).replace(/\D/g, "").slice(-9);
}

function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** Fin del día de hoy en Lima (UTC-5 fijo, Perú no usa horario de verano). */
export function endOfTodayLimaISO(): string {
  const tomorrow = addDaysISOLocal(limaTodayISOLocal(), 1);
  return new Date(tomorrow + "T00:00:00-05:00").toISOString();
}

/** Subtotal, descuento (10% a las sueltas si son 3+) y total de una selección. */
export function priceSelection(items: PayLinkItem[]): { subtotal: string; discount: string; total: string; singles: number } {
  const singles = items.filter(i => i.kind === "single");
  const singlesSum = singles.reduce((s, i) => s + parseFloat(i.price), 0);
  const combosSum  = items.filter(i => i.kind === "combo").reduce((s, i) => s + parseFloat(i.price), 0);
  const discount = singles.length >= MULTI_DISCOUNT_MIN ? singlesSum * MULTI_DISCOUNT_PCT / 100 : 0;
  const subtotal = singlesSum + combosSum;
  return { subtotal: money(subtotal), discount: money(discount), total: money(subtotal - discount), singles: singles.length };
}

export type PayLinkCandidate = PayLinkItem & {
  renewalStatus: string;   // "yes" si ya está todo pagado
  eligible:      boolean;
  reason:        string;
};

type ProfileRow = {
  profileId: number; profileName: string; renewalStatus: string; orderRef: string;
  platform: string; email: string; expiresAt: string | null; platformTag: string; price: string;
};

function platformBlockReason(platform: string): string {
  if (/youtube/i.test(platform))       return "No es renovable (se compra de nuevo)";
  if (/canva|gemini/i.test(platform))  return "Se activa a mano";
  return "";
}

/** Monto que pagó el cliente por un pedido (pago Yape emparejado), o null. */
function paidAmountForOrder(orderName: string): number | null {
  const row = db.prepare(`
    SELECT amount FROM payments WHERE order_name = ? ORDER BY id DESC LIMIT 1
  `).get(orderName) as { amount: string } | undefined;
  const n = row ? parseFloat(String(row.amount).replace(",", ".")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Cuentas (perfiles sueltos y combos) del cliente que podrían ir en el link. */
export function listPayLinkCandidates(
  clientPhone: string,
  daysLeftOf: (expiresAt: string | null) => number | null
): PayLinkCandidate[] {
  const digits = last9(clientPhone);
  if (digits.length < 9) return [];

  const rows = db.prepare(`
    SELECT p.id AS profileId, p.profile_name AS profileName, p.renewal_status AS renewalStatus,
           p.order_ref AS orderRef, a.platform AS platform, a.email AS email,
           COALESCE(p.expires_override, a.expires_at) AS expiresAt,
           COALESCE(c.title, '') AS platformTag, COALESCE(c.price, '') AS price
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    LEFT JOIN catalog_products c ON UPPER(TRIM(c.platform)) = a.platform
    WHERE substr(p.client_phone, -9) = ?
    ORDER BY expiresAt ASC
  `).all(digits) as ProfileRow[];

  const out: PayLinkCandidate[] = [];
  const combos = new Map<string, ProfileRow[]>();

  for (const r of rows) {
    if (r.orderRef && r.orderRef.startsWith("combo:")) {
      const list = combos.get(r.orderRef) ?? [];
      list.push(r);
      combos.set(r.orderRef, list);
      continue;
    }
    const priceNum = parseFloat(String(r.price || "").replace(",", "."));
    const left = daysLeftOf(r.expiresAt);
    let reason = platformBlockReason(r.platform);
    if (!reason && (!Number.isFinite(priceNum) || priceNum <= 0)) reason = "Sin precio en el catálogo";
    if (!reason && (left === null || left <= 0))                 reason = "Vence hoy o ya venció";
    if (!reason && r.renewalStatus === "yes")                     reason = "Ya pagó su renovación";
    out.push({
      key: "p" + r.profileId, kind: "single",
      label: r.platformTag || r.platform, platforms: [r.platform], profileIds: [r.profileId],
      profileName: r.profileName || "", email: r.email, expiresAt: r.expiresAt ?? null,
      price: Number.isFinite(priceNum) ? money(priceNum) : "0.00", priceSource: "catalog",
      renewalStatus: r.renewalStatus || "", eligible: reason === "", reason,
    });
  }

  for (const [orderRef, list] of combos) {
    const orderName = orderRef.slice("combo:".length);
    const earliest = list.map(r => r.expiresAt).filter((d): d is string => !!d).sort()[0] ?? null;
    const left = daysLeftOf(earliest);
    const tags = list.map(r => r.platformTag || r.platform);
    const paid = paidAmountForOrder(orderName);
    const catalogSum = list.reduce((s, r) => s + (parseFloat(String(r.price || "").replace(",", ".")) || 0), 0);
    const price = paid ?? catalogSum;
    const allYes = list.every(r => r.renewalStatus === "yes");

    let reason = list.map(r => platformBlockReason(r.platform)).find(Boolean) ?? "";
    if (reason) reason = "Incluye una plataforma que no se renueva así";
    if (!reason && !(price > 0))                  reason = "Sin precio";
    if (!reason && (left === null || left <= 0))  reason = "Vence hoy o ya venció";
    if (!reason && allYes)                        reason = "Ya pagó su renovación";

    out.push({
      key: "c:" + orderName, kind: "combo",
      label: "Combo " + tags.join(" + "), platforms: list.map(r => r.platform), profileIds: list.map(r => r.profileId),
      profileName: "", email: [...new Set(list.map(r => r.email))].join(", "), expiresAt: earliest,
      price: money(price), priceSource: paid !== null ? "paid" : "catalog_sum",
      renewalStatus: allYes ? "yes" : "", eligible: reason === "", reason,
    });
  }

  return out.sort((a, b) => String(a.expiresAt ?? "9999").localeCompare(String(b.expiresAt ?? "9999")));
}

function toItem(c: PayLinkCandidate): PayLinkItem {
  const { renewalStatus, eligible, reason, ...item } = c;
  return item;
}

export function createPayLink(clientPhone: string, candidates: PayLinkCandidate[]): PayLink {
  const items = candidates.map(toItem);
  const total = priceSelection(items).total;
  const expiresAt = endOfTodayLimaISO();
  for (let attempt = 0; attempt < 5; attempt++) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    const exists = db.prepare(`SELECT 1 FROM renewal_pay_links WHERE code = ?`).get(code);
    if (exists) continue;
    db.prepare(`
      INSERT INTO renewal_pay_links (code, client_phone, items_json, total, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(code, clientPhone, JSON.stringify(items), total, expiresAt);
    return findPayLink(code)!;
  }
  throw new Error("No se pudo generar un link único.");
}

/** Links creados con el formato anterior (un perfil por ítem, sin key). */
function normalizeItem(raw: any): PayLinkItem {
  if (raw && raw.key) return raw as PayLinkItem;
  return {
    key: "p" + raw.profileId, kind: "single", label: raw.platformTag || raw.platform,
    platforms: [raw.platform], profileIds: [raw.profileId], profileName: raw.profileName || "",
    email: raw.email || "", expiresAt: raw.expiresAt ?? null, price: raw.price, priceSource: "catalog",
  };
}

function toPayLink(row: any): PayLink {
  let items: PayLinkItem[] = [];
  try { items = (JSON.parse(row.items_json) as any[]).map(normalizeItem); } catch { /* fila corrupta → sin items */ }
  let currentKeys: string[] = [];
  try { currentKeys = JSON.parse(row.current_keys || "[]"); } catch { /* sin selección */ }
  return {
    code:           row.code,
    clientPhone:    row.client_phone,
    items,
    expiresAt:      row.expires_at,
    currentOrder:   row.current_order ?? null,
    currentAmount:  row.current_amount ?? null,
    currentOrderAt: row.current_order_at ?? null,
    currentKeys,
  };
}

export function findPayLink(code: string): PayLink | null {
  const row = db.prepare(`SELECT * FROM renewal_pay_links WHERE code = ?`).get(String(code).toUpperCase());
  return row ? toPayLink(row) : null;
}

export function isPayLinkExpired(link: PayLink): boolean {
  return new Date(link.expiresAt).getTime() < Date.now();
}

export type PayLinkItemState = PayLinkItem & { paid: boolean; valid: boolean };

/**
 * Estado actual de cada ítem: paid = todos sus perfiles ya están "✅
 * Renueva"; valid = sus perfiles siguen siendo de ese celular (si el admin
 * liberó alguno después de mandar el link, ya no se cobra por él).
 */
export function itemStates(link: PayLink): PayLinkItemState[] {
  return link.items.map(it => {
    const profiles = it.profileIds.map(id => getProfileById(id));
    const valid = profiles.every(p => !!p && last9(p.clientPhone) === last9(link.clientPhone));
    const paid  = valid && profiles.every(p => p!.renewalStatus === "yes");
    return { ...it, paid, valid };
  });
}

export function setPayLinkOrder(code: string, orderName: string, amount: string, keys: string[]): void {
  db.prepare(`
    UPDATE renewal_pay_links SET current_order = ?, current_amount = ?, current_order_at = ?, current_keys = ? WHERE code = ?
  `).run(orderName, amount, new Date().toISOString(), JSON.stringify(keys), code);
  db.prepare(`
    INSERT OR IGNORE INTO renewal_pay_link_orders (order_name, code, amount, keys_json) VALUES (?, ?, ?, ?)
  `).run(orderName, code, amount, JSON.stringify(keys));
}

export function isPayLinkOrderPaid(code: string, orderName: string): boolean {
  const row = db.prepare(`SELECT paid_at FROM renewal_pay_link_orders WHERE order_name = ? AND code = ?`)
    .get(orderName, code) as { paid_at: string | null } | undefined;
  return !!row?.paid_at;
}

/**
 * Llamado al confirmarse el pago de una orden (confirmRenewalLog). Si la
 * orden es de un link de pago, marca "✅ Renueva" a cada perfil de lo que
 * el cliente eligió en esa orden. Idempotente.
 */
export function applyPayLinkPayment(orderName: string): { applied: boolean; profiles: number } {
  const ref = db.prepare(`SELECT code, keys_json, paid_at FROM renewal_pay_link_orders WHERE order_name = ?`)
    .get(orderName) as { code: string; keys_json: string | null; paid_at: string | null } | undefined;
  if (!ref) return { applied: false, profiles: 0 };
  if (ref.paid_at) return { applied: true, profiles: 0 };

  const link = findPayLink(ref.code);
  if (!link) return { applied: false, profiles: 0 };

  let keys: string[] = [];
  try { keys = JSON.parse(ref.keys_json || "[]"); } catch { /* sin selección guardada */ }
  // Órdenes del formato anterior (sin keys) pagaban el link completo.
  const chosen = keys.length ? link.items.filter(i => keys.includes(i.key)) : link.items;

  let count = 0;
  db.transaction(() => {
    for (const it of chosen) {
      for (const id of it.profileIds) {
        const profile = getProfileById(id);
        if (!profile || last9(profile.clientPhone) !== last9(link.clientPhone)) continue;
        setProfileRenewal(id, "yes");
        count++;
      }
    }
    db.prepare(`UPDATE renewal_pay_link_orders SET paid_at = datetime('now') WHERE order_name = ?`).run(orderName);
  })();
  return { applied: true, profiles: count };
}

/** Borra links vencidos hace más de 7 días (se llama de paso al crear uno nuevo). */
export function cleanOldPayLinks(): void {
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  db.prepare(`
    DELETE FROM renewal_pay_link_orders WHERE code IN (SELECT code FROM renewal_pay_links WHERE expires_at < ?)
  `).run(cutoff);
  db.prepare(`DELETE FROM renewal_pay_links WHERE expires_at < ?`).run(cutoff);
}
