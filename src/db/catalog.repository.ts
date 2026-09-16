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
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
}

export function listCatalogProducts(): CatalogProduct[] {
  return (db.prepare(`
    SELECT * FROM catalog_products ORDER BY platform ASC
  `).all() as any[]).map(toProduct);
}

export function getCatalogProductByPlatform(platform: string): CatalogProduct | null {
  const row = db.prepare(`
    SELECT * FROM catalog_products WHERE UPPER(TRIM(platform)) = UPPER(TRIM(?))
  `).get(platform);
  return row ? toProduct(row) : null;
}

export function createCatalogProduct(p: CatalogProductInput): CatalogProduct {
  const result = db.prepare(`
    INSERT INTO catalog_products (platform, title, price, has_profiles, description, image_url)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(p.platform, p.title, p.price, p.hasProfiles ? 1 : 0, p.description, p.imageUrl);

  return toProduct(db.prepare(`SELECT * FROM catalog_products WHERE id = ?`).get(result.lastInsertRowid));
}

export function updateCatalogProduct(id: number, p: CatalogProductInput): CatalogProduct | null {
  db.prepare(`
    UPDATE catalog_products
    SET platform = ?, title = ?, price = ?, has_profiles = ?, description = ?, image_url = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(p.platform, p.title, p.price, p.hasProfiles ? 1 : 0, p.description, p.imageUrl, id);

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
