import { db } from "../db/db";
import { createWholesalerNotification } from "../db/wholesaler-notifications.repository";
import { limaTodayISO, addDaysISO } from "./access.service";

// ─────────────────────────────────────────────────────────────
// AVISO DE RENOVACIÓN PARA MAYORISTAS — en vez de un aviso por cada perfil,
// UN resumen por mayorista 1 día antes del vencimiento (solo ese día)
// (solo la campanita de mayorista.liordark.com, nunca WhatsApp). Al tocarlo
// se abre Clientes › «Por vencer».
//
// Cuándo se corta un perfil que no se renovó:
//  · si la cuenta se renueva con el proveedor para los que pagaron, el corte
//    diario de las 10 p. m. (Lima) saca a los demás el MISMO día que vence
//    (o al confirmar, si el admin la confirma desde un día antes);
//  · si nadie la renovó, la cuenta entera se archiva apenas pasa ese día.
// Por eso el aviso dice «antes del corte del <día que vence> a las 10 p. m.».
// «Renovar» del mayorista = pagar con su saldo (Clientes › Renovar): el
// perfil queda «✅ Renueva» y ya no se corta. «No renueva» no se avisa.
// ─────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS wholesaler_expiry_digests (
    wholesaler_id  INTEGER NOT NULL,
    threshold_days INTEGER NOT NULL,
    digest_date    TEXT    NOT NULL,
    expires_on     TEXT    NOT NULL,
    profile_count  INTEGER NOT NULL,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (wholesaler_id, threshold_days, digest_date)
  );
`);

/** Días antes del vencimiento en que sale el resumen (0 = «vencen hoy»). */
export const DIGEST_THRESHOLDS = [1] as const; // pedido del dueño: solo el día antes
const CUTOVER_TIME = "10 p. m."; // RENEWAL_CUTOVER_HOUR_LIMA en index.ts

function ddmm(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

export function digestMessage(threshold: number, count: number, expiresOn: string): string {
  const one = count === 1;
  const what = one ? "1 cuenta tuya vence" : `${count} cuentas tuyas vencen`;
  const date = ddmm(expiresOn);
  const when = threshold === 0 ? `hoy (${date})` : threshold === 1 ? `mañana (${date})` : `en ${threshold} días (${date})`;
  const cut = threshold === 0 ? `del corte de hoy a las ${CUTOVER_TIME}` : `del corte del ${date} a las ${CUTOVER_TIME}`;
  return `⏰ ${what} ${when}. ${one ? "Renuévala" : "Renuévalas"} antes ${cut} para no ${one ? "perderla" : "perderlas"}.`;
}

/** Perfiles de clientes de mayoristas que se cortan ese día si no se renuevan.
 *  Si la cuenta ya se renovó con el proveedor, el corte de quien no pagó es
 *  la fecha original (renewal_cleanup_due_at), no la nueva. */
function expiringCounts(dateISO: string, wholesalerId: number | null): { wholesalerId: number; count: number }[] {
  return db.prepare(`
    SELECT p.wholesaler_id AS wholesalerId, COUNT(*) AS count
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE p.wholesaler_id IS NOT NULL AND p.client_phone != ''
      AND (@wid IS NULL OR p.wholesaler_id = @wid)
      AND COALESCE(p.renewal_status, '') NOT IN ('yes', 'no')
      AND COALESCE(a.renewal_cleanup_due_at, a.expires_at) = @date
      AND a.platform NOT LIKE '%youtube%'
    GROUP BY p.wholesaler_id
  `).all({ date: dateISO, wid: wholesalerId }) as { wholesalerId: number; count: number }[];
}

const claimDigest = db.prepare(`
  INSERT OR IGNORE INTO wholesaler_expiry_digests (wholesaler_id, threshold_days, digest_date, expires_on, profile_count)
  VALUES (?, ?, ?, ?, ?)
`);

/** Crea los resúmenes que falten hoy (uno por mayorista y umbral, aunque el
 *  servidor se reinicie). Devuelve cuántos creó. */
export function generateWholesalerExpiryDigests(opts: { wholesalerId?: number; today?: string } = {}): number {
  const today = opts.today ?? limaTodayISO();
  let created = 0;
  const run = db.transaction(() => {
    for (const threshold of DIGEST_THRESHOLDS) {
      const expiresOn = addDaysISO(today, threshold);
      for (const row of expiringCounts(expiresOn, opts.wholesalerId ?? null)) {
        if (claimDigest.run(row.wholesalerId, threshold, today, expiresOn, row.count).changes !== 1) continue;
        createWholesalerNotification(row.wholesalerId, "expiry_digest", "", "", digestMessage(threshold, row.count, expiresOn));
        created++;
      }
    }
    db.prepare(`DELETE FROM wholesaler_expiry_digests WHERE digest_date < ?`).run(addDaysISO(today, -30));
  });
  run();
  return created;
}
