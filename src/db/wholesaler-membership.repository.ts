import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// MEMBRESÍA MAYORISTA — sin membresía vigente el mayorista solo puede
// pagarla (su saldo queda guardado, en pausa). Se paga por Yape con el
// mismo camino que la recarga (el bot reserva un monto único y avisa al
// panel en /api/stock/wholesale-credit con purpose "membership").
// La fecha vive en wholesalers.membership_until (UTC, formato SQLite).
// ─────────────────────────────────────────────────────────────

export type MembershipPlan = { id: string; months: number; price: number; label: string };

export const MEMBERSHIP_PLANS: MembershipPlan[] = [
  { id: "1m",  months: 1,  price: 10, label: "1 mes" },
  { id: "3m",  months: 3,  price: 20, label: "3 meses" },
  { id: "12m", months: 12, price: 60, label: "1 año" },
];

export function membershipPlan(id: string): MembershipPlan | null {
  return MEMBERSHIP_PLANS.find(p => p.id === id) ?? null;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS wholesaler_membership_orders (
    order_name    TEXT PRIMARY KEY,
    wholesaler_id INTEGER NOT NULL,
    plan          TEXT    NOT NULL,
    months        INTEGER NOT NULL,
    price_cents   INTEGER NOT NULL,
    amount        TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    paid_at       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_membership_orders_wholesaler ON wholesaler_membership_orders(wholesaler_id, created_at);
  CREATE TABLE IF NOT EXISTS wholesaler_membership_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    wholesaler_id INTEGER NOT NULL,
    months        INTEGER NOT NULL,
    price_cents   INTEGER NOT NULL DEFAULT 0,
    source        TEXT    NOT NULL,
    reference     TEXT    NOT NULL DEFAULT '',
    until         TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_membership_log_wholesaler ON wholesaler_membership_log(wholesaler_id, created_at);
`);

// La columna se agrega una sola vez. Ese día, los mayoristas que ya existían
// reciben 1 mes de regalo (decisión del dueño, nov-2026) para no cortarles de golpe.
try {
  db.exec(`ALTER TABLE wholesalers ADD COLUMN membership_until TEXT`);
  db.transaction(() => {
    db.prepare(`UPDATE wholesalers SET membership_until = datetime('now', '+1 month')`).run();
    db.prepare(`
      INSERT INTO wholesaler_membership_log (wholesaler_id, months, source, until)
      SELECT id, 1, 'regalo', membership_until FROM wholesalers
    `).run();
  })();
  console.log("🗄️  Migración: wholesalers.membership_until agregada (1 mes de regalo a los mayoristas actuales)");
} catch { /* ya existe */ }

export type MembershipStatus = {
  active:    boolean;
  until:     string | null; // ISO
  daysLeft:  number | null; // días completos que quedan (0 = vence hoy)
};

function isoOf(sqlite: string | null): string | null {
  if (!sqlite) return null;
  const d = new Date(sqlite.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function membershipStatusOf(membershipUntil: string | null | undefined): MembershipStatus {
  const iso = isoOf(membershipUntil ?? null);
  if (!iso) return { active: false, until: null, daysLeft: null };
  const ms = new Date(iso).getTime() - Date.now();
  return { active: ms > 0, until: iso, daysLeft: ms > 0 ? Math.floor(ms / 86_400_000) : null };
}

export function getMembershipStatus(wholesalerId: number): MembershipStatus {
  const row = db.prepare(`SELECT membership_until FROM wholesalers WHERE id = ?`).get(wholesalerId) as { membership_until: string | null } | undefined;
  return membershipStatusOf(row?.membership_until ?? null);
}

export function hasActiveMembership(wholesalerId: number): boolean {
  return getMembershipStatus(wholesalerId).active;
}

/** Suma meses: desde el vencimiento actual si sigue vigente, si no desde ahora. */
function extendInTx(wholesalerId: number, months: number, source: string, reference: string, priceCents: number): string {
  db.prepare(`
    UPDATE wholesalers SET membership_until = datetime(
      CASE WHEN membership_until IS NOT NULL AND membership_until > datetime('now') THEN membership_until ELSE datetime('now') END,
      '+' || ? || ' months'), updated_at = datetime('now')
    WHERE id = ?
  `).run(months, wholesalerId);
  const until = (db.prepare(`SELECT membership_until FROM wholesalers WHERE id = ?`).get(wholesalerId) as { membership_until: string }).membership_until;
  db.prepare(`
    INSERT INTO wholesaler_membership_log (wholesaler_id, months, price_cents, source, reference, until)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(wholesalerId, months, priceCents, source, reference, until);
  return until;
}

/** Admin: dar meses a mano (pago en efectivo, regalo…). */
export function grantMembership(wholesalerId: number, months: number, source = "admin"): MembershipStatus {
  db.transaction(() => extendInTx(wholesalerId, months, source, "", 0))();
  return getMembershipStatus(wholesalerId);
}

export type MembershipOrder = {
  orderName: string; wholesalerId: number; plan: string; months: number;
  priceCents: number; amount: string; createdAt: string; paidAt: string | null;
};

function toOrder(r: any): MembershipOrder {
  return {
    orderName: r.order_name, wholesalerId: r.wholesaler_id, plan: r.plan, months: r.months,
    priceCents: r.price_cents, amount: r.amount, createdAt: r.created_at, paidAt: r.paid_at,
  };
}

export function saveMembershipOrder(p: { orderName: string; wholesalerId: number; plan: MembershipPlan; amount: string }): void {
  db.prepare(`
    INSERT OR IGNORE INTO wholesaler_membership_orders (order_name, wholesaler_id, plan, months, price_cents, amount)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(p.orderName, p.wholesalerId, p.plan.id, p.plan.months, p.plan.price * 100, p.amount);
}

export function findMembershipOrder(orderName: string): MembershipOrder | null {
  const r = db.prepare(`SELECT * FROM wholesaler_membership_orders WHERE order_name = ?`).get(orderName);
  return r ? toOrder(r) : null;
}

/** El último pago sin confirmar de los últimos 5 min (lo que dura la reserva del Yape en el bot). */
export function latestPendingMembershipOrder(wholesalerId: number): MembershipOrder | null {
  const r = db.prepare(`
    SELECT * FROM wholesaler_membership_orders
    WHERE wholesaler_id = ? AND paid_at IS NULL AND created_at > datetime('now', '-5 minutes')
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(wholesalerId);
  return r ? toOrder(r) : null;
}

/**
 * El bot confirmó el Yape de una membresía. Idempotente por orderName: un
 * reintento del bot nunca suma meses dos veces. Si la orden no está (raro),
 * se reconoce el plan por el precio pagado.
 */
export function applyMembershipPayment(wholesalerId: number, orderName: string, paidAmount: number):
  { ok: true; alreadyApplied: boolean; until: string } | { ok: false; error: string } {
  return db.transaction(() => {
    const done = db.prepare(`SELECT until FROM wholesaler_membership_log WHERE reference = ? AND source = 'yape'`).get(orderName) as { until: string } | undefined;
    if (done) return { ok: true as const, alreadyApplied: true, until: done.until };

    const order = findMembershipOrder(orderName);
    let months: number; let priceCents: number;
    if (order) {
      if (order.wholesalerId !== wholesalerId) return { ok: false as const, error: "El pago no corresponde a ese mayorista." };
      months = order.months; priceCents = order.priceCents;
    } else {
      const plan = MEMBERSHIP_PLANS.find(p => p.price === Math.round(paidAmount));
      if (!plan) return { ok: false as const, error: "No se reconoce el plan de ese pago." };
      months = plan.months; priceCents = plan.price * 100;
    }
    const until = extendInTx(wholesalerId, months, "yape", orderName, priceCents);
    db.prepare(`UPDATE wholesaler_membership_orders SET paid_at = datetime('now') WHERE order_name = ?`).run(orderName);
    return { ok: true as const, alreadyApplied: false, until };
  })();
}

export function isMembershipReference(orderName: string): boolean {
  return !!findMembershipOrder(orderName) || orderName.startsWith("member-");
}

/** Mayoristas cuya membresía vence en las próximas `hours` horas (para el aviso). */
export function listMembershipsEndingSoon(hours: number): { id: number; until: string }[] {
  return db.prepare(`
    SELECT id, membership_until AS until FROM wholesalers
    WHERE membership_until IS NOT NULL
      AND membership_until > datetime('now')
      AND membership_until <= datetime('now', '+' || ? || ' hours')
  `).all(hours) as { id: number; until: string }[];
}

/** «18 dic 2026» en hora de Lima. */
export function membershipDateLabel(until: string | null): string {
  const iso = isoOf(until);
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("es-PE", { timeZone: "America/Lima", day: "numeric", month: "short", year: "numeric" }).replace(".", "");
}

// Aviso «tu membresía vence pronto»: una sola vez por cada vencimiento.
try { db.exec(`ALTER TABLE wholesalers ADD COLUMN membership_reminded_until TEXT`); } catch { /* ya existe */ }

export function markMembershipReminded(wholesalerId: number, until: string): boolean {
  const r = db.prepare(`
    UPDATE wholesalers SET membership_reminded_until = ?
    WHERE id = ? AND (membership_reminded_until IS NULL OR membership_reminded_until <> ?)
  `).run(until, wholesalerId, until);
  return r.changes > 0;
}
