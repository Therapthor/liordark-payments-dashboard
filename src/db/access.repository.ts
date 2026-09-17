import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────────────────────

export type RenewalStatus = "" | "yes" | "no";

export type AccessProfile = {
  id:            number;
  accountId:     number;
  slotNumber:    number;
  profileName:   string;
  clientPhone:   string;
  renewalStatus: RenewalStatus;
  orderRef:      string;
  updatedAt:     string;
};

export type AccessAccount = {
  id:          number;
  platform:    string;
  email:       string;
  password:    string;
  provider:    string;
  hasProfiles: boolean;
  expiresAt:   string | null;
  link:        string;
  notes:       string;
  createdAt:   string;
  updatedAt:   string;
};

export type AccessAccountWithProfiles = AccessAccount & { profiles: AccessProfile[] };

export type PlatformSummary = {
  platform:      string;
  accountCount:  number;
  profileCount:  number;
  occupiedCount: number;
  sellableCount: number; // libres Y con al menos MIN_SELLABLE_DAYS por delante — lo que de verdad se le puede vender a un cliente nuevo
};

// Regla del negocio: nunca vender un perfil cuya cuenta vaya a vencer en
// menos de 28 días — si no, el cliente reclama que no le llegó el mes
// completo. Aplica tanto a la venta real (sellProfile) como al conteo de
// "disponibles" que ve el admin y el catálogo del bot, para que ambos
// digan siempre lo mismo.
const MIN_SELLABLE_DAYS = 28;

function minSellableDateISO(): string {
  return addDaysISOLocal(limaTodayISOLocal(), MIN_SELLABLE_DAYS);
}

// ─────────────────────────────────────────────────────────────
// CUENTAS
// ─────────────────────────────────────────────────────────────

function slotsFor(hasProfiles: boolean): number {
  return hasProfiles ? 5 : 1;
}

export function createAccount(params: {
  platform:    string;
  email:       string;
  password:    string;
  provider?:   string;
  hasProfiles: boolean;
  expiresAt?:  string | null;
  notes?:      string;
}): AccessAccountWithProfiles {
  return createAccountsBulk({
    platform:    params.platform,
    provider:    params.provider ?? "",
    hasProfiles: params.hasProfiles,
    expiresAt:   params.expiresAt ?? null,
    pairs:       [{ email: params.email, password: params.password }],
  })[0]!;
}

/** Crea varias cuentas de una — formato "correo:contraseña" ya parseado en pares. */
export function createAccountsBulk(params: {
  platform:    string;
  provider:    string;
  hasProfiles: boolean;
  expiresAt:   string | null;
  pairs:       { email: string; password: string }[];
}): AccessAccountWithProfiles[] {
  const slots = slotsFor(params.hasProfiles);

  const insertAccount = db.prepare(`
    INSERT INTO access_accounts (platform, email, password, provider, has_profiles, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertProfile = db.prepare(`
    INSERT INTO access_profiles (account_id, slot_number, profile_name)
    VALUES (?, ?, ?)
  `);

  const ids = db.transaction(() => {
    const created: number[] = [];
    for (const pair of params.pairs) {
      const result = insertAccount.run(
        params.platform.trim().toUpperCase(),
        pair.email.trim(),
        pair.password.trim(),
        params.provider.trim(),
        params.hasProfiles ? 1 : 0,
        params.expiresAt
      );
      const id = result.lastInsertRowid as number;
      for (let slot = 1; slot <= slots; slot++) {
        insertProfile.run(id, slot, slots === 1 ? "" : "Perfil " + slot);
      }
      created.push(id);
    }
    return created;
  })();

  return ids.map(id => getAccountById(id)!);
}

export function updateAccount(id: number, params: {
  platform?:  string;
  email?:     string;
  password?:  string;
  provider?:  string;
  expiresAt?: string | null;
  link?:      string;
  notes?:     string;
}): AccessAccountWithProfiles | null {
  const current = getAccountById(id);
  if (!current) return null;

  db.prepare(`
    UPDATE access_accounts
    SET platform = ?, email = ?, password = ?, provider = ?, expires_at = ?, link = ?, notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    (params.platform ?? current.platform).trim().toUpperCase(),
    (params.email ?? current.email).trim(),
    params.password ?? current.password,
    (params.provider ?? current.provider).trim(),
    params.expiresAt !== undefined ? params.expiresAt : current.expiresAt,
    (params.link ?? current.link).trim(),
    (params.notes ?? current.notes).trim(),
    id
  );

  return getAccountById(id);
}

