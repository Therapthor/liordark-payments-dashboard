import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// PROVEEDORES (Configuración > Proveedores)
//
// Alimenta el desplegable de "Proveedor" al crear/editar cuentas en
// Accesos, y el botón 🔑 de soporte (abre WhatsApp al proveedor de esa
// cuenta) — así no hay que escribirles el número a mano cada vez.
// ─────────────────────────────────────────────────────────────

export type Provider = {
  id:        number;
  name:      string;
  whatsapp:  string;
  notes:     string;
  active:    boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProviderInput = {
  name:     string;
  whatsapp: string;
  notes:    string;
};

function toProvider(row: any): Provider {
  return {
    id:        row.id,
    name:      row.name,
    whatsapp:  row.whatsapp,
    notes:     row.notes,
    active:    !!row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** activeOnly=true excluye los apagados — es lo que usa el desplegable de Accesos. */
export function listProviders(activeOnly = false): Provider[] {
  const where = activeOnly ? "WHERE active = 1" : "";
  return (db.prepare(`SELECT * FROM providers ${where} ORDER BY name ASC`).all() as any[]).map(toProvider);
}

export function getProviderByName(name: string): Provider | null {
  const row = db.prepare(`
    SELECT * FROM providers WHERE UPPER(TRIM(name)) = UPPER(TRIM(?))
  `).get(name);
  return row ? toProvider(row) : null;
}

export function createProvider(p: ProviderInput): Provider {
  const result = db.prepare(`
    INSERT INTO providers (name, whatsapp, notes) VALUES (?, ?, ?)
  `).run(p.name, p.whatsapp, p.notes);
  return toProvider(db.prepare(`SELECT * FROM providers WHERE id = ?`).get(result.lastInsertRowid));
}

export function updateProvider(id: number, p: ProviderInput): Provider | null {
  db.prepare(`
    UPDATE providers SET name = ?, whatsapp = ?, notes = ?, updated_at = datetime('now') WHERE id = ?
  `).run(p.name, p.whatsapp, p.notes, id);
  const row = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id);
  return row ? toProvider(row) : null;
}

export function setProviderActive(id: number, active: boolean): Provider | null {
  db.prepare(`
    UPDATE providers SET active = ?, updated_at = datetime('now') WHERE id = ?
  `).run(active ? 1 : 0, id);
  const row = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id);
  return row ? toProvider(row) : null;
}

export function deleteProvider(id: number): void {
  db.prepare(`DELETE FROM providers WHERE id = ?`).run(id);
}
