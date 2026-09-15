import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────────────────────

export type AccessProfile = {
  id:          number;
  accountId:   number;
  slotNumber:  number;
  profileName: string;
  clientName:  string;
  clientPhone: string;
  expiresAt:   string | null;
  updatedAt:   string;
};

export type AccessAccount = {
  id:        number;
  platform:  string;
  email:     string;
  password:  string;
  notes:     string;
  createdAt: string;
  updatedAt: string;
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

export function createAccount(params: {
  platform: string;
  email:    string;
  password: string;
  notes?:   string;
  slots?:   number;
}): AccessAccountWithProfiles {
  const slots = Math.min(Math.max(params.slots ?? 5, 1), 10);

  const insertAccount = db.prepare(`
    INSERT INTO access_accounts (platform, email, password, notes)
    VALUES (?, ?, ?, ?)
  `);
  const insertProfile = db.prepare(`
    INSERT INTO access_profiles (account_id, slot_number, profile_name)
    VALUES (?, ?, ?)
  `);

  const accountId = db.transaction(() => {
    const result = insertAccount.run(
      params.platform.trim().toUpperCase(),
      params.email.trim(),
      params.password,
      params.notes?.trim() ?? ""
    );
    const id = result.lastInsertRowid as number;
    for (let slot = 1; slot <= slots; slot++) {
      insertProfile.run(id, slot, "Perfil " + slot);
    }
    return id;
  })();

  return getAccountById(accountId)!;
}

export function updateAccount(id: number, params: {
  platform?: string;
  email?:    string;
  password?: string;
  notes?:    string;
}): AccessAccountWithProfiles | null {
  const current = getAccountById(id);
  if (!current) return null;

  db.prepare(`
    UPDATE access_accounts
    SET platform = ?, email = ?, password = ?, notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    (params.platform ?? current.platform).trim().toUpperCase(),
    (params.email ?? current.email).trim(),
    params.password ?? current.password,
    (params.notes ?? current.notes).trim(),
    id
  );

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
      SUM(CASE WHEN p.client_phone != '' AND p.expires_at IS NOT NULL THEN 1 ELSE 0 END) AS occupiedCount
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

export function assignProfileClient(id: number, params: {
  clientName:  string;
  clientPhone: string;
  expiresAt:   string; // YYYY-MM-DD
  profileName?: string;
}): AccessProfile | null {
  const current = getProfileById(id);
  if (!current) return null;

  db.prepare(`
    UPDATE access_profiles
    SET client_name = ?, client_phone = ?, expires_at = ?, profile_name = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    params.clientName.trim(),
    params.clientPhone.replace(/\D/g, ""),
    params.expiresAt,
    (params.profileName ?? current.profileName).trim(),
    id
  );

  return getProfileById(id);
}

export function setProfileExpiry(id: number, expiresAt: string): AccessProfile | null {
  db.prepare(`
    UPDATE access_profiles SET expires_at = ?, updated_at = datetime('now') WHERE id = ?
  `).run(expiresAt, id);
  return getProfileById(id);
}

export function releaseProfile(id: number): AccessProfile | null {
  db.prepare(`
    UPDATE access_profiles
    SET client_name = '', client_phone = '', expires_at = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
  return getProfileById(id);
}

// ─────────────────────────────────────────────────────────────
// BÚSQUEDA
// ─────────────────────────────────────────────────────────────

export type ProfileWithAccount = AccessProfile & {
  platform: string;
  email:    string;
  password: string;
};

/** Cuentas cuyo correo contiene el término buscado. */
export function searchAccountsByEmail(term: string): AccessAccountWithProfiles[] {
  const rows = db.prepare(`
    SELECT * FROM access_accounts WHERE email LIKE ? ORDER BY platform ASC
  `).all("%" + term.trim() + "%") as any[];
  return rows.map(row => ({ ...toAccount(row), profiles: getProfilesByAccount(row.id) }));
}

/** Perfiles (con su cuenta) cuyo teléfono de cliente coincide, más recientes primero. */
export function searchProfilesByPhone(term: string): ProfileWithAccount[] {
  const digits = term.replace(/\D/g, "");
  if (!digits) return [];

  const rows = db.prepare(`
    SELECT p.*, a.platform AS platform, a.email AS email, a.password AS password
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE p.client_phone LIKE ?
    ORDER BY p.expires_at ASC
  `).all("%" + digits + "%") as any[];

  return rows.map(row => ({ ...toProfile(row), platform: row.platform, email: row.email, password: row.password }));
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function toAccount(row: any): AccessAccount {
  return {
    id:        row.id,
    platform:  row.platform,
    email:     row.email,
    password:  row.password,
    notes:     row.notes ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProfile(row: any): AccessProfile {
  return {
    id:          row.id,
    accountId:   row.account_id,
    slotNumber:  row.slot_number,
    profileName: row.profile_name ?? "",
    clientName:  row.client_name ?? "",
    clientPhone: row.client_phone ?? "",
    expiresAt:   row.expires_at ?? null,
    updatedAt:   row.updated_at,
  };
}