export function setAccountExpiry(id: number, expiresAt: string): AccessAccountWithProfiles | null {
  db.prepare(`
    UPDATE access_accounts SET expires_at = ?, updated_at = datetime('now') WHERE id = ?
  `).run(expiresAt, id);
  return getAccountById(id);
}

export function deleteAccount(id: number): void {
  db.prepare(`DELETE FROM access_accounts WHERE id = ?`).run(id);
}

/**
 * Renovación con cuenta nueva: crea una cuenta aparte (mismas plataforma/
 * proveedor/perfiles que la vieja, con el correo y contraseña nuevos que ya
 * se cambiaron en el proveedor) y le pasa SOLO los clientes de la cuenta
 * vieja marcados "✅ Renueva" — el resto se queda como estaba en la vieja,
 * para decidir aparte qué hacer con ellos. No manda nada por WhatsApp ni
 * toca el bot — solo mueve datos dentro del panel.
 */
export function createAccountFromRenewal(oldAccountId: number, params: {
  email:     string;
  password:  string;
  expiresAt: string | null;
}): { oldAccount: AccessAccountWithProfiles; newAccount: AccessAccountWithProfiles } | null {
  const oldAccount = getAccountById(oldAccountId);
  if (!oldAccount) return null;

  const renewing = oldAccount.profiles.filter(p => p.clientPhone && p.renewalStatus === "yes");
  const slots = slotsFor(oldAccount.hasProfiles);

  const insertAccount = db.prepare(`
    INSERT INTO access_accounts (platform, email, password, provider, has_profiles, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertProfile = db.prepare(`
    INSERT INTO access_profiles (account_id, slot_number, profile_name, client_phone)
    VALUES (?, ?, ?, ?)
  `);
  const freeOldProfile = db.prepare(`
    UPDATE access_profiles SET client_phone = '', renewal_status = '', order_ref = '', updated_at = datetime('now') WHERE id = ?
  `);

  const newAccountId = db.transaction(() => {
    const result = insertAccount.run(
      oldAccount.platform, params.email.trim(), params.password.trim(),
      oldAccount.provider, oldAccount.hasProfiles ? 1 : 0, params.expiresAt
    );
    const id = result.lastInsertRowid as number;

    for (let slot = 1; slot <= slots; slot++) {
      const client = renewing[slot - 1];
      insertProfile.run(id, slot, slots === 1 ? "" : "Perfil " + slot, client ? client.clientPhone : "");
      if (client) freeOldProfile.run(client.id);
    }
    return id;
  })();

  return { oldAccount: getAccountById(oldAccountId)!, newAccount: getAccountById(newAccountId)! };
}

export function getAccountById(id: number): AccessAccountWithProfiles | null {
  const row = db.prepare(`SELECT * FROM access_accounts WHERE id = ?`).get(id) as any;
  if (!row) return null;
  return { ...toAccount(row), profiles: getProfilesByAccount(id) };
}

export function listPlatforms(): PlatformSummary[] {
  const floor = minSellableDateISO();
  return db.prepare(`
    SELECT
      a.platform AS platform,
      COUNT(DISTINCT a.id) AS accountCount,
      COUNT(p.id) AS profileCount,
      SUM(CASE WHEN p.client_phone != '' THEN 1 ELSE 0 END) AS occupiedCount,
      SUM(CASE WHEN p.client_phone = '' AND a.expires_at IS NOT NULL AND a.expires_at >= ? THEN 1 ELSE 0 END) AS sellableCount
    FROM access_accounts a
    LEFT JOIN access_profiles p ON p.account_id = a.id
    GROUP BY a.platform
    ORDER BY a.platform ASC
  `).all(floor) as PlatformSummary[];
}

export function listAccountsByPlatform(platform: string): AccessAccountWithProfiles[] {
  const rows = db.prepare(`
    SELECT * FROM access_accounts WHERE platform = ? ORDER BY created_at ASC
  `).all(platform.trim().toUpperCase()) as any[];

  return rows.map(row => ({ ...toAccount(row), profiles: getProfilesByAccount(row.id) }));
}

// ─────────────────────────────────────────────────────────────
// PERFILES
// ─────────────────────────────────────────────────────────────

export function getProfilesByAccount(accountId: number): AccessProfile[] {
  return (db.prepare(`
    SELECT * FROM access_profiles WHERE account_id = ? ORDER BY slot_number ASC
  `).all(accountId) as any[]).map(toProfile);
}

export function getProfileById(id: number): AccessProfile | null {
  const row = db.prepare(`SELECT * FROM access_profiles WHERE id = ?`).get(id) as any;
  return row ? toProfile(row) : null;
}

export function assignProfileClient(id: number, clientPhone: string): AccessProfile | null {
  const result = db.prepare(`
    UPDATE access_profiles SET client_phone = ?, updated_at = datetime('now') WHERE id = ?
  `).run(clientPhone.replace(/\D/g, ""), id);
  if (result.changes === 0) return null;
  return getProfileById(id);
}

export function releaseProfile(id: number): AccessProfile | null {
  const result = db.prepare(`
    UPDATE access_profiles SET client_phone = '', renewal_status = '', order_ref = '', updated_at = datetime('now') WHERE id = ?
  `).run(id);
  if (result.changes === 0) return null;
  return getProfileById(id);
}

/** Marca si el cliente de un perfil confirmó que renueva o no (o lo deja sin marcar). */
export function setProfileRenewal(id: number, status: RenewalStatus): AccessProfile | null {
  const result = db.prepare(`
    UPDATE access_profiles SET renewal_status = ?, updated_at = datetime('now') WHERE id = ?
  `).run(status, id);
  if (result.changes === 0) return null;
  return getProfileById(id);
}

/** Limpia los marcadores de renovación de una cuenta — se llama al renovarla,
 *  para que cada ciclo empiece con la marca en blanco de nuevo. */
export function resetRenewalMarkers(accountId: number): void {
  db.prepare(`UPDATE access_profiles SET renewal_status = '' WHERE account_id = ?`).run(accountId);
}

// ─────────────────────────────────────────────────────────────
// STOCK — usado por la API que consume el bot de WhatsApp (Telegram/venta)
//
// sellProfile es la operación crítica: tiene que ser imposible que dos
// ventas simultáneas se lleven el mismo perfil. Como better-sqlite3 es
// síncrono y Node es de un solo hilo, todo el SELECT+UPDATE corre sin
// ceder el control al event loop — no hace falta ningún lock aparte.
// ─────────────────────────────────────────────────────────────

export type SoldProfile = {
  profileId:   number;
  accountId:   number;
  platform:    string;
  email:       string;
  password:    string;
  profileName: string;
  expiresAt:   string | null;
};

/**
 * Vende (asigna) el perfil libre más próximo a vencer de esa plataforma,
 * SIEMPRE que a la cuenta le queden al menos MIN_SELLABLE_DAYS — nunca se
 * vende una cuenta que va a vencer pronto, así el cliente no reclama por
 * no recibir el mes completo. null si no hay stock que cumpla eso.
 */
export const sellProfile = db.transaction((platform: string, clientPhone: string, orderRef: string): SoldProfile | null => {
  const plat = platform.trim().toUpperCase();
  const digits = clientPhone.replace(/\D/g, "");
  const floor = minSellableDateISO();

  const row = db.prepare(`
    SELECT p.id AS profileId, p.profile_name AS profileName,
           a.id AS accountId, a.platform AS platform, a.email AS email,
           a.password AS password, a.expires_at AS expiresAt
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE a.platform = ? AND p.client_phone = ''
      AND a.expires_at IS NOT NULL AND a.expires_at >= ?
    ORDER BY a.expires_at ASC
    LIMIT 1
  `).get(plat, floor) as any;

  if (!row) return null;

  db.prepare(`
    UPDATE access_profiles SET client_phone = ?, order_ref = ?, updated_at = datetime('now') WHERE id = ?
  `).run(digits, orderRef, row.profileId);

  return row as SoldProfile;
});

/** Libera el/los perfiles de ese cliente en esa plataforma (orden cancelada). Devuelve cuántos liberó. */
export function releaseProfilesByPhone(platform: string, clientPhone: string): number {
  const plat = platform.trim().toUpperCase();
  const digits = clientPhone.replace(/\D/g, "");
  if (!digits) return 0;

  const result = db.prepare(`
    UPDATE access_profiles
    SET client_phone = '', renewal_status = '', order_ref = '', updated_at = datetime('now')
    WHERE client_phone = ?
      AND account_id IN (SELECT id FROM access_accounts WHERE platform = ?)
  `).run(digits, plat);

  return result.changes;
}

/** Cuenta (con perfil) de ese cliente en esa plataforma — para renovar o confirmar datos. */
export function findAccountByClientPhone(platform: string, clientPhone: string): AccessAccountWithProfiles | null {
  const plat = platform.trim().toUpperCase();
  const digits = clientPhone.replace(/\D/g, "");
  if (!digits) return null;

  const row = db.prepare(`
    SELECT a.* FROM access_accounts a
    JOIN access_profiles p ON p.account_id = a.id
    WHERE a.platform = ? AND p.client_phone = ?
    LIMIT 1
  `).get(plat, digits) as any;

  return row ? { ...toAccount(row), profiles: getProfilesByAccount(row.id) } : null;
}

export type ExpiringClient = {
  profileId:   number;
  clientPhone: string;
  platform:    string;
  platformTag: string; // título "amigable" del catálogo, para el mensaje al cliente
  email:       string;
  password:    string;
  expiresAt:   string;
};

/** Clientes ocupados cuya cuenta vence en los próximos `days` días (o ya venció y sigue sin archivarse). */
export function listExpiringClients(days: number): ExpiringClient[] {
  const limit = addDaysISOLocal(limaTodayISOLocal(), days);
  return db.prepare(`
    SELECT p.id AS profileId, p.client_phone AS clientPhone, a.platform AS platform,
           COALESCE(c.title, '') AS platformTag,
           a.email AS email, a.password AS password, a.expires_at AS expiresAt
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    LEFT JOIN catalog_products c ON UPPER(TRIM(c.platform)) = a.platform
    WHERE p.client_phone != '' AND a.expires_at IS NOT NULL AND a.expires_at <= ?
    ORDER BY a.expires_at ASC
  `).all(limit) as ExpiringClient[];
}

function limaTodayISOLocal(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
}

function addDaysISOLocal(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const dt = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────
// BÚSQUEDA
// ─────────────────────────────────────────────────────────────

export type ProfileWithAccount = AccessProfile & {
  platform:    string;
  email:       string;
  password:    string;
  provider:    string;
  hasProfiles: boolean;
  expiresAt:   string | null;
};

/** Cuentas cuyo correo contiene el término buscado. */
export function searchAccountsByEmail(term: string): AccessAccountWithProfiles[] {
  const rows = db.prepare(`
    SELECT * FROM access_accounts WHERE email LIKE ? ORDER BY platform ASC
  `).all("%" + term.trim() + "%") as any[];
  return rows.map(row => ({ ...toAccount(row), profiles: getProfilesByAccount(row.id) }));
}

/** Perfiles (con su cuenta) cuyo teléfono de cliente coincide. */
export function searchProfilesByPhone(term: string): ProfileWithAccount[] {
  const digits = term.replace(/\D/g, "");
  if (!digits) return [];

  const rows = db.prepare(`
    SELECT p.*,
           a.platform AS platform, a.email AS email, a.password AS password,
           a.provider AS provider, a.has_profiles AS has_profiles, a.expires_at AS account_expires_at
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE p.client_phone LIKE ?
    ORDER BY a.expires_at ASC
  `).all("%" + digits + "%") as any[];

  return rows.map(row => ({
    ...toProfile(row),
    platform:    row.platform,
    email:       row.email,
    password:    row.password,
    provider:    row.provider ?? "",
    hasProfiles: row.has_profiles === 1,
    expiresAt:   row.account_expires_at ?? null,
  }));
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function toAccount(row: any): AccessAccount {
  return {
    id:          row.id,
    platform:    row.platform,
    email:       row.email,
    password:    row.password,
    provider:    row.provider ?? "",
    hasProfiles: row.has_profiles === 1,
    expiresAt:   row.expires_at ?? null,
    link:        row.link ?? "",
    notes:       row.notes ?? "",
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
}

function toProfile(row: any): AccessProfile {
  return {
    id:            row.id,
    accountId:     row.account_id,
    slotNumber:    row.slot_number,
    profileName:   row.profile_name ?? "",
    clientPhone:   row.client_phone ?? "",
    renewalStatus: (row.renewal_status ?? "") as RenewalStatus,
    orderRef:      row.order_ref ?? "",
    updatedAt:     row.updated_at,
  };
}
