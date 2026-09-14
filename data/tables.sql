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
