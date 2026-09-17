import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// CATÁLOGO PROPIO DEL PANEL (Configuración > Catálogo)
//
// Independiente del catálogo del bot (Google Sheets). Alimenta el
// desplegable de plataforma en Accesos. Editar/agregar/quitar acá
// todavía NO cambia nada en WhatsApp — es la base para cuando se
// decida conectarlo más adelante.
// ─────────────────────────────────────────────────────────────

export type CatalogProduct = {
  id:          number;
  platform:    string;
  title:       string;
  price:       string;
  hasProfiles: boolean;
  description: string;
  imageUrl:    string;
  keywords:    string;
  active:      boolean;
  createdAt:   string;
  updatedAt:   string;
};

export type CatalogProductInput = {
  platform:    string;
  title:       string;
  price:       string;
  hasProfiles: boolean;
  description: string;
  imageUrl:    string;
  keywords:    string;
};

function toProduct(row: any): CatalogProduct {
  return {
    id:          row.id,
    platform:    row.platform,
    title:       row.title,
    price:       row.price,
    hasProfiles: !!row.has_profiles,
    description: row.description,
    imageUrl:    row.image_url,
    keywords:    row.keywords ?? "",
    active:      !!row.active,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
}

/** activeOnly=true excluye los productos apagados — es lo que usa el desplegable de Accesos. */
export function listCatalogProducts(activeOnly = false): CatalogProduct[] {
  const where = activeOnly ? "WHERE active = 1" : "";
  return (db.prepare(`
    SELECT * FROM catalog_products ${where} ORDER BY platform ASC
  `).all() as any[]).map(toProduct);
}

export function setCatalogProductActive(id: number, active: boolean): CatalogProduct | null {
  db.prepare(`
    UPDATE catalog_products SET active = ?, updated_at = datetime('now') WHERE id = ?
  `).run(active ? 1 : 0, id);
  const row = db.prepare(`SELECT * FROM catalog_products WHERE id = ?`).get(id);
  return row ? toProduct(row) : null;
}

export function getCatalogProductByPlatform(platform: string): CatalogProduct | null {
  const row = db.prepare(`
    SELECT * FROM catalog_products WHERE UPPER(TRIM(platform)) = UPPER(TRIM(?))
  `).get(platform);
  return row ? toProduct(row) : null;
}

export function createCatalogProduct(p: CatalogProductInput): CatalogProduct {
  const result = db.prepare(`
    INSERT INTO catalog_products (platform, title, price, has_profiles, description, image_url, keywords)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(p.platform, p.title, p.price, p.hasProfiles ? 1 : 0, p.description, p.imageUrl, p.keywords);

  return toProduct(db.prepare(`SELECT * FROM catalog_products WHERE id = ?`).get(result.lastInsertRowid));
}

export function updateCatalogProduct(id: number, p: CatalogProductInput): CatalogProduct | null {
  db.prepare(`
    UPDATE catalog_products
    SET platform = ?, title = ?, price = ?, has_profiles = ?, description = ?, image_url = ?, keywords = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(p.platform, p.title, p.price, p.hasProfiles ? 1 : 0, p.description, p.imageUrl, p.keywords, id);

  const row = db.prepare(`SELECT * FROM catalog_products WHERE id = ?`).get(id);
  return row ? toProduct(row) : null;
}

export function deleteCatalogProduct(id: number): void {
  db.prepare(`DELETE FROM catalog_products WHERE id = ?`).run(id);
}

/**
 * Primera vez que se usa este catálogo, se llena con lo que ya devuelve el
 * catálogo del bot (nombre + si usa perfiles) — así el desplegable de
 * Accesos sigue funcionando con las mismas plataformas de siempre en vez
 * de aparecer vacío. Precio/descripción/imagen quedan en blanco para que
 * se completen a mano en Configuración > Catálogo. Si la tabla ya tiene
 * algo (el usuario ya la editó), no se toca.
 */
export function seedCatalogIfEmpty(platforms: { platform: string; hasProfiles: boolean }[]): void {
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM catalog_products`).get() as { count: number };
  if (count > 0 || platforms.length === 0) return;

  const insert = db.prepare(`
    INSERT INTO catalog_products (platform, title, price, has_profiles, description, image_url)
    VALUES (?, '', '0', ?, '', '')
  `);
  const insertMany = db.transaction((rows: typeof platforms) => {
    for (const r of rows) insert.run(r.platform, r.hasProfiles ? 1 : 0);
  });
  insertMany(platforms);
  console.log("🗄️  Catálogo del panel sembrado con " + platforms.length + " plataformas del bot");
}
