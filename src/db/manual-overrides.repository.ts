import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// REEMPLAZOS MANUALES DE SOPORTE — garantía puntual que el cliente ve en
// "Mis cuentas" (o el mayorista en "Clientes") hasta que vence, SIN pasar
// por el inventario de Accesos: no es una cuenta real del pool, no la
// vende nadie más, no aparece en Accesos. Exclusivo del flujo de Soporte
// — ver access.repository.ts (replaceClientAccountManual) y
// wholesaler.routes.ts / support.routes.ts.
// ─────────────────────────────────────────────────────────────

export type ManualAccountOverride = {
  id:           number;
  clientPhone:  string;
  wholesalerId: number | null; // null = cliente retail de liordark.com
  platform:     string;
  email:        string;
  password:     string;
  profileName:  string;
  provider:     string;
  expiresAt:    string | null;
  createdAt:    string;
};

function last9(phone: string): string {
  return phone.replace(/\D/g, "").slice(-9);
}

function toOverride(row: any): ManualAccountOverride {
  return {
    id:           row.id,
    clientPhone:  row.client_phone,
    wholesalerId: row.wholesaler_id,
    platform:     row.platform,
    email:        row.email,
    password:     row.password,
    profileName:  row.profile_name ?? "",
    provider:     row.provider ?? "",
    expiresAt:    row.expires_at,
    createdAt:    row.created_at,
  };
}

export function createManualOverride(params: {
  clientPhone: string; wholesalerId: number | null; platform: string;
  email: string; password: string; profileName: string; provider: string; expiresAt: string | null;
}): ManualAccountOverride {
  const digits = params.clientPhone.replace(/\D/g, "");
  const info = db.prepare(`
    INSERT INTO manual_account_overrides
      (client_phone, wholesaler_id, platform, email, password, profile_name, provider, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    digits, params.wholesalerId, params.platform.trim().toUpperCase(), params.email.trim(),
    params.password, params.profileName.trim(), params.provider.trim(), params.expiresAt
  );
  return toOverride(db.prepare(`SELECT * FROM manual_account_overrides WHERE id = ?`).get(info.lastInsertRowid));
}

/** Para "Mis cuentas" de liordark.com — solo overrides de clientes retail. */
export function listManualOverridesForClient(clientPhone: string): ManualAccountOverride[] {
  return (db.prepare(`
    SELECT * FROM manual_account_overrides WHERE substr(client_phone, -9) = ? AND wholesaler_id IS NULL
  `).all(last9(clientPhone)) as any[]).map(toOverride);
}

/** Para "Clientes" del panel mayorista. */
export function listManualOverridesForWholesaler(wholesalerId: number): ManualAccountOverride[] {
  return (db.prepare(`
    SELECT * FROM manual_account_overrides WHERE wholesaler_id = ?
  `).all(wholesalerId) as any[]).map(toOverride);
}

/** wholesalerId: null busca overrides retail, un id busca los de ESE mayorista. */
export function findManualOverride(
  clientPhone: string, platform: string, email: string, wholesalerId: number | null
): ManualAccountOverride | null {
  const row = db.prepare(`
    SELECT * FROM manual_account_overrides
    WHERE substr(client_phone, -9) = ? AND platform = ? AND email = ? AND wholesaler_id IS ?
    LIMIT 1
  `).get(last9(clientPhone), platform.trim().toUpperCase(), email.trim(), wholesalerId) as any;
  return row ? toOverride(row) : null;
}

export function deleteManualOverride(id: number): void {
  db.prepare(`DELETE FROM manual_account_overrides WHERE id = ?`).run(id);
}
