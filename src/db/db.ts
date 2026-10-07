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
ensureColumn("access_profiles", "reminder_sent_at", "reminder_sent_at TEXT");
ensureColumn("access_accounts", "provider_renewal_enabled",   "provider_renewal_enabled INTEGER NOT NULL DEFAULT 0");
ensureColumn("access_accounts", "provider_renewal_cost",      "provider_renewal_cost TEXT NOT NULL DEFAULT ''");
ensureColumn("access_accounts", "provider_renewal_currency",  "provider_renewal_currency TEXT NOT NULL DEFAULT 'USDT'");
ensureColumn("access_accounts", "provider_renewal_next_date", "provider_renewal_next_date TEXT");

// canva_orders_log ahora también registra GEMINI AI PRO y cualquier otra
// plataforma de activación manual — filas viejas se asumen CANVA (todo lo
// que esa tabla registraba antes de que existiera otra plataforma igual).
ensureColumn("canva_orders_log", "platform", "platform TEXT NOT NULL DEFAULT 'CANVA ANUAL'");

// Renovación manual (Accesos > Renovar) en dos pasos: al presionar "Renovar"
// se marca esta fecha (pendiente de pago), y recién al confirmar el pago se
// suman los 30 días de verdad — antes "➕30 días" extendía al toque, sin
// dejar registro de si el cliente ya había pagado o no.
ensureColumn("access_accounts", "renewal_pending_at", "renewal_pending_at TEXT");

// La tabla de suscripciones propias como lista aparte se reemplazó por el
// campo "renovación con proveedor" en cada cuenta de Accesos.
db.exec(`DROP TABLE IF EXISTS provider_subscriptions`);

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

// customers: dejó de usarse el correo (login/registro es solo con celular).
// Se reconstruye la tabla con "phone" como identificador único — antes el
// único era "email", así que podían existir dos cuentas con el mismo
// celular. Si eso pasa acá, se conserva la primera y se descartan las
// demás (fueron pruebas de los primeros días de la tienda).
{
  const customerCols = db.prepare(`PRAGMA table_info(customers)`).all() as { name: string }[];
  if (customerCols.some(c => c.name === "email")) {
    const oldCustomers = db.prepare(`SELECT * FROM customers ORDER BY id`).all() as any[];

    db.exec(`DROP TABLE customers`);
    db.exec(`
      CREATE TABLE customers (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        phone               TEXT    NOT NULL UNIQUE,
        password_hash       TEXT    NOT NULL,
        is_guest            INTEGER NOT NULL DEFAULT 0,
        generated_password  TEXT    NOT NULL DEFAULT '',
        created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const insertCustomer = db.prepare(`
      INSERT OR IGNORE INTO customers (id, phone, password_hash, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const migrate = db.transaction((rows: any[]) => {
      for (const r of rows) {
        if (!r.phone) continue; // sin celular no hay forma de loguearlo — eran pruebas
        insertCustomer.run(r.id, r.phone, r.password_hash, r.created_at);
      }
    });
    migrate(oldCustomers);

    console.log(`🗄️  Migración: customers pasó a usar el celular como identificador (${oldCustomers.length} cuenta(s) revisadas)`);
  }
}
ensureColumn("customers", "is_guest", "is_guest INTEGER NOT NULL DEFAULT 0");
ensureColumn("customers", "suspended_until", "suspended_until TEXT");

// generated_password (solo cuentas "Comprar sin cuenta") → password_plain
// (todas las cuentas), para poder reenviar accesos por WhatsApp sin
// importar si el cliente puso su propia contraseña o se la generamos.
{
  const cols = db.prepare(`PRAGMA table_info(customers)`).all() as { name: string }[];
  if (cols.some(c => c.name === "generated_password") && !cols.some(c => c.name === "password_plain")) {
    db.exec(`ALTER TABLE customers RENAME COLUMN generated_password TO password_plain`);
    console.log("🗄️  Migración: customers.generated_password → password_plain");
  }
}
ensureColumn("customers", "password_plain", "password_plain TEXT NOT NULL DEFAULT ''");

// ─────────────────────────────────────────────────────────────
// CÓDIGOS — cuentas marcadas para recibir código (Netflix/ChatGPT/etc.),
// los códigos que van llegando (Gmail por ahora, después scraping externo)
// y cuántas veces pidió código cada cliente por cuenta (límite fijo).
// En prueba: solo habilitado para el celular de test (ver codes.service.ts).
// ─────────────────────────────────────────────────────────────
ensureColumn("access_accounts", "codes_enabled", "codes_enabled INTEGER NOT NULL DEFAULT 0");

db.exec(`
  CREATE TABLE IF NOT EXISTS account_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    code       TEXT    NOT NULL,
    snippet    TEXT    NOT NULL DEFAULT '',
    source     TEXT    NOT NULL DEFAULT 'gmail',
    received_at TEXT   NOT NULL DEFAULT (datetime('now')),
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_account_codes_account ON account_codes(account_id);

  CREATE TABLE IF NOT EXISTS code_requests (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    client_phone   TEXT    NOT NULL,
    account_id     INTEGER NOT NULL,
    request_count  INTEGER NOT NULL DEFAULT 0,
    last_requested_at TEXT,
    UNIQUE(client_phone, account_id)
  );
`);

// ─────────────────────────────────────────────────────────────
// MAYORISTA — columnas nuevas en tablas que ya existían en producción
// (las tablas nuevas — wholesalers, wholesaler_credit_ledger,
// wholesale_full_account_orders — ya se crean solas desde tables.sql).
// ─────────────────────────────────────────────────────────────
ensureColumn("access_profiles", "wholesaler_id", "wholesaler_id INTEGER"); // NULL = stock normal de clientitos
ensureColumn("access_profiles", "seen_by_wholesaler", "seen_by_wholesaler INTEGER NOT NULL DEFAULT 1");
db.exec(`CREATE INDEX IF NOT EXISTS idx_access_profiles_wholesaler ON access_profiles(wholesaler_id)`);

ensureColumn("customers", "failed_login_count", "failed_login_count INTEGER NOT NULL DEFAULT 0");
ensureColumn("customers", "locked_until", "locked_until TEXT");

ensureColumn("catalog_products", "wholesale_price", "wholesale_price TEXT NOT NULL DEFAULT '0'");
ensureColumn("catalog_products", "wholesale_full_price", "wholesale_full_price TEXT NOT NULL DEFAULT '0'");

console.log("🗄️  SQLite inicializado:", DB_PATH);
