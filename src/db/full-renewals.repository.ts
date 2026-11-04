import { db } from "./db";
import { getCatalogProductByPlatform } from "./catalog.repository";

// ─────────────────────────────────────────────────────────────
// RENOVADOS — renovaciones de CUENTAS COMPLETAS ya pagadas (cliente web o
// mayorista) que todavía no están activas con el proveedor. Antes la
// cuenta se extendía sola al pagar, aunque el proveedor no la hubiera
// renovado — y se terminaba entregando una cuenta vencida. Ahora queda
// acá hasta que el admin:
//   • confirma que el proveedor ya la renovó (se extiende según el plan), o
//   • le manda al cliente una cuenta nueva (del stock o escrita a mano).
// Las cuentas por perfiles NO pasan por acá (siguen con el corte
// automático de siempre, ver runRenewalCutover).
// ─────────────────────────────────────────────────────────────

export type FullRenewalStatus = "pending" | "renewed" | "new_account";

export type FullRenewal = {
  id:              number;
  accountId:       number;
  platform:        string;
  accountEmail:    string;
  clientPhone:     string;
  wholesalerId:    number | null;
  wholesalerName:  string;
  orderRef:        string;
  planDays:        number;
  status:          FullRenewalStatus;
  resolution:      string;
  createdAt:       string;
  resolvedAt:      string | null;
  // Datos actuales de la cuenta (pueden haber cambiado desde que pagó).
  accountExpiresAt: string | null;
  accountPassword:  string;
  accountProvider:  string;
};

/** Duración del plan que pagó: 365 días si el producto es anual (mismo
 *  criterio que la tienda: "anual" en el título o palabras clave), si no 30. */
export function planDaysForPlatform(platform: string): number {
  const p = getCatalogProductByPlatform(platform);
  const haystack = ((p?.title ?? "") + " " + (p?.keywords ?? "")).toLowerCase();
  return haystack.includes("anual") ? 365 : 30;
}

function toRenewal(row: any): FullRenewal {
  return {
    id:               row.id,
    accountId:        row.account_id,
    platform:         row.platform,
    accountEmail:     row.account_email,
    clientPhone:      row.client_phone,
    wholesalerId:     row.wholesaler_id ?? null,
    wholesalerName:   row.wholesaler_name ?? "",
    orderRef:         row.order_ref,
    planDays:         row.plan_days,
    status:           row.status,
    resolution:       row.resolution,
    createdAt:        row.created_at,
    resolvedAt:       row.resolved_at ?? null,
    accountExpiresAt: row.account_expires_at ?? null,
    accountPassword:  row.account_password ?? "",
    accountProvider:  row.account_provider ?? "",
  };
}

const SELECT_WITH_ACCOUNT = `
  SELECT r.*, a.expires_at AS account_expires_at, a.password AS account_password,
         a.provider AS account_provider,
         COALESCE(NULLIF(w.display_name, ''), w.phone, '') AS wholesaler_name
  FROM full_account_renewals r
  LEFT JOIN access_accounts a ON a.id = r.account_id
  LEFT JOIN wholesalers w ON w.id = r.wholesaler_id
`;

/** Idempotente por orderRef (un mismo pago nunca crea dos filas). */
export function createFullRenewal(params: {
  accountId: number; platform: string; accountEmail: string;
  clientPhone: string; wholesalerId: number | null; orderRef: string;
}): void {
  db.prepare(`
    INSERT OR IGNORE INTO full_account_renewals
      (account_id, platform, account_email, client_phone, wholesaler_id, order_ref, plan_days)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.accountId, params.platform, params.accountEmail, params.clientPhone,
    params.wholesalerId, params.orderRef, planDaysForPlatform(params.platform)
  );
}

export function listPendingFullRenewals(): FullRenewal[] {
  return (db.prepare(`${SELECT_WITH_ACCOUNT} WHERE r.status = 'pending' ORDER BY r.created_at ASC`).all() as any[])
    .map(toRenewal);
}

export function countPendingFullRenewals(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM full_account_renewals WHERE status = 'pending'`).get() as { n: number }).n;
}

export function getFullRenewal(id: number): FullRenewal | null {
  const row = db.prepare(`${SELECT_WITH_ACCOUNT} WHERE r.id = ?`).get(id);
  return row ? toRenewal(row) : null;
}

export function resolveFullRenewal(id: number, status: Exclude<FullRenewalStatus, "pending">, resolution: string): void {
  db.prepare(`
    UPDATE full_account_renewals SET status = ?, resolution = ?, resolved_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(status, resolution, id);
}

/** El admin renovó la cuenta por otro lado (botón "Renovar" de Accesos):
 *  cualquier pendiente de esa cuenta ya no aplica. */
export function resolvePendingFullRenewalsForAccount(accountId: number, resolution: string): void {
  db.prepare(`
    UPDATE full_account_renewals SET status = 'renewed', resolution = ?, resolved_at = datetime('now')
    WHERE account_id = ? AND status = 'pending'
  `).run(resolution, accountId);
}

/** Cuentas completas libres de esa plataforma, con fecha vigente — para
 *  "Enviar cuenta nueva" desde el stock. */
export function listFreeFullAccounts(platform: string, todayISO: string): { id: number; email: string; expiresAt: string | null }[] {
  return db.prepare(`
    SELECT a.id AS id, a.email AS email, a.expires_at AS expiresAt
    FROM access_accounts a
    WHERE a.platform = ? AND a.has_profiles = 0
      AND (a.expires_at IS NULL OR a.expires_at >= ?)
      AND EXISTS (SELECT 1 FROM access_profiles p WHERE p.account_id = a.id AND p.client_phone = '')
      AND NOT EXISTS (SELECT 1 FROM access_profiles p WHERE p.account_id = a.id AND p.client_phone != '')
    ORDER BY a.expires_at DESC
  `).all(platform.trim().toUpperCase(), todayISO) as { id: number; email: string; expiresAt: string | null }[];
}
