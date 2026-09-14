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

console.log("🗄️  SQLite inicializado:", DB_PATH);
