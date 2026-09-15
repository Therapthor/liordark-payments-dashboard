import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────────────────────

export type AccessProfile = {
  id:          number;
  accountId:   number;
  slotNumber:  number;
  profileName: string;
  clientPhone: string;
  updatedAt:   string;
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
};

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

export function getAccountById(id: number): AccessAccountWithProfiles | null {
  const row = db.prepare(`SELECT * FROM access_accounts WHERE id = ?`).get(id) as any;
  if (!row) return null;
  return { ...toAccount(row), profiles: getProfilesByAccount(id) };
}

export function listPlatforms(): PlatformSummary[] {
  return db.prepare(`
    SELECT
      a.platform AS platform,
      COUNT(DISTINCT a.id) AS accountCount,
      COUNT(p.id) AS profileCount,
      SUM(CASE WHEN p.client_phone != '' THEN 1 ELSE 0 END) AS occupiedCount
    FROM access_accounts a
    LEFT JOIN access_profiles p ON p.account_id = a.id
    GROUP BY a.platform
    ORDER BY a.platform ASC
  `).all() as PlatformSummary[];
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
    UPDATE access_profiles SET client_phone = '', updated_at = datetime('now') WHERE id = ?
  `).run(id);
  if (result.changes === 0) return null;
  return getProfileById(id);
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
    id:          row.id,
    accountId:   row.account_id,
    slotNumber:  row.slot_number,
    profileName: row.profile_name ?? "",
    clientPhone: row.client_phone ?? "",
    updatedAt:   row.updated_at,
  };
}
