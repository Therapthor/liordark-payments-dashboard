import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// COMBOS (Configuración > Catálogo > Combos)
//
// Un combo agrupa perfiles de VARIAS plataformas distintas bajo un solo
// pago (ej. 1 Netflix + 1 Spotify + 1 Crunchyroll) — no varios perfiles
// repetidos de una misma plataforma. Todavía NO está conectado al flujo
// de WhatsApp — se prepara para cuando el catálogo se traspase al panel
// y la entrega pueda ser automática/inmediata.
// ─────────────────────────────────────────────────────────────

export type ComboItem = {
  platform: string;
  quantity: number;
};

export type Combo = {
  id:          number;
  name:        string;
  price:       string;
  description: string;
  imageUrl:    string;
  active:      boolean;
  items:       ComboItem[];
  createdAt:   string;
  updatedAt:   string;
};

export type ComboInput = {
  name:        string;
  price:       string;
  description: string;
  imageUrl:    string;
  items:       ComboItem[];
};

function toCombo(row: any, items: ComboItem[]): Combo {
  return {
    id:          row.id,
    name:        row.name,
    price:       row.price,
    description: row.description,
    imageUrl:    row.image_url,
    active:      !!row.active,
    items,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
}

function getItems(comboId: number): ComboItem[] {
  return (db.prepare(`
    SELECT platform, quantity FROM catalog_combo_items WHERE combo_id = ? ORDER BY id ASC
  `).all(comboId) as any[]).map(r => ({ platform: r.platform, quantity: r.quantity }));
}

function setItems(comboId: number, items: ComboItem[]): void {
  db.prepare(`DELETE FROM catalog_combo_items WHERE combo_id = ?`).run(comboId);
  const insert = db.prepare(`
    INSERT INTO catalog_combo_items (combo_id, platform, quantity) VALUES (?, ?, ?)
  `);
  for (const item of items) {
    if (!item.platform) continue;
    insert.run(comboId, item.platform, item.quantity > 0 ? item.quantity : 1);
  }
}

export function listCombos(activeOnly = false): Combo[] {
  const where = activeOnly ? "WHERE active = 1" : "";
  const rows = db.prepare(`SELECT * FROM catalog_combos ${where} ORDER BY name ASC`).all() as any[];
  return rows.map(row => toCombo(row, getItems(row.id)));
}

export function createCombo(c: ComboInput): Combo {
  const create = db.transaction((input: ComboInput) => {
    const result = db.prepare(`
      INSERT INTO catalog_combos (name, price, description, image_url)
      VALUES (?, ?, ?, ?)
    `).run(input.name, input.price, input.description, input.imageUrl);

    const comboId = result.lastInsertRowid as number;
    setItems(comboId, input.items);
    return comboId;
  });

  const comboId = create(c);
  const row = db.prepare(`SELECT * FROM catalog_combos WHERE id = ?`).get(comboId);
  return toCombo(row, getItems(comboId));
}

export function updateCombo(id: number, c: ComboInput): Combo | null {
  const update = db.transaction((input: ComboInput) => {
    db.prepare(`
      UPDATE catalog_combos
      SET name = ?, price = ?, description = ?, image_url = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(input.name, input.price, input.description, input.imageUrl, id);
    setItems(id, input.items);
  });
  update(c);

  const row = db.prepare(`SELECT * FROM catalog_combos WHERE id = ?`).get(id);
  return row ? toCombo(row, getItems(id)) : null;
}

export function setComboActive(id: number, active: boolean): Combo | null {
  db.prepare(`
    UPDATE catalog_combos SET active = ?, updated_at = datetime('now') WHERE id = ?
  `).run(active ? 1 : 0, id);
  const row = db.prepare(`SELECT * FROM catalog_combos WHERE id = ?`).get(id);
  return row ? toCombo(row, getItems(id)) : null;
}

export function deleteCombo(id: number): void {
  const remove = db.transaction((comboId: number) => {
    db.prepare(`DELETE FROM catalog_combo_items WHERE combo_id = ?`).run(comboId);
    db.prepare(`DELETE FROM catalog_combos WHERE id = ?`).run(comboId);
  });
  remove(id);
}
