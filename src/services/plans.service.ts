import { db } from "../db/db";
import { addDaysISO, limaTodayISO } from "./access.service";

// ─────────────────────────────────────────────────────────────
// PLANES POR MESES — plataformas de activación manual que se venden por
// duración (hoy: GEMINI AI PRO). Cada compra es una cuenta individual,
// así que su vencimiento sale directo del plan elegido.
// El mayorista paga S/ 1 menos en cada plan.
// ─────────────────────────────────────────────────────────────

export type PlanOption = { months: number; days: number; price: number; wholesalePrice: number; label: string };

const WHOLESALE_DISCOUNT = 1;

function plan(months: number, price: number): PlanOption {
  return {
    months,
    days: months === 12 ? 365 : months * 30,
    price,
    wholesalePrice: Math.round((price - WHOLESALE_DISCOUNT) * 100) / 100,
    label: months === 12 ? "Anual" : months === 1 ? "1 mes" : `${months} meses`,
  };
}

const GEMINI_PLANS: PlanOption[] = [plan(1, 6), plan(3, 15), plan(6, 25), plan(12, 49.9)];

export function plansFor(platform: string | null | undefined): PlanOption[] | null {
  return /gemini/i.test(String(platform ?? "")) ? GEMINI_PLANS : null;
}

/** El plan elegido; si la plataforma no tiene planes o los meses no existen, null. */
export function planFor(platform: string, months: unknown): PlanOption | null {
  const plans = plansFor(platform);
  if (!plans) return null;
  return plans.find(p => p.months === Number(months)) ?? null;
}

export function planExpiresAt(p: PlanOption): string {
  return addDaysISO(limaTodayISO(), p.days);
}

export function money(n: number): string {
  return n.toFixed(2);
}

// El catálogo (WhatsApp, renovaciones, tarjeta de la tienda) usa el precio
// del plan mensual — se mantiene alineado con esta tabla en cada arranque.
export function syncPlanCatalogPrices(): void {
  const rows = db.prepare(`SELECT id, platform FROM catalog_products`).all() as { id: number; platform: string }[];
  for (const r of rows) {
    const plans = plansFor(r.platform);
    if (!plans) continue;
    const monthly = plans[0]!;
    db.prepare(`UPDATE catalog_products SET price = ?, wholesale_price = ? WHERE id = ?`)
      .run(money(monthly.price), money(monthly.wholesalePrice), r.id);
  }
}

// Pedidos web pagados por Yape: el bot avisa con el orderName y acá se
// recuerda qué plan eligió el cliente al crear el pedido.
db.exec(`
  CREATE TABLE IF NOT EXISTS plan_orders (
    order_name TEXT PRIMARY KEY,
    platform   TEXT    NOT NULL,
    months     INTEGER NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

export function savePlanOrder(orderName: string, platform: string, months: number): void {
  db.prepare(`INSERT OR REPLACE INTO plan_orders (order_name, platform, months) VALUES (?, ?, ?)`).run(orderName, platform, months);
}

export function findPlanOrder(orderName: string): { platform: string; months: number } | null {
  const r = db.prepare(`SELECT platform, months FROM plan_orders WHERE order_name = ?`).get(orderName) as any;
  return r ? { platform: r.platform, months: r.months } : null;
}

export function cleanOldPlanOrders(): void {
  db.prepare(`DELETE FROM plan_orders WHERE created_at < datetime('now', '-60 days')`).run();
}
