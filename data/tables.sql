-- ═══════════════════════════════════════════════════════════════════
-- ESQUEMA — liordark-payments-dashboard
-- Se ejecuta automáticamente al iniciar (CREATE TABLE IF NOT EXISTS,
-- idempotente en cada arranque).
-- ═══════════════════════════════════════════════════════════════════

-- Espejo permanente de yape_payments del bot. El bot borra pagos de
-- más de 7 días — acá se guardan para siempre (o hasta que el usuario
-- los borre), para poder armar el historial mensual/anual.
CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY,
  sender_name   TEXT    NOT NULL,
  amount        TEXT    NOT NULL,
  security_code TEXT    NOT NULL DEFAULT '',
  has_code      INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'pending',
  order_name    TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL, -- ISO 8601 UTC, tal como lo manda el bot
  received_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);
CREATE INDEX IF NOT EXISTS idx_payments_status  ON payments(status);

-- Entradas manuales para días sin datos automáticos (antes de que
-- existiera este panel, o días donde falló la sincronización).
CREATE TABLE IF NOT EXISTS manual_ledger (
  date        TEXT PRIMARY KEY, -- YYYY-MM-DD (hora Lima)
  amount      REAL NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bookkeeping simple de la sincronización con el bot (para diagnóstico).
CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Historial de totales por mes (YYYY-MM) — se recalcula y se actualiza
-- solo cada vez que se consulta un mes (nunca queda "congelado" mal si
-- se corrige un dato viejo), pero queda guardado para no recalcular
-- desde cero cada vez y para poder listar meses pasados más adelante.
CREATE TABLE IF NOT EXISTS monthly_totals (
  month       TEXT PRIMARY KEY, -- YYYY-MM (hora Lima)
  total       REAL NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Historial permanente de órdenes aprobadas (el bot no las guarda una
-- vez entregadas — acá quedan para siempre). Mismo texto exacto que ya
-- se manda al canal "confirmadas" de Telegram.
CREATE TABLE IF NOT EXISTS orders_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_log_created ON orders_log(created_at);

-- ═══════════════════════════════════════════════════════════════════
-- PANEL ACCESOS — cuentas y perfiles de clientes.
--
-- Vive solo acá, independiente de Google Sheets y del bot, mientras
-- se prepara el traspaso. Una cuenta (ej. un correo de NETFLIX) tiene
-- N perfiles (5 si la plataforma usa perfiles, 1 si es cuenta única
-- como CANVA/CAPCUT PRO). El vencimiento es UNO solo por cuenta,
-- compartido por todos los clientes que tiene asignados — se renueva
-- la cuenta entera, no cada cliente por separado.
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS access_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  platform      TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  password      TEXT    NOT NULL,
  provider      TEXT    NOT NULL DEFAULT '',  -- proveedor — de quién se compró la cuenta
  has_profiles  INTEGER NOT NULL DEFAULT 1,   -- 0 = cuenta única (1 solo cliente, sin perfiles)
  expires_at    TEXT,                         -- YYYY-MM-DD, vencimiento compartido por la cuenta
  link          TEXT    NOT NULL DEFAULT '',  -- enlace opcional (info que se llena a mano), botón "Abrir enlace"
  notes         TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_access_accounts_platform ON access_accounts(platform);
CREATE INDEX IF NOT EXISTS idx_access_accounts_email    ON access_accounts(email);

CREATE TABLE IF NOT EXISTS access_profiles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES access_accounts(id) ON DELETE CASCADE,
  slot_number   INTEGER NOT NULL,
  profile_name  TEXT    NOT NULL DEFAULT '',
  client_phone  TEXT    NOT NULL DEFAULT '',  -- vacío = perfil libre
  renewal_status TEXT   NOT NULL DEFAULT '',  -- '' = sin marcar, 'yes' = renueva, 'no' = no renueva
  order_ref     TEXT    NOT NULL DEFAULT '',  -- código de orden del bot que compró este perfil (rastreo)
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, slot_number)
);
CREATE INDEX IF NOT EXISTS idx_access_profiles_account ON access_profiles(account_id);
CREATE INDEX IF NOT EXISTS idx_access_profiles_phone   ON access_profiles(client_phone);

