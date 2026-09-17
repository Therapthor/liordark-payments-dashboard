import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// HISTORIAL DE CUENTAS VENCIDAS (Accesos > Historial)
//
// Cuando una cuenta vence, se copia completa (perfiles incluidos, como
// snapshot) acá y se borra de access_accounts/access_profiles — ver
// archiveExpiredAccounts(), corrida periódica desde index.ts. Es de solo
// lectura desde el panel: sirve para resolver reclamos futuros, no para
// operar cuentas activas.
// ─────────────────────────────────────────────────────────────

export type ArchivedProfile = {
  slotNumber:    number;
  profileName:   string;
  clientPhone:   string;
  renewalStatus: string;
};

export type ArchivedAccount = {
  id:                 number;
  originalAccountId:  number;
  platform:           string;
  email:              string;
  password:           string;
  provider:           string;
  hasProfiles:        boolean;
  expiresAt:          string | null;
  link:               string;
  notes:              string;
  profiles:           ArchivedProfile[];
  archivedAt:         string;
};

function toArchived(row: any): ArchivedAccount {
  let profiles: ArchivedProfile[] = [];
  try { profiles = JSON.parse(row.profiles_json || "[]"); } catch { /* queda vacío */ }
  return {
    id:                row.id,
    originalAccountId: row.original_account_id,
    platform:          row.platform,
    email:             row.email,
    password:          row.password,
    provider:          row.provider ?? "",
    hasProfiles:       row.has_profiles === 1,
    expiresAt:         row.expires_at ?? null,
    link:              row.link ?? "",
    notes:             row.notes ?? "",
    profiles,
    archivedAt:        row.archived_at,
  };
}

export function listArchivedAccounts(): ArchivedAccount[] {
  return (db.prepare(`
    SELECT * FROM access_accounts_history ORDER BY archived_at DESC LIMIT 500
  `).all() as any[]).map(toArchived);
}

/** Busca por correo, plataforma, o teléfono de cliente (dentro del snapshot de perfiles). */
export function searchArchivedAccounts(term: string): ArchivedAccount[] {
  const like = `%${term}%`;
  return (db.prepare(`
    SELECT * FROM access_accounts_history
    WHERE email LIKE ? OR platform LIKE ? OR profiles_json LIKE ?
    ORDER BY archived_at DESC LIMIT 200
  `).all(like, like, like) as any[]).map(toArchived);
}

/**
 * Archiva toda cuenta con expires_at < todayISO: copia cuenta + perfiles a
 * access_accounts_history (como snapshot JSON) y la borra de las tablas
 * activas. Devuelve cuántas se archivaron. Sin vencimiento (expires_at
 * NULL) nunca se toca.
 */
export function archiveExpiredAccounts(todayISO: string): number {
  const expired = db.prepare(`
    SELECT * FROM access_accounts WHERE expires_at IS NOT NULL AND expires_at < ?
  `).all(todayISO) as any[];

  if (expired.length === 0) return 0;

  const getProfiles   = db.prepare(`SELECT * FROM access_profiles WHERE account_id = ? ORDER BY slot_number ASC`);
  const insertHistory  = db.prepare(`
    INSERT INTO access_accounts_history
      (original_account_id, platform, email, password, provider, has_profiles, expires_at, link, notes, profiles_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteProfiles = db.prepare(`DELETE FROM access_profiles WHERE account_id = ?`);
  const deleteAccount  = db.prepare(`DELETE FROM access_accounts WHERE id = ?`);

  const run = db.transaction((accounts: any[]) => {
    for (const acc of accounts) {
      const profiles: ArchivedProfile[] = (getProfiles.all(acc.id) as any[]).map(p => ({
        slotNumber:    p.slot_number,
        profileName:   p.profile_name,
        clientPhone:   p.client_phone,
        renewalStatus: p.renewal_status,
      }));
      insertHistory.run(
        acc.id, acc.platform, acc.email, acc.password, acc.provider,
        acc.has_profiles, acc.expires_at, acc.link, acc.notes, JSON.stringify(profiles)
      );
      deleteProfiles.run(acc.id);
      deleteAccount.run(acc.id);
    }
  });
  run(expired);

  return expired.length;
}
