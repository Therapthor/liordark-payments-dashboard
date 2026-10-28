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
ensureColumn("access_profiles", "sms_reminder_sent_at", "sms_reminder_sent_at TEXT"); // recordatorio SMS (ClickLab) — separado del de WhatsApp
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

// customers: dejó de usarse el correo como identificador (login/registro
// es solo con celular) — migración de una sola vez, de cuando la tabla
// todavía tenía "email" como columna ÚNICA/identificador viejo. YA SE
// EJECUTÓ en su momento y quedó retirada del todo: el guard de abajo
// comparaba "¿existe una columna llamada email?" para decidir si corría,
// pero como el correo de aviso de vencimiento (feature nueva, sin
// relación con el login viejo) también se llama "email" y vive en esta
// misma tabla, el guard volvía a dar true en CADA reinicio del servidor
// y volvía a *reconstruir* la tabla entera desde cero — borrando correo,
// contraseña en texto plano, is_guest, suspensión y bloqueo por intentos
// fallidos de TODOS los clientes, cada vez que pm2 reiniciaba el proceso.
// Si ves este comentario y estás por reactivar algo parecido: nunca
// reutilices el nombre de una columna futura como condición de una
// migración de una sola vez ya completada.
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

// Activación manual (CANVA, GEMINI AI PRO, YOUTUBE PREMIUM) — queda en 1
// al crear/renovar la cuenta, hasta que el admin confirme que ya hizo la
// activación real en la plataforma (invitar el correo, loguearse, etc.).
// Antes esto no quedaba registrado en ningún lado — "Pedidos pendientes"
// no mostraba nada y era fácil olvidar activarla.
ensureColumn("access_accounts", "activation_pending", "activation_pending INTEGER NOT NULL DEFAULT 0");

// Renovación automática por ciclo (ver access.service.ts runRenewalCutover):
// renewal_cleanup_due_at = fecha en que toca borrar los perfiles que no
// renovaron (se fija al extender la cuenta, 1 día antes de vencer, para no
// depender de expires_at que ya se movió 30 días para adelante en ese
// momento). password_change_pending = aviso para el admin de que hay que
// cambiarle la contraseña a la cuenta (clientes borrados que no deben
// poder volver a entrar con la contraseña vieja).
ensureColumn("access_accounts", "renewal_cleanup_due_at", "renewal_cleanup_due_at TEXT");
ensureColumn("access_accounts", "password_change_pending", "password_change_pending INTEGER NOT NULL DEFAULT 0");

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

// Correo de la cuenta que originó la notificación — para que, al tocarla
// en liordark.com, se pueda resaltar la tarjeta exacta en "Mis cuentas"
// (mismo criterio platform+email que ya usa accountKey() en el front).
ensureColumn("customer_notifications", "account_email", "account_email TEXT NOT NULL DEFAULT ''");

// Para no repetirle al mayorista la campanita de "cliente por vencer" cada
// vez que hace polling — se marca una vez avisado y se limpia solo al
// renovar la cuenta (ver resetRenewalMarkers).
ensureColumn("access_profiles", "expiry_notified_at", "expiry_notified_at TEXT");

// Mensaje que el admin le deja al cliente al marcar un reporte de soporte
// como atendido — se ve en la notificación de la campanita al hacer clic.
ensureColumn("support_tickets", "resolution_message", "resolution_message TEXT NOT NULL DEFAULT ''");

// Fecha de vencimiento "congelada" de un cliente cuando Soporte le
// reemplaza la cuenta — prevalece sobre access_accounts.expires_at para
// ESE cliente hasta que se limpia (ver resetRenewalMarkers). Así conserva
// su fecha original sin importar si la cuenta nueva está llena o es fresca.
ensureColumn("access_profiles", "expires_override", "expires_override TEXT");

// NULL = reporte de un cliente de liordark.com; si no, lo reportó ESE
// mayorista a nombre de uno de sus propios clientes (ver wholesaler.routes.ts).
ensureColumn("support_tickets", "wholesaler_id", "wholesaler_id INTEGER");
db.exec(`CREATE INDEX IF NOT EXISTS idx_support_tickets_wholesaler ON support_tickets(wholesaler_id)`);

// Se marca cuando el admin usa "Reemplazar" (pool o manual) sobre este
// reporte — al "Marcar atendido" cambia el mensaje por defecto de la
// notificación (avisa primero que se reemplazó la cuenta).
ensureColumn("support_tickets", "replaced_at", "replaced_at TEXT");

// Correo del cliente retail — opcional, solo para el aviso de vencimiento
// por correo (Resend). Vacío = no quiso o no lo puso todavía; en ese caso
// no se le manda nada y liordark.com le sigue mostrando el banner para pedirlo.
ensureColumn("customers", "email", "email TEXT NOT NULL DEFAULT ''");

// Recordatorio de vencimiento por CORREO — separado del de la campanita
// (expiry_notified_at) y del SMS/WhatsApp: una cuenta puede avisar por
// varios canales a la vez. Se manda a los 3 días y al 1 día antes de
// vencer; cada marca es independiente para no repetir ninguno de los dos.
ensureColumn("access_profiles", "email_reminder_3d_sent_at", "email_reminder_3d_sent_at TEXT");
ensureColumn("access_profiles", "email_reminder_1d_sent_at", "email_reminder_1d_sent_at TEXT");

// ─────────────────────────────────────────────────────────────
// CHAT DE SOPORTE EN VIVO — liordark.com <-> panel admin (de prueba, solo
// para un celular — ver SUPPORT_CHAT_TEST_PHONE en store.routes.ts).
// Un solo chat "open" a la vez por celular; al cerrarlo desde el panel se
// borra TODO (mensajes y medios de Cloudinary), a propósito, para no ir
// acumulando espacio con conversaciones ya resueltas.
// ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS support_chats (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    client_phone       TEXT    NOT NULL,
    admin_typing_at    TEXT,
    customer_typing_at TEXT,
    admin_seen_at      TEXT,
    customer_seen_at   TEXT,
    created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_support_chats_phone ON support_chats(client_phone)`);

// Etiqueta manual del admin para ordenar el inbox ("pendiente" = por
// atender, "cerrado" = ya resuelto pero sin borrar la conversación —
// distinto del botón "Cerrar chat", que sí borra todo).
ensureColumn("support_chats", "tag", "tag TEXT NOT NULL DEFAULT 'pendiente'");

// type: "text" | "image" | "video". media_url/media_public_id quedan vacíos
// una vez que el archivo se autodestruye (1 día, ver expiry-chat-media.job.ts)
// — el mensaje se queda como marcador de que hubo una foto/video ahí.
db.exec(`
  CREATE TABLE IF NOT EXISTS support_chat_messages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id          INTEGER NOT NULL,
    sender           TEXT    NOT NULL,
    type             TEXT    NOT NULL DEFAULT 'text',
    text             TEXT    NOT NULL DEFAULT '',
    media_url        TEXT    NOT NULL DEFAULT '',
    media_public_id  TEXT    NOT NULL DEFAULT '',
    media_resource_type TEXT NOT NULL DEFAULT '',
    media_expires_at TEXT,
    media_expired     INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_support_chat_messages_chat ON support_chat_messages(chat_id)`);

console.log("🗄️  SQLite inicializado:", DB_PATH);
