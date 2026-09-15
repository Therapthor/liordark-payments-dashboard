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
