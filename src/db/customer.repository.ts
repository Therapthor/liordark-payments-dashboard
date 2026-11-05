import bcrypt from "bcryptjs";
import { db } from "./db";
import { normalizePeruPhone } from "../utils/phone.util";
import { checkLockout, nextLockoutState, type LockoutCheck } from "../services/login-lockout.service";

// ─────────────────────────────────────────────────────────────
// CLIENTES DE LA TIENDA WEB — ver tables.sql (customers)
// Login/registro es solo con celular + contraseña, sin correo.
// Se guarda la contraseña en texto plano (además del hash, que es lo
// que realmente valida el login) para que el panel admin la pueda
// mostrar y reenviar por WhatsApp si el cliente la pierde — mismo
// criterio que ya se usa con las cuentas de streaming (Accesos).
// ─────────────────────────────────────────────────────────────

export type Customer = {
  id:              number;
  phone:           string;
  passwordHash:    string;
  passwordPlain:   string;
  isGuest:         boolean;
  email:           string;
  suspendedUntil:  string | null;
  lockedUntil:     string | null;
  createdAt:       string;
};

function toCustomer(row: any): Customer {
  return {
    id:              row.id,
    phone:           row.phone,
    passwordHash:    row.password_hash,
    passwordPlain:   row.password_plain,
    isGuest:         !!row.is_guest,
    email:           row.email || "",
    suspendedUntil:  row.suspended_until,
    lockedUntil:     row.locked_until,
    createdAt:       row.created_at,
  };
}

export function normalizeCustomerPhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function isCustomerSuspended(customer: Customer): boolean {
  return !!customer.suspendedUntil && new Date(customer.suspendedUntil).getTime() > Date.now();
}

export function createCustomer(
  phone: string,
  passwordHash: string,
  passwordPlain: string,
  isGuest = false
): Customer {
  const info = db.prepare(`
    INSERT INTO customers (phone, password_hash, password_plain, is_guest) VALUES (?, ?, ?, ?)
  `).run(normalizePeruPhone(phone), passwordHash, passwordPlain, isGuest ? 1 : 0);

  return findCustomerById(info.lastInsertRowid as number) as Customer;
}

// Últimos 9 dígitos — el mismo celular puede haber quedado guardado con o
// sin el prefijo "51" (dato viejo, o un cliente que lo tipeó distinto al
// loguearse vs. al registrarse). Los celulares de Perú son siempre 9
// dígitos, así que comparar por los últimos 9 encuentra al cliente sin
// importar qué formato tenga guardado o cómo lo haya tipeado ahora.
export function findCustomerByPhone(phone: string): Customer | null {
  const digits = normalizeCustomerPhone(phone);
  const row = db.prepare(`SELECT * FROM customers WHERE substr(phone, -9) = substr(?, -9) ORDER BY id LIMIT 1`).get(digits);
  return row ? toCustomer(row) : null;
}

export function findCustomerById(id: number): Customer | null {
  const row = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
  return row ? toCustomer(row) : null;
}

/** Para el panel admin — ver todos los clientes de la tienda web. */
export function listAllCustomers(): Customer[] {
  const rows = db.prepare(`SELECT * FROM customers ORDER BY created_at DESC`).all();
  return rows.map(toCustomer);
}

/** Suspender = pausar el login por `days` días (no borra nada). */
export function suspendCustomer(id: number, days: number): Customer | null {
  const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`UPDATE customers SET suspended_until = ? WHERE id = ?`).run(until, id);
  return findCustomerById(id);
}

/** Banear = borra la cuenta y sus datos de este panel (no toca cuentas de streaming ya entregadas). */
export function deleteCustomer(id: number): void {
  db.prepare(`DELETE FROM customers WHERE id = ?`).run(id);
}

/**
 * Genera una contraseña nueva para una cuenta ya existente (ej. las que
 * se registraron antes de guardar password_plain: su contraseña original
 * quedó solo como hash, irrecuperable). Cambia el login real del cliente
 * — se usa cuando el admin necesita poder verla/reenviarla igual.
 */
export function setCustomerPassword(id: number, passwordHash: string, passwordPlain: string): Customer | null {
  db.prepare(`UPDATE customers SET password_hash = ?, password_plain = ? WHERE id = ?`)
    .run(passwordHash, passwordPlain, id);
  return findCustomerById(id);
}

/** Bloqueo por intentos fallidos — ver login-lockout.service.ts para la fórmula. */
export function customerLockoutStatus(phone: string): LockoutCheck {
  const customer = findCustomerByPhone(phone);
  return checkLockout(customer?.lockedUntil);
}

export function recordCustomerLoginFailure(phone: string): void {
  const customer = findCustomerByPhone(phone);
  if (!customer) return;
  const row = db.prepare(`SELECT failed_login_count AS n FROM customers WHERE id = ?`).get(customer.id) as { n: number };
  const { failedLoginCount, lockedUntil } = nextLockoutState(row.n);
  db.prepare(`UPDATE customers SET failed_login_count = ?, locked_until = ? WHERE id = ?`)
    .run(failedLoginCount, lockedUntil, customer.id);
}

