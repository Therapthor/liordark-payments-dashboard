import { db } from "./db";

export type ProviderSubscription = {
  id:              number;
  productName:     string;
  costAmount:      string;
  costCurrency:    string;
  nextRenewalDate: string;
  notes:           string;
};

export function listProviderSubscriptions(): ProviderSubscription[] {
  return (db.prepare(`
    SELECT * FROM provider_subscriptions WHERE active = 1 ORDER BY next_renewal_date ASC
  `).all() as any[]).map(toRow);
}

export function getProviderSubscriptionById(id: number): ProviderSubscription | null {
  const row = db.prepare(`SELECT * FROM provider_subscriptions WHERE id = ?`).get(id) as any;
  return row ? toRow(row) : null;
}

export function createProviderSubscription(p: {
  productName: string; costAmount: string; costCurrency: string;
  nextRenewalDate: string; notes: string;
}): ProviderSubscription {
  const info = db.prepare(`
    INSERT INTO provider_subscriptions (product_name, cost_amount, cost_currency, next_renewal_date, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(p.productName, p.costAmount, p.costCurrency, p.nextRenewalDate, p.notes);
  return getProviderSubscriptionById(info.lastInsertRowid as number)!;
}

export function updateProviderSubscription(id: number, p: {
  productName: string; costAmount: string; costCurrency: string;
  nextRenewalDate: string; notes: string;
}): ProviderSubscription | null {
  db.prepare(`
    UPDATE provider_subscriptions SET
      product_name = ?, cost_amount = ?, cost_currency = ?, next_renewal_date = ?, notes = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(p.productName, p.costAmount, p.costCurrency, p.nextRenewalDate, p.notes, id);
  return getProviderSubscriptionById(id);
}

export function deleteProviderSubscription(id: number): void {
  db.prepare(`UPDATE provider_subscriptions SET active = 0 WHERE id = ?`).run(id);
}

/** Adelanta un mes la fecha de renovación (se llama al marcar "ya renové"). */
export function markSubscriptionRenewed(id: number): ProviderSubscription | null {
  const row = getProviderSubscriptionById(id);
  if (!row) return null;
  db.prepare(`
    UPDATE provider_subscriptions SET next_renewal_date = ?, updated_at = datetime('now') WHERE id = ?
  `).run(addOneMonth(row.nextRenewalDate), id);
  return getProviderSubscriptionById(id);
}

/** Suscripciones cuya renovación cae dentro de `daysAhead` días (o ya vencidas). */
export function getDueProviderSubscriptions(daysAhead: number): ProviderSubscription[] {
  const limit = addDaysISOLocal(limaTodayISOLocal(), daysAhead);
  return (db.prepare(`
    SELECT * FROM provider_subscriptions WHERE active = 1 AND next_renewal_date <= ? ORDER BY next_renewal_date ASC
  `).all(limit) as any[]).map(toRow);
}

function toRow(row: any): ProviderSubscription {
  return {
    id:              row.id,
    productName:     row.product_name,
    costAmount:      row.cost_amount,
    costCurrency:    row.cost_currency,
    nextRenewalDate: row.next_renewal_date,
    notes:           row.notes,
  };
}

function limaTodayISOLocal(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
}

function addDaysISOLocal(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const dt = new Date(Date.UTC(y as number, (m as number) - 1, (d as number) + days));
  return dt.toISOString().slice(0, 10);
}

function addOneMonth(dateISO: string): string {
  const [y, m, d] = dateISO.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1 + 1, d));
  return dt.toISOString().slice(0, 10);
}
