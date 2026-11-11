import { db } from "./db";

// ─────────────────────────────────────────────────────────────
// SALDO DE MAYORISTAS — wholesalers.balance_cents es la lectura rápida;
// wholesaler_credit_ledger es la fuente de verdad para auditoría (plata
// real). Todo movimiento de saldo pasa por applyWholesalerCreditChange,
// que actualiza ambos a la vez dentro de una sola transacción — ningún
// otro código escribe balance_cents directamente.
// ─────────────────────────────────────────────────────────────

export type LedgerEntryType =
  | "topup_yape"
  | "topup_manual_admin"
  | "debit_manual_admin"
  | "purchase_profile"
  | "purchase_full_account"
  | "renewal"
  | "wipe_inactive"
  | "gift_course";

export type CreditChangeResult =
  | { ok: true; newBalanceCents: number }
  | { ok: false; error: string };

const applyChange = db.transaction((
  wholesalerId: number,
  amountCents: number,
  type: LedgerEntryType,
  reference: string,
  createdBy: string
): CreditChangeResult => {
  const row = db.prepare(`SELECT balance_cents FROM wholesalers WHERE id = ?`)
    .get(wholesalerId) as { balance_cents: number } | undefined;
  if (!row) return { ok: false, error: "Mayorista no encontrado." };

  const newBalance = row.balance_cents + amountCents;
  if (newBalance < 0) return { ok: false, error: "Saldo insuficiente." };

  db.prepare(`UPDATE wholesalers SET balance_cents = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(newBalance, wholesalerId);
  db.prepare(`
    INSERT INTO wholesaler_credit_ledger (wholesaler_id, type, amount_cents, balance_after_cents, reference, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(wholesalerId, type, amountCents, newBalance, reference, createdBy);

  return { ok: true, newBalanceCents: newBalance };
});

/**
 * Único punto de escritura de saldo — positivo suma, negativo resta.
 * Si restar dejaría el saldo en negativo, no toca nada y devuelve el error
 * (nunca saldo negativo). Idempotencia de recargas por Yape: ver
 * creditWasAlreadyApplied, que se chequea ANTES de llamar a esto.
 */
export function applyWholesalerCreditChange(
  wholesalerId: number,
  amountCents: number,
  type: LedgerEntryType,
  reference: string,
  createdBy: string
): CreditChangeResult {
  return applyChange(wholesalerId, amountCents, type, reference, createdBy);
}

/** Para no acreditar dos veces la misma recarga Yape si el bot reintenta la llamada. */
export function creditWasAlreadyApplied(type: LedgerEntryType, reference: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM wholesaler_credit_ledger WHERE type = ? AND reference = ? LIMIT 1
  `).get(type, reference);
  return !!row;
}

/** ¿Ya hubo un movimiento así hace un momento? — evita cobrar dos veces
 *  la misma renovación por un doble clic o dos pestañas abiertas. */
export function hasRecentLedgerEntry(
  wholesalerId: number, type: LedgerEntryType, referencePrefix: string, seconds: number
): boolean {
  const row = db.prepare(`
    SELECT 1 FROM wholesaler_credit_ledger
    WHERE wholesaler_id = ? AND type = ? AND substr(reference, 1, ?) = ?
      AND created_at >= datetime('now', ?)
    LIMIT 1
  `).get(wholesalerId, type, referencePrefix.length, referencePrefix, `-${Math.max(1, Math.round(seconds))} seconds`);
  return !!row;
}

export type LedgerEntry = {
  id:                number;
  wholesalerId:      number;
  type:              LedgerEntryType;
  amountCents:        number;
  balanceAfterCents:  number;
  reference:          string;
  createdBy:          string;
  createdAt:          string;
};

function toLedgerEntry(row: any): LedgerEntry {
  return {
    id:                row.id,
    wholesalerId:      row.wholesaler_id,
    type:              row.type,
    amountCents:        row.amount_cents,
    balanceAfterCents:  row.balance_after_cents,
    reference:          row.reference,
    createdBy:          row.created_by,
    createdAt:          row.created_at,
  };
}

export function listLedgerForWholesaler(wholesalerId: number, limit = 100): LedgerEntry[] {
  const rows = db.prepare(`
    SELECT * FROM wholesaler_credit_ledger WHERE wholesaler_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(wholesalerId, limit);
  return rows.map(toLedgerEntry);
}