export function recordCustomerLoginSuccess(phone: string): void {
  const customer = findCustomerByPhone(phone);
  if (!customer) return;
  db.prepare(`UPDATE customers SET failed_login_count = 0, locked_until = NULL WHERE id = ?`).run(customer.id);
}

/** Admin: quita el bloqueo por intentos fallidos (y reinicia el contador). */
export function clearCustomerLockout(id: number): void {
  db.prepare(`UPDATE customers SET failed_login_count = 0, locked_until = NULL WHERE id = ?`).run(id);
}

/** Correo para avisos de vencimiento (Resend) — opcional, el cliente lo
 *  pone en el checkout o desde "Mis cuentas" (banner / botón recordatorio).
 *  Simple sanity check, no hace falta verificación: si está mal escrito
 *  el correo rebota y no pasa nada más. */
export function setCustomerEmail(id: number, email: string): Customer | null {
  const trimmed = email.trim().toLowerCase();
  db.prepare(`UPDATE customers SET email = ? WHERE id = ?`).run(trimmed, id);
  return findCustomerById(id);
}

/** Cuántos ya pusieron su correo (banner/botón de recordatorio) — panel
 *  "Clientes", para seguir qué tanto se está adoptando el aviso por correo. */
export function countCustomersWithEmail(): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE email != ''`).get() as { n: number };
  return row.n;
}

export function countAllCustomers(): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM customers`).get() as { n: number };
  return row.n;
}

/**
 * Registros por día del mes en curso, para el gráfico de "Clientes web".
 * created_at se guarda en UTC sin indicarlo — se resta 5h (Lima, sin
 * horario de verano) antes de agrupar por día, mismo criterio que
 * limaTodayISO() en access.service.ts.
 */
export function dailyRegistrationsThisMonth(): { day: string; count: number }[] {
  return db.prepare(`
    SELECT date(created_at, '-5 hours') AS day, COUNT(*) AS count
    FROM customers
    WHERE date(created_at, '-5 hours') >= date('now', '-5 hours', 'start of month')
    GROUP BY day
    ORDER BY day ASC
  `).all() as { day: string; count: number }[];
}

// ─────────────────────────────────────────────────────────────
// DUPLICADOS — datos viejos dejaron el mismo celular dos veces (con y sin
// el "51"). El login siempre usó la fila más antigua (id menor), así que
// esa se queda con su PIN: el cliente sigue entrando igual. De la otra se
// rescata el correo, la contraseña visible (solo si es la misma) y todo lo
// del curso. La fila borrada queda respaldada en customers_merged.
// ─────────────────────────────────────────────────────────────
const CUSTOMER_REF_TABLES = [
  "course_purchases", "course_progress", "course_unlocks", "course_downloads",
  "course_coupons", "course_wholesale_claims", "pin_links",
];

export function mergeDuplicateCustomers(): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers_merged (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      merged_into INTEGER NOT NULL,
      row_json    TEXT    NOT NULL,
      merged_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const groups = db.prepare(`
    SELECT substr(phone, -9) AS d FROM customers GROUP BY substr(phone, -9) HAVING COUNT(*) > 1
  `).all() as { d: string }[];
  const existingTables = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(t => t.name),
  );
  let merged = 0;
  const run = db.transaction((d: string) => {
    const rows = db.prepare(`SELECT * FROM customers WHERE substr(phone, -9) = ? ORDER BY id`).all(d) as any[];
    const keep = rows[0];
    let { email, password_plain: plain, is_guest: isGuest, created_at: createdAt } = keep;
    for (const r of rows.slice(1)) {
      if (!email && r.email) email = r.email;
      if (!plain && r.password_plain && bcrypt.compareSync(r.password_plain, keep.password_hash)) plain = r.password_plain;
      if (!r.is_guest) isGuest = 0;
      if (r.created_at < createdAt) createdAt = r.created_at;
      for (const t of CUSTOMER_REF_TABLES) {
        if (!existingTables.has(t)) continue;
        db.prepare(`UPDATE OR IGNORE ${t} SET customer_id = ? WHERE customer_id = ?`).run(keep.id, r.id);
        db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(r.id);
      }
      db.prepare(`INSERT INTO customers_merged (merged_into, row_json) VALUES (?, ?)`).run(keep.id, JSON.stringify(r));
      db.prepare(`DELETE FROM customers WHERE id = ?`).run(r.id);
      merged++;
    }
    db.prepare(`
      UPDATE customers SET phone = ?, email = ?, password_plain = ?, is_guest = ?, created_at = ? WHERE id = ?
    `).run(normalizePeruPhone(d), email || "", plain || "", isGuest ? 1 : 0, createdAt, keep.id);
  });
  for (const g of groups) {
    try { run(g.d); } catch (err: any) { console.error("⚠️ fusión de clientes duplicados:", g.d, err?.message); }
  }
  if (merged) console.log(`👥 Clientes duplicados fusionados: ${merged}`);
  return merged;
}
