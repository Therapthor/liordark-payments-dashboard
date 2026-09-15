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
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, slot_number)
);
CREATE INDEX IF NOT EXISTS idx_access_profiles_account ON access_profiles(account_id);
CREATE INDEX IF NOT EXISTS idx_access_profiles_phone   ON access_profiles(client_phone);
