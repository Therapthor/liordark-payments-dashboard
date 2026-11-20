import { db } from "../db/db";
import { addDaysISO, limaTodayISO } from "./access.service";

// ─────────────────────────────────────────────────────────────
// PLANES POR MESES
//  · Activación manual (GEMINI AI PRO, CANVA PRO): cada compra es una cuenta
//    individual; el mayorista paga S/ 1 menos en cada plan.
//  · Perfiles / accesos compartidos (CRUNCHYROLL, NETFLIX, CHATGPT, CAPCUT):
//    el cliente tiene su propia fecha dentro de la cuenta (ver
//    services/brain.service.ts). El mayorista solo compra los planes con
//    `wholesale` (1 mes y, en Crunchyroll, el anual).
// wholesalePrice null = el precio mayorista del catálogo (Configuración ›
// Catálogo), para no pisar lo que ya está configurado.
// ─────────────────────────────────────────────────────────────

export type PlanOption = {
  months: number; days: number; price: number; label: string;
  wholesalePrice: number | null; wholesale: boolean;
};

const WHOLESALE_DISCOUNT = 1;

function plan(months: number, price: number, wholesale: number | null | false = Math.round((price - WHOLESALE_DISCOUNT) * 100) / 100): PlanOption {
  return {
    months,
    days: months === 12 ? 365 : months * 30,
    price,
    wholesalePrice: wholesale === false ? null : wholesale,
    wholesale: wholesale !== false,
    label: months === 12 ? "Anual" : months === 1 ? "1 mes" : `${months} meses`,
  };
}

const GEMINI_PLANS: PlanOption[] = [plan(1, 6), plan(3, 15), plan(6, 25), plan(12, 49.9)];
const CANVA_PLANS:  PlanOption[] = [plan(1, 5), plan(3, 10), plan(6, 15), plan(12, 25)];
// Perfiles: 1 mes al mismo precio de siempre; los paquetes salen más baratos por mes.
const CRUNCHYROLL_PLANS: PlanOption[] = [plan(1, 4, 3), plan(3, 8, false), plan(6, 14, false), plan(12, 25, 20)];
const NETFLIX_PLANS:     PlanOption[] = [plan(1, 16, null), plan(3, 45, false), plan(6, 85, false)];
const CHATGPT_PLANS:     PlanOption[] = [plan(1, 15, null), plan(3, 40, false)];
const CAPCUT_PLANS:      PlanOption[] = [plan(1, 15, null), plan(3, 40, false)];

export function plansFor(platform: string | null | undefined): PlanOption[] | null {
  const p = String(platform ?? "");
  if (/gemini/i.test(p)) return GEMINI_PLANS;
  if (/canva/i.test(p))  return CANVA_PLANS;
  if (/crunchyroll/i.test(p)) return CRUNCHYROLL_PLANS;
  if (/netflix/i.test(p))     return NETFLIX_PLANS;
  if (/chatgpt/i.test(p))     return CHATGPT_PLANS;
  if (/capcut/i.test(p))      return CAPCUT_PLANS;
  return null;
}

/** Planes que puede comprar un mayorista, con su precio ya resuelto
 *  (null en el plan = el precio mayorista del catálogo). */
export function wholesalePlansFor(platform: string, catalogWholesalePrice: string | number | null | undefined):
  (PlanOption & { wholesalePrice: number })[] | null {
  const plans = plansFor(platform);
  if (!plans) return null;
  const fallback = Number(catalogWholesalePrice ?? 0);
  return plans
    .filter(p => p.wholesale)
    .map(p => ({ ...p, wholesalePrice: p.wholesalePrice ?? fallback }))
    .filter(p => Number.isFinite(p.wholesalePrice) && p.wholesalePrice > 0);
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

/** Igual que el resto del catálogo: "6", "15", "25" — con céntimos solo si los hay ("49.90"). */
export function money(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// El catálogo (WhatsApp, renovaciones, tarjeta de la tienda) usa el precio
// del plan mensual — se mantiene alineado con esta tabla en cada arranque.
// Con planes, el título no lleva la duración ("Canva Pro Anual" → "Canva Pro"):
// la elige el cliente.
export function syncPlanCatalogPrices(): void {
  const rows = db.prepare(`SELECT id, platform, title, active FROM catalog_products`).all() as { id: number; platform: string; title: string; active: number }[];
  for (const r of rows) {
    const plans = plansFor(r.platform);
    // Apagado (ej. «Crunchyroll Anual», ya unido a Crunchyroll): no se toca.
    if (!plans || r.active === 0) continue;
    const monthly = plans[0]!;
    const title = String(r.title ?? "").replace(/\s+anual\s*$/i, "").trim() || r.title;
    if (monthly.wholesalePrice !== null) {
      db.prepare(`UPDATE catalog_products SET price = ?, wholesale_price = ?, title = ? WHERE id = ?`)
        .run(money(monthly.price), money(monthly.wholesalePrice), title, r.id);
    } else {
      db.prepare(`UPDATE catalog_products SET price = ?, title = ? WHERE id = ?`).run(money(monthly.price), title, r.id);
    }
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
