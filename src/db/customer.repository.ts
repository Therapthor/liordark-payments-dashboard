import { db } from "./db";

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
  `).run(normalizeCustomerPhone(phone), passwordHash, passwordPlain, isGuest ? 1 : 0);

  return findCustomerById(info.lastInsertRowid as number) as Customer;
}

export function findCustomerByPhone(phone: string): Customer | null {
  const row = db.prepare(`SELECT * FROM customers WHERE phone = ?`).get(normalizeCustomerPhone(phone));
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
