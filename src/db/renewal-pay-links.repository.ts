import crypto from "crypto";
import { db } from "./db";
import { getProfileById, setProfileRenewal, limaTodayISOLocal, addDaysISOLocal } from "./access.repository";

// ─────────────────────────────────────────────────────────────
// LINK DE PAGO DE RENOVACIÓN (botón 💬 Reno-manual del panel)
//
// El admin elige las cuentas por vencer de un cliente; se arma UN link
// (liordark.com/renovar.html?pack=CODE) con la lista y el total. El link
// vale hasta la medianoche (hora Lima) del día en que se creó. Al abrirlo
// se reserva un monto Yape único en el bot (5 min); si no paga, se
// regenera solo. Cuando el bot detecta el pago, confirmRenewalLog llama a
// applyPayLinkPayment y cada perfil queda "✅ Renueva" — mismo efecto que
// una renovación individual pagada por la web.
// ─────────────────────────────────────────────────────────────

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH   = 8;

export type PayLinkItem = {
  profileId:   number;
  platform:    string;
  platformTag: string;
  profileName: string;
  email:       string;
  expiresAt:   string | null;
  price:       string; // "10.00"
};

export type PayLink = {
  code:           string;
  clientPhone:    string;
  items:          PayLinkItem[];
  total:          string;
  expiresAt:      string;
  currentOrder:   string | null;
  currentAmount:  string | null;
  currentOrderAt: string | null;
  paidAt:         string | null;
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

export type PayLinkCandidate = PayLinkItem & {
  accountId:     number;
  renewalStatus: string;
  // false = no se puede meter al link (vence hoy/ya venció, no es
  // renovable, se activa a mano, o no tiene precio en el catálogo).
  eligible:      boolean;
  reason:        string;
};

/** Cuentas (perfiles) del cliente que podrían ir en el link — los combos no se renuevan. */
export function listPayLinkCandidates(
  clientPhone: string,
  daysLeftOf: (expiresAt: string | null) => number | null
): PayLinkCandidate[] {
  const digits = last9(clientPhone);
  if (digits.length < 9) return [];

  const rows = db.prepare(`
    SELECT p.id AS profileId, p.account_id AS accountId, p.profile_name AS profileName,
           p.renewal_status AS renewalStatus,
           a.platform AS platform, a.email AS email,
           COALESCE(p.expires_override, a.expires_at) AS expiresAt,
           COALESCE(c.title, '') AS platformTag, COALESCE(c.price, '') AS price
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    LEFT JOIN catalog_products c ON UPPER(TRIM(c.platform)) = a.platform
    WHERE substr(p.client_phone, -9) = ? AND p.order_ref NOT LIKE 'combo:%'
    ORDER BY expiresAt ASC
  `).all(digits) as any[];

  return rows.map(r => {
    const priceNum = parseFloat(String(r.price || "").replace(",", "."));
    const left = daysLeftOf(r.expiresAt);
    let reason = "";
    if (/youtube/i.test(r.platform))                 reason = "No es renovable (se compra de nuevo)";
    else if (/canva|gemini/i.test(r.platform))       reason = "Se activa a mano";
    else if (!Number.isFinite(priceNum) || priceNum <= 0) reason = "Sin precio en el catálogo";
    else if (left === null || left <= 0)             reason = "Vence hoy o ya venció";
    else if (r.renewalStatus === "yes")              reason = "Ya pagó su renovación";
    return {
      profileId:     r.profileId,
      accountId:     r.accountId,
      platform:      r.platform,
      platformTag:   r.platformTag || r.platform,
      profileName:   r.profileName || "",
      email:         r.email,
      expiresAt:     r.expiresAt ?? null,
      price:         Number.isFinite(priceNum) ? money(priceNum) : "0.00",
      renewalStatus: r.renewalStatus || "",
      eligible:      reason === "",
      reason,
    };
  });
}

export function createPayLink(clientPhone: string, items: PayLinkItem[]): PayLink {
  const total = money(items.reduce((s, i) => s + parseFloat(i.price), 0));
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

function toPayLink(row: any): PayLink {
  let items: PayLinkItem[] = [];
  try { items = JSON.parse(row.items_json); } catch { /* fila corrupta → sin items */ }
  return {
    code:           row.code,
    clientPhone:    row.client_phone,
    items,
    total:          row.total,
    expiresAt:      row.expires_at,
    currentOrder:   row.current_order ?? null,
    currentAmount:  row.current_amount ?? null,
    currentOrderAt: row.current_order_at ?? null,
    paidAt:         row.paid_at ?? null,
  };
}

/** Incluye los vencidos — quien llama decide (un link pagado se sigue mostrando como pagado). */
export function findPayLink(code: string): PayLink | null {
  const row = db.prepare(`SELECT * FROM renewal_pay_links WHERE code = ?`).get(String(code).toUpperCase());
  return row ? toPayLink(row) : null;
}

export function isPayLinkExpired(link: PayLink): boolean {
  return new Date(link.expiresAt).getTime() < Date.now();
}

/**
 * Items del link que siguen siendo válidos ahora: el perfil sigue siendo
 * de ese celular y no se pagó ya por otro lado. Si el admin liberó un
 * perfil después de mandar el link, no se cobra por él.
 */
export function stillValidItems(link: PayLink): PayLinkItem[] {
  return link.items.filter(it => {
    const profile = getProfileById(it.profileId);
    return !!profile && last9(profile.clientPhone) === last9(link.clientPhone) && profile.renewalStatus !== "yes";
  });
}

export function setPayLinkOrder(code: string, orderName: string, amount: string): void {
  db.prepare(`
    UPDATE renewal_pay_links SET current_order = ?, current_amount = ?, current_order_at = ? WHERE code = ?
  `).run(orderName, amount, new Date().toISOString(), code);
  db.prepare(`
    INSERT OR IGNORE INTO renewal_pay_link_orders (order_name, code, amount) VALUES (?, ?, ?)
  `).run(orderName, code, amount);
}

/**
 * Llamado al confirmarse el pago de una orden (confirmRenewalLog). Si la
 * orden es de un link de pago, marca "✅ Renueva" a cada perfil del link
 * y el link queda pagado. Idempotente.
 */
export function applyPayLinkPayment(orderName: string): { applied: boolean; profiles: number } {
  const ref = db.prepare(`SELECT code FROM renewal_pay_link_orders WHERE order_name = ?`).get(orderName) as { code: string } | undefined;
  if (!ref) return { applied: false, profiles: 0 };

  const link = findPayLink(ref.code);
  if (!link) return { applied: false, profiles: 0 };
  if (link.paidAt) return { applied: true, profiles: 0 };

  let count = 0;
  const tx = db.transaction(() => {
    for (const it of link.items) {
      const profile = getProfileById(it.profileId);
      if (!profile || last9(profile.clientPhone) !== last9(link.clientPhone)) continue;
      setProfileRenewal(it.profileId, "yes");
      count++;
    }
    db.prepare(`UPDATE renewal_pay_links SET paid_at = datetime('now'), paid_order = ? WHERE code = ?`)
      .run(orderName, link.code);
  });
  tx();
  return { applied: true, profiles: count };
}

/** Borra links vencidos hace más de 7 días (se llama de paso al crear uno nuevo). */
export function cleanOldPayLinks(): void {
  db.prepare(`
    DELETE FROM renewal_pay_link_orders WHERE code IN (
      SELECT code FROM renewal_pay_links WHERE expires_at < ?
    )
  `).run(new Date(Date.now() - 7 * 86_400_000).toISOString());
  db.prepare(`DELETE FROM renewal_pay_links WHERE expires_at < ?`)
    .run(new Date(Date.now() - 7 * 86_400_000).toISOString());
}
