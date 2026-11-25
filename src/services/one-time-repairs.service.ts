import { db } from "../db/db";

// ─────────────────────────────────────────────────────────────
// REPARACIONES PUNTUALES DE DATOS — corren una sola vez al arrancar el
// panel (quedan anotadas en one_time_repairs con su resultado) y solo si
// todo sigue como cuando se detectó el problema; si no, no tocan nada.
// ─────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS one_time_repairs (
    key     TEXT PRIMARY KEY,
    done_at TEXT NOT NULL DEFAULT (datetime('now')),
    result  TEXT NOT NULL DEFAULT ''
  );
`);

/** Corre `fn` una sola vez. Si falla o devuelve «pendiente: …» (falta un
 *  dato), no se anota y se vuelve a intentar en el próximo arranque. */
function once(key: string, fn: () => string): void {
  if (db.prepare(`SELECT 1 FROM one_time_repairs WHERE key = ?`).get(key)) return;
  let result: string;
  try { result = fn(); } catch (err: any) {
    console.error(`⚠️ Reparación «${key}» falló:`, err?.message);
    return;
  }
  if (!result.startsWith("pendiente:")) {
    db.prepare(`INSERT OR IGNORE INTO one_time_repairs (key, result) VALUES (?, ?)`).run(key, result);
  }
  console.log(`🔧 Reparación «${key}»: ${result}`);
}

/**
 * 24-nov-2026 — venta web de AMAZON (perfil 3909, orden …-184529db-…)
 * pagada por Yape a las 7:29 pm y liberada 8 min después con 🗑 en el panel
 * (el botón no pedía confirmación). Se le devuelve el perfil a su cliente
 * con la fecha que tuvo al comprar (30 días: 23-dic). El celular sale de la
 * orden pagada guardada en el panel, no del código.
 */
function restoreAmazonSale3909(): string {
  const PROFILE_ID = 3909;
  const ACCOUNT_ID = 1182;
  const prof = db.prepare(`
    SELECT p.client_phone AS phone, p.wholesaler_id AS wid, a.platform AS platform
    FROM access_profiles p JOIN access_accounts a ON a.id = p.account_id
    WHERE p.id = ? AND p.account_id = ?
  `).get(PROFILE_ID, ACCOUNT_ID) as { phone: string; wid: number | null; platform: string } | undefined;
  if (!prof) return "el perfil ya no existe: no se toca nada";
  if (String(prof.platform).toUpperCase() !== "AMAZON") return "el perfil no es de AMAZON: no se toca nada";
  if (prof.phone || prof.wid !== null) return "el perfil ya tiene dueño: no se toca nada";

  // La orden pagada (la guarda el panel al sincronizar los Yape).
  const names = [...new Set((db.prepare(
    `SELECT order_name AS name FROM payments WHERE order_name LIKE '%-184529db-%'`,
  ).all() as { name: string }[]).map(o => o.name).filter(Boolean))];
  if (names.length > 1) return `hay ${names.length} órdenes parecidas: no se toca nada`;
  let orderRef = names[0] ?? "";
  let phone = "";
  const m = /^web-(\d{9,15})-184529db-\d{8}$/.exec(orderRef);
  if (m) phone = m[1];
  else {
    // Respaldo: el aviso «cuenta nueva» que dejó esa venta (si el cliente no lo borró).
    const acc = db.prepare(`SELECT email FROM access_accounts WHERE id = ?`).get(ACCOUNT_ID) as { email: string };
    const sales = db.prepare(`
      SELECT DISTINCT client_phone AS phone FROM customer_notifications
      WHERE type = 'new_account' AND UPPER(platform) = 'AMAZON' AND account_email = ?
        AND created_at BETWEEN '2026-11-24 00:25:00' AND '2026-11-24 00:35:00'
    `).all(acc.email) as { phone: string }[];
    if (sales.length !== 1) return `pendiente: no se encontró la orden (${sales.length})`;
    phone = sales[0].phone;
    orderRef = `web-${phone}-184529db-20261124`;
  }
  const d9 = phone.replace(/\D/g, "").slice(-9);
  if (d9.length !== 9) return "celular inválido: no se toca nada";

  const already = db.prepare(`
    SELECT 1 FROM access_profiles p JOIN access_accounts a ON a.id = p.account_id
    WHERE UPPER(a.platform) = 'AMAZON' AND substr(p.client_phone, -9) = ?
  `).get(d9);
  if (already) return "el cliente ya tiene un perfil de AMAZON: no se toca nada";

  const r = db.prepare(`
    UPDATE access_profiles
    SET client_phone = ?, order_ref = ?, expires_override = '2026-12-23', plan_months = 1,
        pin_reset_pending = 0, updated_at = datetime('now')
    WHERE id = ? AND client_phone = '' AND wholesaler_id IS NULL
  `).run(phone, orderRef, PROFILE_ID);
  return r.changes ? "perfil devuelto a su cliente (vence 2026-12-23)" : "no se pudo actualizar";
}

/**
 * 25-nov-2026 — el dueño fijó los paquetes de créditos de Manguito Pro:
 * S/ 20 → US$ 50 y S/ 45 → US$ 100. Solo cambia si siguen los paquetes
 * de prueba de la primera versión (S/ 20 → US$ 4, S/ 50 → US$ 11…); si
 * ya los editó en el panel, no se tocan.
 */
function setManguitoCreditPacks(): string {
  const KEY = "ai_credit_packs";
  const row = db.prepare(`SELECT value FROM admin_settings WHERE key = ?`).get(KEY) as { value: string } | undefined;
  const NEW = JSON.stringify([{ priceSoles: 20, usd: 50 }, { priceSoles: 45, usd: 100 }]);
  if (!row) return "sin paquetes guardados: se usan los nuevos de fábrica";
  let packs: { priceSoles: number; usd: number }[] = [];
  try { packs = JSON.parse(row.value); } catch { return "paquetes ilegibles: no se tocan"; }
  const old = packs.length >= 1 && packs[0]?.priceSoles === 20 && packs[0]?.usd === 4 &&
    packs.every(p => (p.priceSoles === 20 && p.usd === 4) || (p.priceSoles === 50 && p.usd === 11) || (p.priceSoles === 100 && p.usd === 24));
  if (!old) return "ya editados en el panel: no se tocan";
  db.prepare(`UPDATE admin_settings SET value = ? WHERE key = ?`).run(NEW, KEY);
  return "paquetes cambiados a S/ 20 → US$ 50 y S/ 45 → US$ 100";
}

export function runOneTimeRepairs(): void {
  once("2026-11-24-amazon-3909", restoreAmazonSale3909);
  once("2026-11-25-manguito-packs", setManguitoCreditPacks);
  once("2026-11-25-manguito-venta", enableManguitoStore);
}

/** 25-nov-2026 — el dueño pidió publicar Manguito Pro a la venta en la tienda. */
function enableManguitoStore(): string {
  db.prepare(`INSERT INTO admin_settings (key, value) VALUES ('ai_store_enabled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`).run();
  return "Manguito Pro a la venta en la tienda";
}
