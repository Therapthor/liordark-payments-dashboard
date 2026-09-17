import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// MÉTODOS DE PAGO (Configuración > Métodos de pago)
//
// Lista propia del panel. Por ahora es solo referencia — el bot sigue
// manejando su propio selector de método de pago en WhatsApp (hoy, Yape).
// ─────────────────────────────────────────────────────────────

export type PaymentMethod = {
  id:          number;
  name:        string;
  description: string;
  imageUrl:    string;
  active:      boolean;
  createdAt:   string;
  updatedAt:   string;
};

export type PaymentMethodInput = {
  name:        string;
  description: string;
  imageUrl:    string;
};

function toMethod(row: any): PaymentMethod {
  return {
    id:          row.id,
    name:        row.name,
    description: row.description,
    imageUrl:    row.image_url,
    active:      !!row.active,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
}

export function listPaymentMethods(): PaymentMethod[] {
  return (db.prepare(`SELECT * FROM payment_methods ORDER BY name ASC`).all() as any[]).map(toMethod);
}

export function createPaymentMethod(p: PaymentMethodInput): PaymentMethod {
  const result = db.prepare(`
    INSERT INTO payment_methods (name, description, image_url) VALUES (?, ?, ?)
  `).run(p.name, p.description, p.imageUrl);
  return toMethod(db.prepare(`SELECT * FROM payment_methods WHERE id = ?`).get(result.lastInsertRowid));
}

export function updatePaymentMethod(id: number, p: PaymentMethodInput): PaymentMethod | null {
  db.prepare(`
    UPDATE payment_methods SET name = ?, description = ?, image_url = ?, updated_at = datetime('now') WHERE id = ?
  `).run(p.name, p.description, p.imageUrl, id);
  const row = db.prepare(`SELECT * FROM payment_methods WHERE id = ?`).get(id);
  return row ? toMethod(row) : null;
}

export function setPaymentMethodActive(id: number, active: boolean): PaymentMethod | null {
  db.prepare(`
    UPDATE payment_methods SET active = ?, updated_at = datetime('now') WHERE id = ?
  `).run(active ? 1 : 0, id);
  const row = db.prepare(`SELECT * FROM payment_methods WHERE id = ?`).get(id);
  return row ? toMethod(row) : null;
}

export function deletePaymentMethod(id: number): void {
  db.prepare(`DELETE FROM payment_methods WHERE id = ?`).run(id);
}

/** Primera vez que se usa esta lista, se siembra con Yape — que es el único método real hoy. */
export function seedPaymentMethodsIfEmpty(): void {
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM payment_methods`).get() as { count: number };
  if (count > 0) return;
  db.prepare(`
    INSERT INTO payment_methods (name, description) VALUES ('Yape', 'Pago por Yape con monto exacto (único método activo hoy en el bot)')
  `).run();
}
