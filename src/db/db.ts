import Database, { type Database as DatabaseType } from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH     = path.resolve(process.cwd(), "data/payments.db");
const SCHEMA_PATH = path.resolve(process.cwd(), "data/tables.sql");
const dataDir     = path.dirname(DB_PATH);

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

export const db: DatabaseType = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

try {
  const ddl = fs.readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(ddl);
  console.log("🗄️  Esquema cargado desde: " + SCHEMA_PATH);
} catch (err: any) {
  console.error("❌ Error cargando esquema SQL:", err?.message);
  throw err;
}

// ─────────────────────────────────────────────────────────────
// MIGRACIONES — columnas agregadas después del primer despliegue.
// CREATE TABLE IF NOT EXISTS no las suma solo; para una instancia
// que ya tenía la tabla, se agregan acá si todavía faltan.
// ─────────────────────────────────────────────────────────────

function ensureColumn(table: string, column: string, columnDdl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDdl}`);
    console.log(`🗄️  Migración: ${table}.${column} agregada`);
  }
}

ensureColumn("access_accounts", "provider",     "provider TEXT NOT NULL DEFAULT ''");
ensureColumn("access_accounts", "has_profiles", "has_profiles INTEGER NOT NULL DEFAULT 1");
ensureColumn("access_accounts", "expires_at",   "expires_at TEXT");
ensureColumn("access_accounts", "link",         "link TEXT NOT NULL DEFAULT ''");
ensureColumn("access_profiles", "renewal_status", "renewal_status TEXT NOT NULL DEFAULT ''");
ensureColumn("catalog_products", "active", "active INTEGER NOT NULL DEFAULT 1");
ensureColumn("payment_methods", "image_url", "image_url TEXT NOT NULL DEFAULT ''");
ensureColumn("catalog_products", "keywords", "keywords TEXT NOT NULL DEFAULT ''");
ensureColumn("access_profiles", "order_ref", "order_ref TEXT NOT NULL DEFAULT ''");

// catalog_combos era "un combo = una plataforma con cantidad" (ej. Netflix
// x2). Cambió a "un combo = varias plataformas juntas" (ej. 1 Netflix + 1
// Spotify + 1 Crunchyroll), moviendo platform/quantity a la nueva tabla
// catalog_combo_items. Si la tabla vieja todavía tiene esas columnas, se
// migra cada combo existente a un item (conserva lo que ya se hubiera
// creado, en vez de perderlo).
{
  const comboCols = db.prepare(`PRAGMA table_info(catalog_combos)`).all() as { name: string }[];
  if (comboCols.some(c => c.name === "platform")) {
    const oldCombos = db.prepare(`SELECT * FROM catalog_combos`).all() as any[];

    db.exec(`DROP TABLE catalog_combos`);
    db.exec(`
      CREATE TABLE catalog_combos (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL,
        price        TEXT    NOT NULL DEFAULT '0',
        description  TEXT    NOT NULL DEFAULT '',
        image_url    TEXT    NOT NULL DEFAULT '',
        active       INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS catalog_combo_items (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        combo_id  INTEGER NOT NULL,
        platform  TEXT    NOT NULL,
        quantity  INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_combo_items_combo ON catalog_combo_items(combo_id);
    `);

    const insertCombo = db.prepare(`
      INSERT INTO catalog_combos (id, name, price, description, image_url, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertItem = db.prepare(`
      INSERT INTO catalog_combo_items (combo_id, platform, quantity) VALUES (?, ?, ?)
    `);
    const migrate = db.transaction((rows: any[]) => {
      for (const r of rows) {
        insertCombo.run(r.id, r.name, r.price, r.description, r.image_url, r.active, r.created_at, r.updated_at);
        if (r.platform) insertItem.run(r.id, r.platform, r.quantity || 1);
      }
    });
    migrate(oldCombos);

    console.log(`🗄️  Migración: ${oldCombos.length} combo(s) pasados al nuevo formato (varias plataformas por combo)`);
  }
}

// orders_log guardaba created_at con datetime('now') (UTC, sin "Z"). El
// navegador interpretaba ese texto como hora local y mostraba la orden
// 5 horas más tarde (offset de Lima). Se corrigen las filas viejas una
// sola vez agregando la "Z" que les falta.
{
  const fixed = db.prepare(`
    UPDATE orders_log
    SET created_at = REPLACE(created_at, ' ', 'T') || 'Z'
    WHERE created_at NOT LIKE '%Z'
  `).run();
  if (fixed.changes > 0) {
    console.log(`🗄️  Migración: ${fixed.changes} horas corregidas en orders_log`);
  }
}

console.log("🗄️  SQLite inicializado:", DB_PATH);