-- Historial de cuentas vencidas — cuando una cuenta de access_accounts
-- vence (expires_at < hoy), se copia acá completa (con sus perfiles como
-- snapshot en JSON, tal como estaban al momento de archivarse) y se borra
-- de access_accounts/access_profiles. Es de solo lectura desde el panel —
-- existe para poder resolver reclamos de clientes viejos, no para operar.
CREATE TABLE IF NOT EXISTS access_accounts_history (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  original_account_id INTEGER NOT NULL,
  platform           TEXT    NOT NULL,
  email              TEXT    NOT NULL,
  password           TEXT    NOT NULL,
  provider           TEXT    NOT NULL DEFAULT '',
  has_profiles       INTEGER NOT NULL DEFAULT 1,
  expires_at         TEXT,
  link               TEXT    NOT NULL DEFAULT '',
  notes              TEXT    NOT NULL DEFAULT '',
  profiles_json      TEXT    NOT NULL DEFAULT '[]', -- snapshot de access_profiles al momento de vencer
  archived_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_access_history_platform ON access_accounts_history(platform);
CREATE INDEX IF NOT EXISTS idx_access_history_email    ON access_accounts_history(email);

-- Bitácora de pedidos (reemplaza PEDIDOS_PENDIENTES de Sheets, que ya
-- llegó a su límite de filas). Registro puro para seguimiento del admin —
-- no decide si el cliente recibe su cuenta o no, eso ya lo maneja
-- access_accounts/access_profiles. order_name es la clave natural, igual
-- que el código de orden que ya usa el bot.
CREATE TABLE IF NOT EXISTS pending_orders_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_name        TEXT    NOT NULL UNIQUE,
  phone             TEXT    NOT NULL,
  platform          TEXT    NOT NULL,
  order_type        TEXT    NOT NULL DEFAULT '', -- 'Compra' | 'Renovación' | 'Compra sin stock'
  payment_confirmed INTEGER NOT NULL DEFAULT 0,
  assigned          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pending_orders_order_name ON pending_orders_log(order_name);

-- Catálogo propio del panel (Configuración > Catálogo). Alimenta el
-- desplegable de plataforma en Accesos. NO está conectado al bot/WhatsApp
-- todavía — es un catálogo aparte hasta que se decida migrar esa fuente.
CREATE TABLE IF NOT EXISTS catalog_products (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  platform     TEXT    NOT NULL,
  title        TEXT    NOT NULL DEFAULT '',
  price        TEXT    NOT NULL DEFAULT '0',
  has_profiles INTEGER NOT NULL DEFAULT 1,
  description  TEXT    NOT NULL DEFAULT '',
  image_url    TEXT    NOT NULL DEFAULT '',
  keywords     TEXT    NOT NULL DEFAULT '', -- separadas por coma — para que el bot reconozca "quiero netflix 4k"
  active       INTEGER NOT NULL DEFAULT 1,  -- apagado = no sale más en el desplegable de Accesos
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Combos (Configuración > Catálogo > Combos) — un combo agrupa perfiles de
-- VARIAS plataformas distintas bajo un solo pago (ej. 1 Netflix + 1 Spotify
-- + 1 Crunchyroll), no varios perfiles repetidos de una misma plataforma.
-- Todavía NO está conectado al flujo de WhatsApp — se prepara para cuando
-- el catálogo se traspase al panel y la entrega pueda ser inmediata.
CREATE TABLE IF NOT EXISTS catalog_combos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  price        TEXT    NOT NULL DEFAULT '0',
  description  TEXT    NOT NULL DEFAULT '',
  image_url    TEXT    NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Cada fila es una plataforma dentro de un combo (ej. combo #3 → "NETFLIX"
-- x1, "SPOTIFY" x1, "CRUNCHYROLL" x1). quantity casi siempre es 1, pero se
-- deja libre por si algún combo repite perfiles de una misma plataforma.
CREATE TABLE IF NOT EXISTS catalog_combo_items (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  combo_id  INTEGER NOT NULL,
  platform  TEXT    NOT NULL,
  quantity  INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_combo_items_combo ON catalog_combo_items(combo_id);

-- Métodos de pago (Configuración > Métodos de pago). Por ahora solo se usa
-- como referencia/lista propia del panel — no está conectado al selector
-- de método de pago que ya usa el bot en WhatsApp.
CREATE TABLE IF NOT EXISTS payment_methods (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  image_url    TEXT    NOT NULL DEFAULT '', -- ej. QR de Yape
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Proveedores (Configuración > Proveedores). Alimenta el desplegable de
-- "Proveedor" al crear/editar cuentas en Accesos, y el botón 🔑 de soporte
-- (abre WhatsApp al proveedor de esa cuenta).
CREATE TABLE IF NOT EXISTS providers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  whatsapp     TEXT    NOT NULL DEFAULT '',
  notes        TEXT    NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
