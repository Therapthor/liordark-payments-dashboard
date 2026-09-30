import { db } from "./db";
import { normalizePeruPhone } from "../utils/phone.util";

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
  suspendedUntil:  string | null;
  createdAt:       string;
};

function toCustomer(row: any): Customer {
  return {
    id:              row.id,
    phone:           row.phone,
    passwordHash:    row.password_hash,
    passwordPlain:   row.password_plain,
    isGuest:         !!row.is_guest,
    suspendedUntil:  row.suspended_until,
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
  const row = db.prepare(`SELECT * FROM customers WHERE substr(phone, -9) = substr(?, -9)`).get(digits);
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
