import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// CLIENTES DE LA TIENDA WEB — ver tables.sql (customers)
// Login/registro es solo con celular + contraseña, sin correo.
// ─────────────────────────────────────────────────────────────

export type Customer = {
  id:                number;
  phone:             string;
  passwordHash:      string;
  isGuest:           boolean;
  generatedPassword: string;
  createdAt:         string;
};

function toCustomer(row: any): Customer {
  return {
    id:                row.id,
    phone:             row.phone,
    passwordHash:      row.password_hash,
    isGuest:           !!row.is_guest,
    generatedPassword: row.generated_password,
    createdAt:         row.created_at,
  };
}

export function normalizeCustomerPhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function createCustomer(
  phone: string,
  passwordHash: string,
  opts?: { isGuest?: boolean; generatedPassword?: string }
): Customer {
  const info = db.prepare(`
    INSERT INTO customers (phone, password_hash, is_guest, generated_password) VALUES (?, ?, ?, ?)
  `).run(
    normalizeCustomerPhone(phone),
    passwordHash,
    opts?.isGuest ? 1 : 0,
    opts?.generatedPassword ?? ""
  );

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
