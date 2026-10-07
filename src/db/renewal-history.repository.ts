import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// REGISTRO DE RENOVACIONES YA HECHAS (Accesos > Renovados — registro)
//
// A diferencia de renewal_status ("marcado para renovar", efímero —
// se borra apenas se renueva de verdad), esto es un historial
// permanente: una fila por cada cliente que estaba ocupando la cuenta
// en el momento de apretar "Renovar". Se escribe desde renewAccount()
// en access.service.ts.
// ─────────────────────────────────────────────────────────────

export type RenewalHistoryEntry = {
  id:           number;
  accountId:    number;
  platform:     string;
  platformTag:  string;
  clientPhone:  string;
  profileName:  string;
  newExpiresAt: string | null;
  renewedAt:    string;
};

export function logRenewalHistory(entries: {
  accountId:    number;
  platform:     string;
  platformTag:  string;
  clientPhone:  string;
  profileName:  string;
  newExpiresAt: string | null;
}[]): void {
  if (entries.length === 0) return;

  const insert = db.prepare(`
    INSERT INTO renewal_history_log (account_id, platform, platform_tag, client_phone, profile_name, new_expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const run = db.transaction((rows: typeof entries) => {
    for (const r of rows) {
      insert.run(r.accountId, r.platform, r.platformTag, r.clientPhone, r.profileName, r.newExpiresAt);
    }
  });
  run(entries);
}

export function listRenewalHistory(limit = 500): RenewalHistoryEntry[] {
  return (db.prepare(`
    SELECT * FROM renewal_history_log ORDER BY renewed_at DESC LIMIT ?
  `).all(limit) as any[]).map(row => ({
    id:           row.id,
    accountId:    row.account_id,
    platform:     row.platform,
    platformTag:  row.platform_tag ?? "",
    clientPhone:  row.client_phone,
    profileName:  row.profile_name ?? "",
    newExpiresAt: row.new_expires_at ?? null,
    renewedAt:    row.renewed_at,
  }));
}
