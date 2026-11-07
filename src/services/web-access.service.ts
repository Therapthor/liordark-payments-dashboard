import crypto from "crypto";
import { db } from "../db/db";
import { normalizePeruPhone } from "../utils/phone.util";
import { hashPassword } from "./customer-auth.service";

// ─────────────────────────────────────────────────────────────
// ACCESO WEB PARA CLIENTES CON CUENTAS — todo celular que tiene cuentas
// (Accesos o reemplazo manual, solo clientes directos, no de mayoristas)
// y todavía no tiene usuario en liordark.com recibe uno con un PIN de 4
// números al azar. Así nadie más puede "registrarse" con su número: el
// PIN se ve en Clientes y el admin se lo pasa al dueño real (o le manda
// el link de cambio de PIN por WhatsApp). Corre al arrancar y cada hora.
// ─────────────────────────────────────────────────────────────

function last9(phone: string): string {
  return String(phone || "").replace(/\D/g, "").slice(-9);
}

/** Celulares (últimos 9) con cuentas y sin usuario web, con la fecha en
 *  que se les vio por primera vez (para no inflar «Registros este mes»). */
function holdersWithoutWebAccess(): { phone: string; firstSeenAt: string | null }[] {
  const rows = db.prepare(`
    SELECT client_phone AS phone, MIN(updated_at) AS firstSeenAt FROM access_profiles
    WHERE client_phone != '' AND wholesaler_id IS NULL GROUP BY client_phone
    UNION ALL
    SELECT client_phone AS phone, MIN(created_at) AS firstSeenAt FROM manual_account_overrides
    WHERE client_phone != '' AND wholesaler_id IS NULL GROUP BY client_phone
  `).all() as { phone: string; firstSeenAt: string | null }[];

  const registered = new Set(
    (db.prepare(`SELECT phone FROM customers`).all() as { phone: string }[]).map(r => last9(r.phone))
  );
  const byPhone = new Map<string, string | null>();
  for (const r of rows) {
    const d = last9(r.phone);
    // Celulares de Perú: 9 dígitos que empiezan con 9.
    if (!/^9\d{8}$/.test(d) || registered.has(d)) continue;
    const prev = byPhone.get(d);
    if (prev === undefined || (r.firstSeenAt && (!prev || r.firstSeenAt < prev))) byPhone.set(d, r.firstSeenAt);
  }
  return [...byPhone.entries()].map(([phone, firstSeenAt]) => ({ phone, firstSeenAt }));
}

function randomPin(): string {
  return String(crypto.randomInt(10000)).padStart(4, "0");
}

let running = false;

/** Crea el usuario web (PIN al azar, visible en el panel) a cada cliente
 *  con cuentas que aún no tiene. Devuelve cuántos se crearon. */
export async function ensureWebAccessForAccountHolders(): Promise<number> {
  if (running) return 0;
  running = true;
  let created = 0;
  try {
    for (const holder of holdersWithoutWebAccess()) {
      const pin = randomPin();
      const hash = await hashPassword(pin);
      // Se vuelve a mirar justo antes: el cliente pudo crearse mientras tanto.
      const exists = db.prepare(`SELECT 1 FROM customers WHERE substr(phone, -9) = ? LIMIT 1`).get(holder.phone);
      if (exists) continue;
      db.prepare(`
        INSERT INTO customers (phone, password_hash, password_plain, is_guest, created_at)
        VALUES (?, ?, ?, 1, COALESCE(?, datetime('now')))
      `).run(normalizePeruPhone(holder.phone), hash, pin, holder.firstSeenAt);
      created++;
    }
  } finally {
    running = false;
  }
  return created;
}
