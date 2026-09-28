import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// CLIENTES DE LA TIENDA WEB — ver tables.sql (customers)
// ─────────────────────────────────────────────────────────────

export type Customer = {
  id:           number;
  email:        string;
  passwordHash: string;
  phone:        string;
  createdAt:    string;
};

function toCustomer(row: any): Customer {
  return {
    id:           row.id,
    email:        row.email,
    passwordHash: row.password_hash,
    phone:        row.phone,
    createdAt:    row.created_at,
  };
}

export function normalizeCustomerPhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function createCustomer(email: string, passwordHash: string, phone: string): Customer {
  const info = db.prepare(`
    INSERT INTO customers (email, password_hash, phone) VALUES (?, ?, ?)
  `).run(email.toLowerCase().trim(), passwordHash, normalizeCustomerPhone(phone));

  return findCustomerById(info.lastInsertRowid as number) as Customer;
}

export function findCustomerByEmail(email: string): Customer | null {
  const row = db.prepare(`SELECT * FROM customers WHERE email = ?`).get(email.toLowerCase().trim());
  return row ? toCustomer(row) : null;
}

export function findCustomerById(id: number): Customer | null {
  const row = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
  return row ? toCustomer(row) : null;
}
