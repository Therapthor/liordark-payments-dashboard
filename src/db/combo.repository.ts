import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// COMBOS (Configuración > Catálogo > Combos)
//
// Un combo agrupa varios perfiles de una misma plataforma bajo un solo
// pago (ej. "Netflix x2 perfiles"). Todavía NO está conectado al flujo
// de WhatsApp — se prepara para cuando el catálogo se traspase al panel
// y la entrega pueda ser automática/inmediata.
// ─────────────────────────────────────────────────────────────

export type Combo = {
  id:          number;
  name:        string;
  platform:    string;
  quantity:    number;
  price:       string;
  description: string;
  imageUrl:    string;
  active:      boolean;
  createdAt:   string;
  updatedAt:   string;
};

export type ComboInput = {
  name:        string;
  platform:    string;
  quantity:    number;
  price:       string;
  description: string;
  imageUrl:    string;
};

function toCombo(row: any): Combo {
  return {
    id:          row.id,
    name:        row.name,
    platform:    row.platform,
    quantity:    row.quantity,
    price:       row.price,
    description: row.description,
    imageUrl:    row.image_url,
    active:      !!row.active,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
}

export function listCombos(activeOnly = false): Combo[] {
  const where = activeOnly ? "WHERE active = 1" : "";
  return (db.prepare(`
    SELECT * FROM catalog_combos ${where} ORDER BY platform ASC, quantity ASC
  `).all() as any[]).map(toCombo);
}

export function createCombo(c: ComboInput): Combo {
  const result = db.prepare(`
    INSERT INTO catalog_combos (name, platform, quantity, price, description, image_url)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(c.name, c.platform, c.quantity, c.price, c.description, c.imageUrl);

  return toCombo(db.prepare(`SELECT * FROM catalog_combos WHERE id = ?`).get(result.lastInsertRowid));
}

export function updateCombo(id: number, c: ComboInput): Combo | null {
  db.prepare(`
    UPDATE catalog_combos
    SET name = ?, platform = ?, quantity = ?, price = ?, description = ?, image_url = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(c.name, c.platform, c.quantity, c.price, c.description, c.imageUrl, id);

  const row = db.prepare(`SELECT * FROM catalog_combos WHERE id = ?`).get(id);
  return row ? toCombo(row) : null;
}

export function setComboActive(id: number, active: boolean): Combo | null {
  db.prepare(`
    UPDATE catalog_combos SET active = ?, updated_at = datetime('now') WHERE id = ?
  `).run(active ? 1 : 0, id);
  const row = db.prepare(`SELECT * FROM catalog_combos WHERE id = ?`).get(id);
  return row ? toCombo(row) : null;
}

export function deleteCombo(id: number): void {
  db.prepare(`DELETE FROM catalog_combos WHERE id = ?`).run(id);
}
