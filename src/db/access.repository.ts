import { randomInt } from "crypto";
import { db } from "./db";
import { normalizePeruPhone } from "../utils/phone.util";
import { createCustomerNotification } from "./customer-notifications.repository";
import { createWholesalerNotification } from "./wholesaler-notifications.repository";
import { createManualOverride, deleteManualOverride, findManualOverride, listManualOverridesForClient } from "./manual-overrides.repository";
import { isBrainPlatform, isRotatePlatform, setNewClientDate, recordBrainSale, brainPlatforms } from "./brain-platforms";

// ─────────────────────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────────────────────

export type RenewalStatus = "" | "yes" | "no";

export type AccessProfile = {
  id:            number;
  accountId:     number;
  slotNumber:    number;
  profileName:   string;
  clientPhone:   string;
  renewalStatus: RenewalStatus;
  orderRef:      string;
  // null = stock normal de clientitos; si no, es de este mayorista (ver
  // assignProfilesToWholesaler) — el panel admin lo necesita para no
  // dejar vender como retail lo que ya es stock de un mayorista.
  wholesalerId:  number | null;
  updatedAt:     string;
  // Cerebro: fecha propia del cliente (null = la de la cuenta), plan que
  // compró (meses), PIN del perfil y si hay que ponerle uno nuevo.
  clientExpiresAt: string | null;
  planMonths:      number | null;
  pin:             string;
  pinResetPending: boolean;
  movedAt:         string | null;
};

export type AccessAccount = {
  id:          number;
  platform:    string;
  email:       string;
  password:    string;
  provider:    string;
  hasProfiles: boolean;
  expiresAt:   string | null;
  link:        string;
  notes:       string;
  // Renovación con el proveedor — independiente del vencimiento del
  // cliente. Se paga/renueva mes a mes aunque se venda como plan anual.
  providerRenewalEnabled:  boolean;
  providerRenewalCost:     string;
  providerRenewalCurrency: string;
  providerRenewalNextDate: string | null;
  // Renovación manual en dos pasos (Accesos > Renovar) — fecha en que se
  // presionó "Renovar", pendiente de que el cliente pague. null = no hay
  // renovación pendiente para esta cuenta.
  renewalPendingAt: string | null;
  // "🔑 Código" — si esta cuenta puede recibir código (Netflix, ChatGPT,
  // etc.) para que el cliente lo pida desde liordark.com. Ver codes.repository.ts.
  codesEnabled: boolean;
  codesUnfiltered: boolean;     // el mayorista ve todos los códigos (sin filtros)
  codeSource:   string | null;
  totpSecret:   string | null;
  codeInboxUrl: string;         // link privado de la bandeja del proveedor (solo admin)
  // Corte automático del ciclo — ver runRenewalCutover en access.service.ts.
  renewalCleanupDueAt:   string | null;
  passwordChangePending: boolean;
  createdAt:   string;
  updatedAt:   string;
  // Cerebro (ver services/brain.service.ts).
  pinMode:        boolean;
  salePaused:     boolean;
  brainAction:    "" | "renew" | "drop";
  brainActionFor: string | null;
};

export type AccessAccountWithProfiles = AccessAccount & { profiles: AccessProfile[] };

export type PlatformSummary = {
  platform:      string;
  accountCount:  number;
  profileCount:  number;
  occupiedCount: number;
  sellableCount: number; // libres Y con al menos MIN_SELLABLE_DAYS por delante — lo que de verdad se le puede vender a un cliente nuevo
};

// Regla del negocio: nunca vender un perfil cuya cuenta vaya a vencer en
// menos de 28 días — si no, el cliente reclama que no le llegó el mes
// completo. Aplica tanto a la venta real (sellProfile) como al conteo de
// "disponibles" que ve el admin y el catálogo del bot, para que ambos
// digan siempre lo mismo.
const MIN_SELLABLE_DAYS = 28;

function minSellableDateISO(): string {
  return addDaysISOLocal(limaTodayISOLocal(), MIN_SELLABLE_DAYS);
}

// ─────────────────────────────────────────────────────────────
// CUENTAS
// ─────────────────────────────────────────────────────────────

function slotsFor(hasProfiles: boolean): number {
  return hasProfiles ? 5 : 1;
}

export function createAccount(params: {
  platform:    string;
  email:       string;
  password:    string;
  provider?:   string;
  hasProfiles: boolean;
  expiresAt?:  string | null;
  notes?:      string;
}): AccessAccountWithProfiles {
  return createAccountsBulk({
    platform:    params.platform,
    provider:    params.provider ?? "",
    hasProfiles: params.hasProfiles,
    expiresAt:   params.expiresAt ?? null,
    pairs:       [{ email: params.email, password: params.password }],
  })[0]!;
}

/** Una línea de "+ Agregar cuentas" ya separada: link de bandeja (fuentes
 *  de bandeja) o clave 2FA ya validada (fuente 2FA), según el código elegido. */
export type BulkAccountPair = { email: string; password: string; inboxUrl?: string; totpSecret?: string };

/** Crea varias cuentas de una — formato "correo:contraseña" ya parseado en pares. */
export function createAccountsBulk(params: {
  platform:    string;
  provider:    string;
  hasProfiles: boolean;
  expiresAt:   string | null;
  pairs:       BulkAccountPair[];
  providerRenewalEnabled?:  boolean;
  providerRenewalCost?:     string;
  providerRenewalCurrency?: string;
  providerRenewalNextDate?: string | null;
  codeSource?:              string | null; // de dónde sacar el código (null = sin código)
}): AccessAccountWithProfiles[] {
  const slots = slotsFor(params.hasProfiles);

  const insertAccount = db.prepare(`
    INSERT INTO access_accounts (
      platform, email, password, provider, has_profiles, expires_at,
      provider_renewal_enabled, provider_renewal_cost, provider_renewal_currency, provider_renewal_next_date,
      codes_enabled, code_source, code_inbox_url, totp_secret
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertProfile = db.prepare(`
    INSERT INTO access_profiles (account_id, slot_number, profile_name)
    VALUES (?, ?, ?)
  `);

  const ids = db.transaction(() => {
    const created: number[] = [];
    for (const pair of params.pairs) {
      const result = insertAccount.run(
        params.platform.trim().toUpperCase(),
        pair.email.trim(),
        pair.password.trim(),
        params.provider.trim(),
        params.hasProfiles ? 1 : 0,
        params.expiresAt,
        params.providerRenewalEnabled ? 1 : 0,
        params.providerRenewalCost ?? "",
        params.providerRenewalCurrency || "USDT",
        params.providerRenewalEnabled ? (params.providerRenewalNextDate ?? null) : null,
        params.codeSource ? 1 : 0,
        params.codeSource ?? null,
        params.codeSource ? (pair.inboxUrl ?? "") : "",
        params.codeSource ? (pair.totpSecret ?? null) : null
      );
      const id = result.lastInsertRowid as number;
      for (let slot = 1; slot <= slots; slot++) {
        insertProfile.run(id, slot, slots === 1 ? "" : "Perfil " + slot);
      }
      created.push(id);
    }
    return created;
  })();

  return ids.map(id => getAccountById(id)!);
}

export function updateAccount(id: number, params: {
  platform?:  string;
  email?:     string;
  password?:  string;
  provider?:  string;
  expiresAt?: string | null;
  link?:      string;
  notes?:     string;
  providerRenewalEnabled?:  boolean;
  providerRenewalCost?:     string;
  providerRenewalCurrency?: string;
  providerRenewalNextDate?: string | null;
}): AccessAccountWithProfiles | null {
  const current = getAccountById(id);
  if (!current) return null;

  const renewalEnabled = params.providerRenewalEnabled ?? current.providerRenewalEnabled;

  db.prepare(`
    UPDATE access_accounts
    SET platform = ?, email = ?, password = ?, provider = ?, expires_at = ?, link = ?, notes = ?,
        provider_renewal_enabled = ?, provider_renewal_cost = ?, provider_renewal_currency = ?, provider_renewal_next_date = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    (params.platform ?? current.platform).trim().toUpperCase(),
    (params.email ?? current.email).trim(),
    params.password ?? current.password,
    (params.provider ?? current.provider).trim(),
    params.expiresAt !== undefined ? params.expiresAt : current.expiresAt,
    (params.link ?? current.link).trim(),
    (params.notes ?? current.notes).trim(),
    renewalEnabled ? 1 : 0,
    (params.providerRenewalCost ?? current.providerRenewalCost).trim(),
    params.providerRenewalCurrency || current.providerRenewalCurrency || "USDT",
    renewalEnabled
      ? (params.providerRenewalNextDate !== undefined ? params.providerRenewalNextDate : current.providerRenewalNextDate)
      : null,
    id
  );

  return getAccountById(id);
}

/** Cuentas marcadas para recordatorio de renovación con el proveedor (Pagos > Renovaciones). */
export function listProviderRenewalAccounts(): AccessAccount[] {
  return (db.prepare(`
    SELECT * FROM access_accounts WHERE provider_renewal_enabled = 1 ORDER BY provider_renewal_next_date ASC
  `).all() as any[]).map(toAccount);
}

/** Adelanta un mes la fecha de renovación con el proveedor (se llama al marcar "ya renové"). */
export function markProviderRenewalRenewed(id: number): AccessAccount | null {
  const current = getAccountById(id);
  if (!current || !current.providerRenewalNextDate) return null;
  db.prepare(`
    UPDATE access_accounts SET provider_renewal_next_date = ?, updated_at = datetime('now') WHERE id = ?
  `).run(addOneMonth(current.providerRenewalNextDate), id);
  return getAccountById(id);
}

function addOneMonth(dateISO: string): string {
  const [y, m, d] = dateISO.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1 + 1, d));
  return dt.toISOString().slice(0, 10);
}

/** «⧉ Duplicar»: otra cuenta igual (correo, contraseña, proveedor, fecha,
 *  «🔑 Código», link y notas) con todos sus perfiles libres. hasProfiles
 *  viene del catálogo, así una cuenta ya vendida como completa se duplica
 *  como stock normal. */
export function duplicateAccount(id: number, hasProfiles: boolean): AccessAccountWithProfiles | null {
  const src = getAccountById(id);
  if (!src) return null;
  const [copy] = createAccountsBulk({
    platform: src.platform, provider: src.provider, hasProfiles,
    expiresAt: src.expiresAt,
    pairs: [{ email: src.email, password: src.password }],
    providerRenewalEnabled:  src.providerRenewalEnabled,
    providerRenewalCost:     src.providerRenewalCost,
    providerRenewalCurrency: src.providerRenewalCurrency,
    providerRenewalNextDate: src.providerRenewalNextDate,
  });
  db.prepare(`
    UPDATE access_accounts
    SET (link, notes, plan_months, codes_enabled, codes_unfiltered, code_source, totp_secret, code_inbox_url) =
        (SELECT link, notes, plan_months, codes_enabled, codes_unfiltered, code_source, totp_secret, code_inbox_url
         FROM access_accounts WHERE id = ?)
    WHERE id = ?
  `).run(id, copy!.id);
  return getAccountById(copy!.id);
}

export function setAccountExpiry(id: number, expiresAt: string): AccessAccountWithProfiles | null {
  db.prepare(`
    UPDATE access_accounts SET expires_at = ?, updated_at = datetime('now') WHERE id = ?
  `).run(expiresAt, id);
  return getAccountById(id);
}

export function deleteAccount(id: number): void {
  db.prepare(`DELETE FROM access_accounts WHERE id = ?`).run(id);
}

// ── Renovación manual en dos pasos (Accesos > Renovar) ──

export function setRenewalPending(id: number, pending: boolean): AccessAccountWithProfiles | null {
  db.prepare(`
    UPDATE access_accounts SET renewal_pending_at = ?, updated_at = datetime('now') WHERE id = ?
  `).run(pending ? new Date().toISOString() : null, id);
  return getAccountById(id);
}

export function getAccountById(id: number): AccessAccountWithProfiles | null {
  const row = db.prepare(`SELECT * FROM access_accounts WHERE id = ?`).get(id) as any;
  if (!row) return null;
  return { ...toAccount(row), profiles: getProfilesByAccount(id) };
}

export function listPlatforms(): PlatformSummary[] {
  const floor = minSellableDateISO();
  const tomorrow = addDaysISOLocal(limaTodayISOLocal(), 1);
  // Mismo criterio que la venta (ver pickFreeProfile): en los perfiles del
  // cerebro cuenta todo perfil libre de una cuenta viva mañana que no se va
  // a dejar vencer y no espera PIN nuevo.
  const rows = db.prepare(`
    SELECT
      a.platform AS platform,
      COUNT(DISTINCT a.id) AS accountCount,
      COUNT(p.id) AS profileCount,
      SUM(CASE WHEN p.client_phone != '' THEN 1 ELSE 0 END) AS occupiedCount,
      SUM(CASE WHEN p.client_phone = '' AND p.wholesaler_id IS NULL AND a.brain_action != 'drop' AND a.sale_paused = 0
               AND a.expires_at IS NOT NULL AND a.expires_at >= @floor THEN 1 ELSE 0 END) AS sellableCount,
      SUM(CASE WHEN p.client_phone = '' AND p.wholesaler_id IS NULL AND a.brain_action != 'drop' AND a.sale_paused = 0
               AND a.has_profiles = 1 AND a.expires_at IS NOT NULL AND a.expires_at >= @tomorrow THEN 1 ELSE 0 END) AS brainSellable,
      SUM(CASE WHEN p.client_phone = '' AND p.wholesaler_id IS NULL AND a.brain_action != 'drop' AND a.sale_paused = 0
               AND a.expires_at IS NOT NULL AND a.expires_at >= @tomorrow THEN 1 ELSE 0 END) AS rotateSellable
    FROM access_accounts a
    LEFT JOIN access_profiles p ON p.account_id = a.id
    GROUP BY a.platform
    ORDER BY a.platform ASC
  `).all({ floor, tomorrow }) as (PlatformSummary & { brainSellable: number; rotateSellable: number })[];
  return rows.map(({ brainSellable, rotateSellable, ...r }) => ({
    ...r,
    sellableCount: isRotatePlatform(r.platform) ? (rotateSellable ?? 0)
      : isBrainPlatform(r.platform) ? (brainSellable ?? 0) : (r.sellableCount ?? 0),
  }));
}

export function listAccountsByPlatform(platform: string): AccessAccountWithProfiles[] {
  // id como desempate: las cuentas importadas de una vez comparten el mismo
  // created_at exacto, así que sin esto el orden entre ellas queda
  // indefinido. El id sí refleja el orden real en que se agregaron.
  const rows = db.prepare(`
    SELECT * FROM access_accounts WHERE platform = ? ORDER BY created_at DESC, id DESC
  `).all(platform.trim().toUpperCase()) as any[];

  return rows.map(row => ({ ...toAccount(row), profiles: getProfilesByAccount(row.id) }));
}

// ─────────────────────────────────────────────────────────────
// PERFILES
// ─────────────────────────────────────────────────────────────

export function getProfilesByAccount(accountId: number): AccessProfile[] {
  return (db.prepare(`
    SELECT * FROM access_profiles WHERE account_id = ? ORDER BY slot_number ASC
  `).all(accountId) as any[]).map(toProfile);
}

export function getProfileById(id: number): AccessProfile | null {
  const row = db.prepare(`SELECT * FROM access_profiles WHERE id = ?`).get(id) as any;
  return row ? toProfile(row) : null;
}

export type SubscriberProfile = AccessProfile & { expiresAt: string | null };

/** Clientes de la cuenta (perfiles ocupados) con su fecha de vencimiento
 *  real: la propia del perfil (expires_override, ver replaceClientAccount)
 *  si la tiene; si no, la de la cuenta. */
export function listAccountSubscribers(accountId: number): SubscriberProfile[] {
  return (db.prepare(`
    SELECT p.*, COALESCE(p.expires_override, a.expires_at) AS effective_expires_at
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE p.account_id = ? AND p.client_phone != ''
    ORDER BY p.slot_number ASC
  `).all(accountId) as any[]).map(row => ({ ...toProfile(row), expiresAt: row.effective_expires_at ?? null }));
}

export function assignProfileClient(id: number, clientPhone: string): AccessProfile | null {
  const result = db.prepare(`
    UPDATE access_profiles SET client_phone = ?, updated_at = datetime('now') WHERE id = ?
  `).run(normalizePeruPhone(clientPhone), id);
  if (result.changes === 0) return null;
  return getProfileById(id);
}

/** Cuentas de un solo lugar cuyo cliente tiene su fecha guardada aparte
 *  (reemplazos de antes): la fecha pasa a la cuenta. Idempotente. */
export function syncSingleSlotExpiry(): number {
  // En las plataformas del cerebro el cliente guarda SU fecha aparte (la de
  // la cuenta es la del proveedor): ahí no se toca.
  const rows = (db.prepare(`
    SELECT a.id AS accountId, a.platform AS platform, p.id AS profileId, p.expires_override AS date
    FROM access_accounts a JOIN access_profiles p ON p.account_id = a.id
    WHERE a.has_profiles = 0 AND p.client_phone != '' AND p.expires_override IS NOT NULL
  `).all() as { accountId: number; platform: string; profileId: number; date: string }[]).filter(r => !isBrainPlatform(r.platform));
  db.transaction(() => {
    for (const r of rows) {
      db.prepare(`UPDATE access_accounts SET expires_at = ?, updated_at = datetime('now') WHERE id = ?`).run(r.date, r.accountId);
      db.prepare(`UPDATE access_profiles SET expires_override = NULL WHERE id = ?`).run(r.profileId);
    }
  })();
  return rows.length;
}

/** ⏸ / ▶ Venta de una cuenta (ver access_accounts.sale_paused). */
export function setAccountSalePaused(accountId: number, paused: boolean): boolean {
  return db.prepare(`UPDATE access_accounts SET sale_paused = ?, updated_at = datetime('now') WHERE id = ?`).run(paused ? 1 : 0, accountId).changes > 0;
}

/** «🔒 Perfiles con PIN» de una cuenta. */
export function setAccountPinMode(accountId: number, on: boolean): void {
  db.prepare(`UPDATE access_accounts SET pin_mode = ?, updated_at = datetime('now') WHERE id = ?`).run(on ? 1 : 0, accountId);
  if (!on) db.prepare(`UPDATE access_profiles SET pin_reset_pending = 0 WHERE account_id = ?`).run(accountId);
}

/** PIN del perfil (vacío = sin PIN). Poner uno quita el «PIN por cambiar».
 *  Si el perfil tiene cliente y el PIN cambió, se le avisa por su campanita. */
export function setProfilePin(profileId: number, pin: string): AccessProfile | null {
  const before = getProfileById(profileId);
  const r = db.prepare(`UPDATE access_profiles SET pin = ?, pin_reset_pending = 0, updated_at = datetime('now') WHERE id = ?`).run(pin, profileId);
  if (!r.changes) return null;
  if (before && pin && before.pin !== pin) notifyPinChanged(before, pin);
  return getProfileById(profileId);
}

// ─── PIN de todos los perfiles de una cuenta (Accesos › 🔢 / 🎲) ───

/** Prime Video pide PIN de 5 números; las demás, 4 (se aceptan 4 a 6 a mano). */
export function pinLengthFor(platform: string): number {
  return /amazon|prime/i.test(platform) ? 5 : 4;
}

export function validPinFor(platform: string, pin: string): boolean {
  return pinLengthFor(platform) === 5 ? /^\d{5}$/.test(pin) : /^\d{4,6}$/.test(pin);
}

/** PIN al azar de `len` números: sin todos iguales (1111) ni seguidos
 *  (1234 / 4321), y distinto de los que ya se usan en la cuenta. */
export function randomPin(len: number, taken: Set<string>): string {
  for (let i = 0; i < 500; i++) {
    const pin = Array.from({ length: len }, () => String(randomInt(10))).join("");
    const d = pin.split("").map(Number);
    const same = d.every(x => x === d[0]);
    const up = d.every((x, k) => k === 0 || x === d[k - 1]! + 1);
    const down = d.every((x, k) => k === 0 || x === d[k - 1]! - 1);
    if (!same && !up && !down && !taken.has(pin)) return pin;
  }
  return Array.from({ length: len }, () => String(randomInt(10))).join("");
}

/** Pone varios PIN a la vez (prende «Perfiles con PIN» en la cuenta) y avisa
 *  a los clientes cuyo PIN cambió. Devuelve los perfiles con su PIN. */
export function setAccountPins(accountId: number, entries: { profileId: number; pin: string }[]): AccessProfile[] {
  const befores = new Map(entries.map(e => [e.profileId, getProfileById(e.profileId)]));
  db.transaction(() => {
    db.prepare(`UPDATE access_accounts SET pin_mode = 1, updated_at = datetime('now') WHERE id = ?`).run(accountId);
    const up = db.prepare(`UPDATE access_profiles SET pin = ?, pin_reset_pending = 0, updated_at = datetime('now') WHERE id = ? AND account_id = ?`);
    for (const e of entries) up.run(e.pin, e.profileId, accountId);
  })();
  for (const e of entries) {
    const before = befores.get(e.profileId);
    if (before && before.pin !== e.pin) notifyPinChanged(before, e.pin);
  }
  return (db.prepare(`SELECT id FROM access_profiles WHERE account_id = ? ORDER BY slot_number ASC`).all(accountId) as { id: number }[])
    .map(r => getProfileById(r.id)!).filter(Boolean);
}

/** «Tu perfil X de Plataforma tiene PIN nuevo: 1234» — solo si tiene cliente
 *  y la cuenta usa PIN. */
function notifyPinChanged(profile: AccessProfile, pin: string): void {
  const acc = db.prepare(`SELECT platform, email, pin_mode FROM access_accounts WHERE id = ?`).get(profile.accountId) as { platform: string; email: string; pin_mode: number } | undefined;
  if (!acc || acc.pin_mode !== 1) return;
  const name = profile.profileName || ("Perfil " + profile.slotNumber);
  const title = (db.prepare(`SELECT title FROM catalog_products WHERE UPPER(TRIM(platform)) = UPPER(TRIM(?)) AND active = 1 LIMIT 1`).get(acc.platform) as { title: string } | undefined)?.title || acc.platform;
  const msg = `🔐 Tu perfil «${name}» de ${title} tiene PIN nuevo: ${pin}`;
  if (!profile.clientPhone) return; // libre o stock mayorista sin vender
  if (profile.wholesalerId != null) createWholesalerNotification(profile.wholesalerId, "support_update", acc.platform, acc.email, msg);
  else createCustomerNotification(profile.clientPhone, "support_update", acc.platform, acc.email, msg);
}

/** «Dejar igual»: el admin decide no cambiar el PIN de un perfil que se liberó. */
export function dismissPinReminder(profileId: number): AccessProfile | null {
  const r = db.prepare(`UPDATE access_profiles SET pin_reset_pending = 0, updated_at = datetime('now') WHERE id = ?`).run(profileId);
  return r.changes ? getProfileById(profileId) : null;
}

/** Fecha exacta del cliente (corrección a mano del admin). */
export function setClientDate(profileId: number, dateISO: string): void {
  db.prepare(`UPDATE access_profiles SET expires_override = ?, updated_at = datetime('now') WHERE id = ?`).run(dateISO, profileId);
}

export function releaseProfile(id: number): AccessProfile | null {
  // expires_override también se limpia: si no, un cliente nuevo que caiga
  // en este mismo slot heredaría la fecha congelada del cliente anterior.
  // Cuenta con PIN: quien se va conoce el PIN de ese perfil → queda el aviso
  // «¿cambiar PIN?» (pin_reset_pending). No bloquea la venta: decide el admin.
  const result = db.prepare(`
    UPDATE access_profiles SET client_phone = '', renewal_status = '', order_ref = '', expires_override = NULL,
      plan_months = NULL, moved_at = NULL,
      pin_reset_pending = CASE WHEN client_phone != '' AND (SELECT pin_mode FROM access_accounts WHERE id = access_profiles.account_id) = 1 THEN 1 ELSE pin_reset_pending END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
  if (result.changes === 0) return null;
  return getProfileById(id);
}

/** Marca si el cliente de un perfil confirmó que renueva o no (o lo deja sin marcar). */
export function setProfileRenewal(id: number, status: RenewalStatus): AccessProfile | null {
  const result = db.prepare(`
    UPDATE access_profiles SET renewal_status = ?, updated_at = datetime('now') WHERE id = ?
  `).run(status, id);
  if (result.changes === 0) return null;
  return getProfileById(id);
}

/** Limpia los marcadores de renovación de una cuenta — se llama al renovarla,
 *  para que cada ciclo empiece con la marca en blanco de nuevo. También
 *  limpia expires_override: si Soporte le había congelado la fecha a algún
 *  cliente de esta cuenta, una renovación normal la reemplaza por la real. */
export function resetRenewalMarkers(accountId: number): void {
  const acc = db.prepare(`SELECT platform FROM access_accounts WHERE id = ?`).get(accountId) as { platform: string } | undefined;
  // Cerebro: renovar la cuenta es pagarle al proveedor; cada cliente conserva su fecha.
  if (acc && isBrainPlatform(acc.platform)) return;
  db.prepare(`
    UPDATE access_profiles SET renewal_status = '', expiry_notified_at = NULL, expires_override = NULL,
      sms_reminder_sent_at = NULL
    WHERE account_id = ?
  `).run(accountId);
}

export type RenewingProfile = {
  profileId:   number;
  accountId:   number;
  clientPhone: string;
  platform:    string;
  platformTag: string;
  expiresAt:   string | null;
};

/** Clientes marcados "✅ Renueva" (cualquier cuenta) — para verlos todos
 *  juntos en un solo lugar en vez de abrir cuenta por cuenta en Accesos. */
export function listRenewingProfiles(): RenewingProfile[] {
  return db.prepare(`
    SELECT p.id AS profileId, a.id AS accountId, p.client_phone AS clientPhone, a.platform AS platform,
           COALESCE(c.title, '') AS platformTag, COALESCE(p.expires_override, a.expires_at) AS expiresAt
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    LEFT JOIN catalog_products c ON UPPER(TRIM(c.platform)) = a.platform
    WHERE p.renewal_status = 'yes' AND p.client_phone != '' AND p.wholesaler_id IS NULL
    ORDER BY a.expires_at ASC
  `).all() as RenewingProfile[];
}

// ─────────────────────────────────────────────────────────────
// CORTE AUTOMÁTICO DE CICLO — ver runRenewalCutover en access.service.ts.
// Los clientes se autogestionan su renovación (pagan desde liordark.com,
// eso marca su perfil "✅ Renueva"); esto es lo que de verdad extiende la
// cuenta y saca a los que no pagaron, sin que el admin tenga que entrar
// cuenta por cuenta.
// ─────────────────────────────────────────────────────────────

export type AccountWithRenewalCount = AccessAccount & { renewingCount: number; totalProfiles: number };

/** Cuentas con al menos un cliente marcado "✅ Renueva" — reemplaza el
 *  listado por PERFIL de "Renovados" (ver listRenewingProfiles arriba,
 *  que queda para otros usos): acá se ve la cuenta completa, que es la
 *  unidad real que se renueva. */
export function listAccountsWithPendingRenewal(): AccountWithRenewalCount[] {
  const rows = db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM access_profiles p WHERE p.account_id = a.id AND p.renewal_status = 'yes') AS renewingCount,
      (SELECT COUNT(*) FROM access_profiles p WHERE p.account_id = a.id AND p.client_phone != '') AS totalProfiles
    FROM access_accounts a
    WHERE a.has_profiles = 1
      AND EXISTS (SELECT 1 FROM access_profiles p WHERE p.account_id = a.id AND p.renewal_status = 'yes')
    ORDER BY a.expires_at ASC
  `).all() as any[];
  return rows.map(row => ({ ...toAccount(row), renewingCount: row.renewingCount, totalProfiles: row.totalProfiles }));
}

/** Universo del corte automático — cuentas con perfiles y fecha de vencimiento. */
export function listRenewableAccountsWithProfiles(): AccessAccountWithProfiles[] {
  // Las del cerebro se renuevan solas por cliente (ver brain.service.ts).
  const rows = (db.prepare(`
    SELECT * FROM access_accounts WHERE has_profiles = 1 AND expires_at IS NOT NULL
  `).all() as any[]).filter(r => !isBrainPlatform(r.platform));
  return rows.map(row => ({ ...toAccount(row), profiles: getProfilesByAccount(row.id) }));
}

/** Extiende la cuenta 30 días (1 día antes de vencer, ver runRenewalCutover)
 *  y anota la fecha original de vencimiento como "limpieza pendiente" —
 *  ese día hay que sacar a quien no renovó. No usa expires_at para la
 *  limpieza porque ya se movió 30 días para adelante acá mismo. */
export function applyRenewalExtension(accountId: number, newExpiresAt: string, cleanupDueAt: string): void {
  db.prepare(`
    UPDATE access_accounts SET expires_at = ?, renewal_cleanup_due_at = ?, updated_at = datetime('now') WHERE id = ?
  `).run(newExpiresAt, cleanupDueAt, accountId);
}

/** Cuentas con una limpieza de ciclo pendiente para hoy (o atrasada). */
export function listAccountsDueForRenewalCleanup(todayISO: string): AccessAccountWithProfiles[] {
  const rows = (db.prepare(`
    SELECT * FROM access_accounts WHERE renewal_cleanup_due_at IS NOT NULL AND renewal_cleanup_due_at <= ?
  `).all(todayISO) as any[]).filter(r => !isBrainPlatform(r.platform)); // el cerebro saca a cada uno por su fecha
  return rows.map(row => ({ ...toAccount(row), profiles: getProfilesByAccount(row.id) }));
}

/** Saca de la cuenta a quien no renovó — vacía su cupo (no lo borra, así
 *  queda disponible para venderlo de nuevo) y deja aviso de que hay que
 *  cambiar la contraseña si se sacó a alguien (para que no pueda volver a
 *  entrar con la contraseña vieja). */
export function applyRenewalCleanup(accountId: number): { freedCount: number } {
  const profiles = getProfilesByAccount(accountId);
  const toFree = profiles.filter(p => p.clientPhone && p.renewalStatus !== "yes");
  for (const p of toFree) releaseProfile(p.id);

  // Quien sí renovó se queda, pero su checkbox se reinicia para el ciclo
  // nuevo: si no, el próximo vencimiento se extendería solo sin que pague.
  const toReset = profiles.filter(p => p.clientPhone && p.renewalStatus === "yes");
  for (const p of toReset) setProfileRenewal(p.id, "");

  db.prepare(`UPDATE access_accounts SET renewal_cleanup_due_at = NULL WHERE id = ?`).run(accountId);
  if (toFree.length > 0) {
    db.prepare(`UPDATE access_accounts SET password_change_pending = 1, updated_at = datetime('now') WHERE id = ?`).run(accountId);
  }
  return { freedCount: toFree.length };
}

/** Cuentas a las que el admin todavía tiene que cambiarles la contraseña
 *  (se sacó a algún cliente que no renovó). */
export function listAccountsNeedingPasswordChange(): AccessAccount[] {
  return (db.prepare(`
    SELECT * FROM access_accounts WHERE password_change_pending = 1 ORDER BY updated_at DESC
  `).all() as any[]).map(toAccount);
}

export function markPasswordChanged(accountId: number): void {
  db.prepare(`UPDATE access_accounts SET password_change_pending = 0, updated_at = datetime('now') WHERE id = ?`).run(accountId);
}

// ─────────────────────────────────────────────────────────────
// STOCK — usado por la API que consume el bot de WhatsApp (venta)
//
// sellProfile es la operación crítica: tiene que ser imposible que dos
// ventas simultáneas se lleven el mismo perfil. Como better-sqlite3 es
// síncrono y Node es de un solo hilo, todo el SELECT+UPDATE corre sin
// ceder el control al event loop — no hace falta ningún lock aparte.
// ─────────────────────────────────────────────────────────────

export type SoldProfile = {
  profileId:   number;
  accountId:   number;
  platform:    string;
  email:       string;
  password:    string;
  profileName: string;
  expiresAt:   string | null;
  pin?:        string;
};

/**
 * Vende (asigna) el perfil libre más próximo a vencer de esa plataforma,
 * SIEMPRE que a la cuenta le queden al menos MIN_SELLABLE_DAYS — nunca se
 * vende una cuenta que va a vencer pronto, así el cliente no reclama por
 * no recibir el mes completo. null si no hay stock que cumpla eso.
 *
 * `wholesaler_id IS NULL` es a propósito: el stock que el admin ya le
 * asignó a un mayorista (Accesos > Asignar a mayorista) es SU inventario,
 * nunca se le puede vender por error a un cliente normal de retail.
 */
export type SellOptions = { days?: number; months?: number | null };

// Cerebro: dónde conviene vender. Primero las cuentas que igual se van a
// renovar (tienen clientes que siguen después de su vencimiento con el
// proveedor), luego las que todavía duran (≥ 28 días), las más llenas
// primero (así no quedan perfiles muertos repartidos), y la que más dura.
// Nunca una cuenta que el cerebro decidió dejar vencer. Dentro de la cuenta,
// primero los perfiles sin el aviso «¿cambiar PIN?» (el aviso no bloquea).
const BRAIN_SELL_ORDER = `
  ORDER BY (a.id = @prefer) DESC,
    (a.brain_action = 'renew') DESC,
    (a.expires_at > @tomorrow AND EXISTS (SELECT 1 FROM access_profiles q WHERE q.account_id = a.id AND (q.client_phone != '' OR q.wholesaler_id IS NOT NULL)
            AND COALESCE(q.expires_override, a.expires_at) > a.expires_at)) DESC,
    (a.expires_at >= @floor28) DESC,
    (SELECT COUNT(*) FROM access_profiles q WHERE q.account_id = a.id AND (q.client_phone != '' OR q.wholesaler_id IS NOT NULL)) DESC,
    a.expires_at DESC, p.pin_reset_pending ASC, p.slot_number ASC`;

/** Piso de venta: rotativas (ChatGPT, CapCut) y plataformas de siempre,
 *  28 días; perfiles del cerebro, que la cuenta siga viva mañana (el cerebro
 *  la renueva o mueve al cliente). */
function sellFloor(platform: string): string {
  return isBrainPlatform(platform) ? addDaysISOLocal(limaTodayISOLocal(), 1) : minSellableDateISO();
}

function pickFreeProfile(platform: string, wholesalerId: number | null, preferAccountId: number | null): any {
  const plat = platform.trim().toUpperCase();
  const floor = sellFloor(plat);
  const owner = wholesalerId === null ? "p.wholesaler_id IS NULL" : "(p.wholesaler_id = @wid OR p.wholesaler_id IS NULL)";
  const rotate = isRotatePlatform(plat);
  const brain = isBrainPlatform(plat) && !rotate;
  // Rotativas (ChatGPT, CapCut): el correo que más dura (menos cambios después).
  const order = brain
    ? (wholesalerId === null ? BRAIN_SELL_ORDER : BRAIN_SELL_ORDER.replace("ORDER BY", "ORDER BY (p.wholesaler_id IS NULL) ASC,"))
    : rotate
      ? (wholesalerId === null ? "ORDER BY (a.id = @prefer) DESC, a.expires_at DESC" : "ORDER BY (p.wholesaler_id IS NULL) ASC, a.expires_at DESC")
      : wholesalerId === null ? "ORDER BY (a.id = @prefer) DESC, a.expires_at ASC" : "ORDER BY (p.wholesaler_id IS NULL) ASC, a.expires_at ASC";
  // Cuenta completa ya vendida a alguien (sin perfiles) en una plataforma de
  // perfiles: no se revende como si fuera un perfil.
  const shape = brain ? "AND a.has_profiles = 1" : "";
  return db.prepare(`
    SELECT p.id AS profileId, p.profile_name AS profileName, CASE WHEN a.pin_mode = 1 THEN p.pin ELSE '' END AS pin,
           a.id AS accountId, a.platform AS platform, a.email AS email,
           a.password AS password, a.expires_at AS expiresAt
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE a.platform = @plat AND p.client_phone = '' AND ${owner}
      AND a.brain_action != 'drop' AND a.sale_paused = 0 ${shape}
      AND a.expires_at IS NOT NULL AND a.expires_at >= @floor
    ${order}
    LIMIT 1
  `).get({ plat, floor, floor28: minSellableDateISO(), tomorrow: addDaysISOLocal(limaTodayISOLocal(), 1), prefer: preferAccountId ?? -1, wid: wholesalerId ?? -1 }) as any;
}

/** Después de vender en una plataforma del cerebro: fecha propia del cliente
 *  (hoy + días del plan) y la venta queda contada para calcular stock. */
function afterBrainSale(row: any, opts: SellOptions | undefined): void {
  if (!isBrainPlatform(row.platform)) return;
  const days = opts?.days ?? 30;
  const months = opts?.months ?? Math.max(1, Math.round(days / 30));
  row.expiresAt = setNewClientDate(row.profileId, days, months === 12 || days >= 365 ? 12 : months);
  recordBrainSale(row.platform);
}

export const sellProfile = db.transaction((platform: string, clientPhone: string, orderRef: string, preferAccountId: number | null = null, opts?: SellOptions): SoldProfile | null => {
  const digits = normalizePeruPhone(clientPhone);
  const row = pickFreeProfile(platform, null, preferAccountId);
  if (!row) return null;

  db.prepare(`
    UPDATE access_profiles SET client_phone = ?, order_ref = ?, updated_at = datetime('now') WHERE id = ?
  `).run(digits, orderRef, row.profileId);
  afterBrainSale(row, opts);

  createCustomerNotification(digits, "new_account", row.platform, row.email);

  return row as SoldProfile;
});

/**
 * Vende a un sub-cliente del mayorista — prioriza el inventario YA
 * asignado a él (wholesaler_id = ?, Accesos > Asignar a mayorista) y, si
 * no tiene, cae al mismo pool compartido que usa el retail normal
 * (wholesaler_id IS NULL). El perfil vendido SIEMPRE queda marcado con
 * wholesaler_id = ese mayorista (aunque haya salido del pool compartido)
 * para que aparezca correcto en su "Clientes" — como ya tiene client_phone
 * puesto, sellProfile (retail) ya lo ignora de todas formas, así que esto
 * no le quita nada a retail, solo deja bien atribuida la venta.
 * Marca seen_by_wholesaler = 0 para el badge "(n)" de Cuentas.
 */
export const sellProfileForWholesaler = db.transaction((
  platform: string, wholesalerId: number, clientPhone: string, orderRef: string, opts?: SellOptions
): SoldProfile | null => {
  const digits = normalizePeruPhone(clientPhone);
  const row = pickFreeProfile(platform, wholesalerId, null);
  if (!row) return null;

  db.prepare(`
    UPDATE access_profiles
    SET client_phone = ?, order_ref = ?, wholesaler_id = ?, seen_by_wholesaler = 0, updated_at = datetime('now')
    WHERE id = ?
  `).run(digits, orderRef, wholesalerId, row.profileId);
  afterBrainSale(row, opts);

  createWholesalerNotification(wholesalerId, "purchase_added", row.platform, row.email);

  return row as SoldProfile;
});

/**
 * Alta de una plataforma de activación manual (CANVA, GEMINI AI PRO)
 * comprada por un mayorista — no sale de ningún pool de stock (no hay
 * perfiles pre-cargados para estas), se crea la cuenta directo con el
 * correo del cliente final y queda atribuida a ese mayorista/cliente,
 * igual que sellProfileForWholesaler. El admin la ve en Accesos con el
 * correo ya puesto, lista para activar a mano.
 */
export const createManualActivationForWholesaler = db.transaction((params: {
  platform: string; email: string; password?: string; expiresAt: string;
  wholesalerId: number; clientPhone: string; orderRef: string; planMonths?: number | undefined;
  // false = cuenta ya lista (admin › Asignar cuenta › Cuenta completa a mano
  // de Netflix, Disney…): no hay nada que activar, no va a "Pendientes".
  activationPending?: boolean;
}): { accountId: number; email: string } => {
  const [account] = createAccountsBulk({
    platform:    params.platform,
    provider:    "",
    hasProfiles: false,
    expiresAt:   params.expiresAt,
    pairs:       [{ email: params.email, password: params.password ?? "" }],
  });
  const digits = normalizePeruPhone(params.clientPhone);
  db.prepare(`
    UPDATE access_profiles
    SET client_phone = ?, order_ref = ?, wholesaler_id = ?, seen_by_wholesaler = 0, updated_at = datetime('now')
    WHERE id = ?
  `).run(digits, params.orderRef, params.wholesalerId, account.profiles[0].id);
  setAccountPlanMonths(account.id, params.planMonths);
  if (params.activationPending !== false) markActivationPending(account.id);
  createWholesalerNotification(params.wholesalerId, "purchase_added", params.platform, params.email);
  return { accountId: account.id, email: params.email };
});

/**
 * Cuenta completa para un cliente RETAIL (Accesos › «👤 Cuenta completa»):
 * una cuenta con perfiles, todos libres, pasa a ser una sola cuenta de ese
 * cliente — igual que las cuentas «sin perfiles» (CANVA, cuentas completas
 * de mayorista): queda 1 lugar con su celular y los demás perfiles vacíos
 * se quitan, así nadie más la ocupa y se renueva como cuenta completa.
 */
export const assignFullAccountToClient = db.transaction((params: {
  accountId: number; clientPhone: string; expiresAt?: string | undefined;
}): { ok: true; account: AccessAccountWithProfiles } | { ok: false; status: number; message: string } => {
  const account = getAccountById(params.accountId);
  if (!account) return { ok: false, status: 404, message: "Cuenta no encontrada." };
  if (!account.hasProfiles) {
    return { ok: false, status: 409, message: "Esta cuenta ya es completa (sin perfiles): usa «➕ Asignar»." };
  }
  if (account.profiles.some(p => p.clientPhone || p.wholesalerId != null)) {
    return { ok: false, status: 409, message: "Esta cuenta ya tiene perfiles ocupados (o de un mayorista). Para darla completa, todos sus perfiles tienen que estar libres." };
  }
  const keep = [...account.profiles].sort((a, b) => a.slotNumber - b.slotNumber)[0];
  if (!keep) return { ok: false, status: 409, message: "Esta cuenta no tiene perfiles." };

  db.prepare(`DELETE FROM access_profiles WHERE account_id = ? AND id <> ?`).run(account.id, keep.id);
  db.prepare(`
    UPDATE access_profiles
    SET client_phone = ?, order_ref = ?, renewal_status = '', expires_override = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(normalizePeruPhone(params.clientPhone), "admin-full:" + Date.now(), keep.id);
  db.prepare(`UPDATE access_accounts SET has_profiles = 0, updated_at = datetime('now') WHERE id = ?`).run(account.id);
  if (params.expiresAt) {
    db.prepare(`UPDATE access_accounts SET expires_at = ?, updated_at = datetime('now') WHERE id = ?`).run(params.expiresAt, account.id);
  }
  return { ok: true, account: getAccountById(account.id)! };
});

/**
 * Misma idea que createManualActivationForWholesaler pero para un cliente
 * RETAIL (liordark.com/WhatsApp) — sin wholesaler_id. Antes de esto, el
 * endpoint /canva-orders creaba la cuenta sin dueño (sin client_phone), así
 * que CANVA/GEMINI comprados por un cliente normal nunca aparecían en su
 * "Mis cuentas" ni se podían renovar desde ahí — se detectó al agregar
 * YOUTUBE PREMIUM (que sí necesita mostrarse ahí) y se corrige acá para
 * las tres plataformas de activación manual por igual.
 */
export const createManualActivationForClient = db.transaction((params: {
  platform: string; email: string; password?: string; expiresAt: string;
  clientPhone: string; orderRef: string; planMonths?: number | undefined;
}): { accountId: number; email: string } => {
  const [account] = createAccountsBulk({
    platform:    params.platform,
    provider:    "",
    hasProfiles: false,
    expiresAt:   params.expiresAt,
    pairs:       [{ email: params.email, password: params.password ?? "" }],
  });
  const digits = normalizePeruPhone(params.clientPhone);
  db.prepare(`
    UPDATE access_profiles
    SET client_phone = ?, order_ref = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(digits, params.orderRef, account.profiles[0].id);
  setAccountPlanMonths(account.id, params.planMonths);
  markActivationPending(account.id);
  return { accountId: account.id, email: params.email };
});

// ─────────────────────────────────────────────────────────────
// ACTIVACIÓN MANUAL PENDIENTE — queda marcada hasta que el admin confirme
// que ya hizo la activación real en la plataforma (Canva/Gemini/YouTube).
// Se muestra aparte en "Pedidos pendientes" (ver /access/activation-pending).
// ─────────────────────────────────────────────────────────────

export function setAccountPlanMonths(accountId: number, months: number | undefined | null): void {
  db.prepare(`UPDATE access_accounts SET plan_months = ? WHERE id = ?`).run(months ?? null, accountId);
}

export function markActivationPending(accountId: number): void {
  db.prepare(`UPDATE access_accounts SET activation_pending = 1, updated_at = datetime('now') WHERE id = ?`).run(accountId);
}

export function markActivationDone(accountId: number): void {
  db.prepare(`UPDATE access_accounts SET activation_pending = 0, updated_at = datetime('now') WHERE id = ?`).run(accountId);
}

export type PendingActivation = {
  accountId:   number;
  platform:    string;
  email:       string;
  password:    string;
  clientPhones: string[];
  expiresAt:   string | null;
  planMonths:  number | null;
  createdAt:   string;
};

export function listPendingActivations(): PendingActivation[] {
  const accounts = db.prepare(`
    SELECT id, platform, email, password, expires_at, plan_months, created_at
    FROM access_accounts
    WHERE activation_pending = 1
    ORDER BY created_at ASC
  `).all() as any[];

  return accounts.map(a => {
    const phones = (db.prepare(`
      SELECT DISTINCT client_phone FROM access_profiles WHERE account_id = ? AND client_phone != ''
    `).all(a.id) as any[]).map(r => r.client_phone);
    return {
      accountId:    a.id,
      platform:     a.platform,
      email:        a.email,
      password:     a.password,
      clientPhones: phones,
      expiresAt:    a.expires_at,
      planMonths:   a.plan_months ?? null,
      createdAt:    a.created_at,
    };
  });
}

/**
 * Cuánto stock puede comprar este mayorista por plataforma: lo que ya
 * tiene asignado de antemano + lo disponible del pool compartido de
 * retail (mismo piso de MIN_SELLABLE_DAYS que sellProfile) — es lo mismo
 * que vería sellProfileForWholesaler si vendiera ahora mismo.
 */
export function listWholesalerAvailability(wholesalerId: number): { platform: string; free: number }[] {
  const floor = minSellableDateISO();
  const tomorrow = addDaysISOLocal(limaTodayISOLocal(), 1);
  const rows = db.prepare(`
    SELECT a.platform AS platform,
           SUM(CASE WHEN p.client_phone = '' AND a.brain_action != 'drop' AND a.sale_paused = 0
                    AND a.expires_at IS NOT NULL AND a.expires_at >= @floor THEN 1 ELSE 0 END) AS free,
           SUM(CASE WHEN p.client_phone = '' AND a.brain_action != 'drop' AND a.sale_paused = 0
                    AND a.has_profiles = 1 AND a.expires_at IS NOT NULL AND a.expires_at >= @tomorrow THEN 1 ELSE 0 END) AS brainFree,
           SUM(CASE WHEN p.client_phone = '' AND a.brain_action != 'drop' AND a.sale_paused = 0
                    AND a.expires_at IS NOT NULL AND a.expires_at >= @tomorrow THEN 1 ELSE 0 END) AS rotateFree
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE p.wholesaler_id = @wholesalerId OR p.wholesaler_id IS NULL
    GROUP BY a.platform
    ORDER BY a.platform ASC
  `).all({ wholesalerId, floor, tomorrow }) as { platform: string; free: number; brainFree: number; rotateFree: number }[];
  return rows.map(r => ({
    platform: r.platform,
    free: isRotatePlatform(r.platform) ? (r.rotateFree ?? 0)
      : isBrainPlatform(r.platform) ? (r.brainFree ?? 0) : (r.free ?? 0),
  }));
}

/** Asigna perfiles ya existentes (libres, sin dueño) a un mayorista — bulk, por ids. Admin-only. */
export function assignProfilesToWholesaler(profileIds: number[], wholesalerId: number): number {
  if (profileIds.length === 0) return 0;
  const placeholders = profileIds.map(() => "?").join(",");
  const result = db.prepare(`
    UPDATE access_profiles SET wholesaler_id = ?, updated_at = datetime('now')
    WHERE id IN (${placeholders}) AND client_phone = '' AND wholesaler_id IS NULL
  `).run(wholesalerId, ...profileIds);
  return result.changes;
}

export type WholesalerClientProfile = AccessProfile & {
  platform: string; expiresAt: string | null; email: string; password: string;
  accountHasProfiles: boolean;
};

/** Sub-clientes de ESTE mayorista (perfiles con wholesaler_id = ? y cliente asignado).
 *  Incluye password — "Enviar cuenta" desde el panel mayorista necesita
 *  mandar el acceso completo, no solo el correo. */
export function listWholesalerClients(wholesalerId: number): WholesalerClientProfile[] {
  const rows = db.prepare(`
    SELECT p.id, p.account_id AS accountId, p.slot_number AS slotNumber, p.profile_name AS profileName,
           p.client_phone AS clientPhone, p.renewal_status AS renewalStatus, p.order_ref AS orderRef,
           p.updated_at AS updatedAt, a.platform AS platform,
           -- Cuenta ya renovada con el proveedor: quien no pagó se corta en la
           -- fecha original (renewal_cleanup_due_at), no en la nueva.
           -- Un reemplazo conserva la fecha del cliente en expires_override.
           CASE WHEN p.expires_override IS NOT NULL THEN p.expires_override
                WHEN a.renewal_cleanup_due_at IS NOT NULL AND COALESCE(p.renewal_status, '') != 'yes'
                THEN a.renewal_cleanup_due_at ELSE a.expires_at END AS expiresAt,
           a.email AS email, a.password AS password, a.has_profiles AS accountHasProfiles,
           CASE WHEN a.pin_mode = 1 THEN p.pin ELSE '' END AS pin
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE p.wholesaler_id = ? AND p.client_phone != ''
    ORDER BY expiresAt ASC
  `).all(wholesalerId) as any[];
  return rows.map(r => ({ ...r, accountHasProfiles: r.accountHasProfiles === 1 })) as WholesalerClientProfile[];
}

/** Libera el/los perfiles de ese cliente en esa plataforma (orden cancelada). Devuelve cuántos liberó. */
export function releaseProfilesByPhone(platform: string, clientPhone: string): number {
  const plat = platform.trim().toUpperCase();
  const digits = clientPhone.replace(/\D/g, "");
  if (!digits) return 0;

  const result = db.prepare(`
    UPDATE access_profiles
    SET client_phone = '', renewal_status = '', order_ref = '', updated_at = datetime('now')
    WHERE substr(client_phone, -9) = substr(?, -9)
      AND account_id IN (SELECT id FROM access_accounts WHERE platform = ?)
  `).run(digits, plat);

  return result.changes;
}

/** Libera SOLO los perfiles de ese order_ref exacto — a diferencia de
 *  releaseProfilesByPhone, no toca otras cuentas que ese mismo cliente
 *  ya tuviera en la misma plataforma. Usado para revertir una venta
 *  combo parcial (algunos ítems vendidos, otro sin stock). */
export function releaseProfilesByOrderRef(orderRef: string): number {
  if (!orderRef.trim()) return 0;
  const result = db.prepare(`
    UPDATE access_profiles
    SET client_phone = '', renewal_status = '', order_ref = '', updated_at = datetime('now')
    WHERE order_ref = ?
  `).run(orderRef);
  return result.changes;
}

/** Cuenta (con perfil) de ese cliente en esa plataforma — para renovar o confirmar datos. */
export function findAccountByClientPhone(platform: string, clientPhone: string): AccessAccountWithProfiles | null {
  const plat = platform.trim().toUpperCase();
  const digits = clientPhone.replace(/\D/g, "");
  if (!digits) return null;

  const row = db.prepare(`
    SELECT a.* FROM access_accounts a
    JOIN access_profiles p ON p.account_id = a.id
    WHERE a.platform = ? AND p.client_phone = ?
    LIMIT 1
  `).get(plat, digits) as any;

  return row ? { ...toAccount(row), profiles: getProfilesByAccount(row.id) } : null;
}

/** Perfil de este cliente en la plataforma (el que vence primero) con sus
 *  datos de acceso y su fecha propia — para la renovación del bot. */
export function findClientProfileForRenewal(platform: string, clientPhone: string): (SoldProfile & { clientExpiresAt: string | null }) | null {
  const digits = clientPhone.replace(/\D/g, "");
  if (digits.length < 9) return null;
  const row = db.prepare(`
    SELECT p.id AS profileId, p.profile_name AS profileName, CASE WHEN a.pin_mode = 1 THEN p.pin ELSE '' END AS pin,
           a.id AS accountId, a.platform AS platform, a.email AS email, a.password AS password,
           COALESCE(p.expires_override, a.expires_at) AS expiresAt
    FROM access_profiles p JOIN access_accounts a ON a.id = p.account_id
    WHERE a.platform = ? AND substr(p.client_phone, -9) = substr(?, -9)
    ORDER BY COALESCE(p.expires_override, a.expires_at) ASC
    LIMIT 1
  `).get(platform.trim().toUpperCase(), digits) as any;
  return row ? { ...row, clientExpiresAt: row.expiresAt } : null;
}

export type CustomerAccount = {
  platform:    string;
  email:       string;
  password:    string;
  link:        string;
  profileName: string;
  expiresAt:   string | null;
  pin?:        string;   // PIN del perfil (cuentas con «Perfiles con PIN»)
};

/** Todas las cuentas activas de un cliente (cualquier plataforma) — para
 *  su dashboard en la tienda web. Sin datos internos (provider, notes). */
/** Cuántos perfiles/cuentas se le asignaron a cada celular — para el panel de "Clientes web". */
export function countProfilesByPhone(): Record<string, number> {
  const rows = db.prepare(`
    SELECT client_phone AS phone, COUNT(*) AS count
    FROM access_profiles
    WHERE client_phone IS NOT NULL AND client_phone != ''
    GROUP BY client_phone
  `).all() as { phone: string; count: number }[];

  const map: Record<string, number> = {};
  for (const r of rows) map[r.phone] = r.count;
  return map;
}

// Un mismo celular queda guardado a veces con "51" adelante y a veces sin
// él, según por dónde haya entrado el dato (WhatsApp siempre manda con
// 51, pero cargas manuales/antiguas muchas veces sin) — un cliente real
// (967250368, sin prefijo, y 51967250368, con prefijo) apareció con
// cuentas repartidas entre las dos variantes, y una comparación exacta
// dejaba a la mitad invisibles en su propio "Mis cuentas". Los celulares
// de Perú son siempre 9 dígitos, así que comparar por los últimos 9
// ignora el prefijo sin importar de qué lado esté.
function last9(digits: string): string {
  return digits.slice(-9);
}

export function listAccountsByClientPhone(clientPhone: string): CustomerAccount[] {
  const digits = clientPhone.replace(/\D/g, "");
  if (!digits) return [];

  // COALESCE: si Soporte le reemplazó la cuenta con una del pool,
  // expires_override congela la fecha que ya tenía (ver expires_override
  // en db.ts) por encima de la fecha real de la cuenta nueva — hasta que
  // ésta se renueve de verdad.
  const real = db.prepare(`
    SELECT a.platform AS platform, a.email AS email, a.password AS password,
           a.link AS link, p.profile_name AS profileName,
           COALESCE(p.expires_override, a.expires_at) AS expiresAt,
           CASE WHEN a.pin_mode = 1 THEN p.pin ELSE '' END AS pin
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE substr(p.client_phone, -9) = ?
  `).all(last9(digits)) as CustomerAccount[];

  // Reemplazos manuales de Soporte (garantía sin cuenta real en Accesos —
  // ver manual-overrides.repository.ts) — se ven igual que cualquier otra
  // cuenta en "Mis cuentas".
  const overrides: CustomerAccount[] = listManualOverridesForClient(digits).map(o => ({
    platform: o.platform, email: o.email, password: o.password,
    link: "", profileName: o.profileName, expiresAt: o.expiresAt,
  }));

  return [...real, ...overrides].sort((a, b) => (a.expiresAt || "9999-99-99").localeCompare(b.expiresAt || "9999-99-99"));
}

export type AccountForSupport = {
  platform: string; email: string; password: string; provider: string; expiresAt: string | null;
};

/** Para el botón "Soporte" (liordark.com) — valida que la cuenta sea
 *  realmente de este cliente y de paso trae el proveedor, para el
 *  "Solicitar soporte al proveedor" del panel admin. También reconoce una
 *  garantía manual de Soporte (sin cuenta real en Accesos). */
export function getActiveAccountForClient(clientPhone: string, platform: string, email: string): AccountForSupport | null {
  const digits = clientPhone.replace(/\D/g, "");
  if (!digits) return null;
  const row = db.prepare(`
    SELECT a.platform AS platform, a.email AS email, a.password AS password,
           a.provider AS provider, COALESCE(p.expires_override, a.expires_at) AS expiresAt
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE substr(p.client_phone, -9) = ? AND a.platform = ? AND a.email = ?
    LIMIT 1
  `).get(last9(digits), platform.trim().toUpperCase(), email.trim()) as any;
  if (row) return row;

  const override = findManualOverride(clientPhone, platform, email, null);
  if (!override) return null;
  return { platform: override.platform, email: override.email, password: override.password, provider: override.provider, expiresAt: override.expiresAt };
}

/** Igual que getActiveAccountForClient, pero para un cliente de un
 *  mayorista puntual (ver wholesaler.routes.ts) — sólo reconoce cuentas
 *  y garantías que pertenecen a ESE mayorista. */
export function getActiveAccountForWholesalerClient(
  wholesalerId: number, clientPhone: string, platform: string, email: string
): AccountForSupport | null {
  const digits = clientPhone.replace(/\D/g, "");
  if (!digits) return null;
  const row = db.prepare(`
    SELECT a.platform AS platform, a.email AS email, a.password AS password,
           a.provider AS provider, COALESCE(p.expires_override, a.expires_at) AS expiresAt
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE substr(p.client_phone, -9) = ? AND a.platform = ? AND a.email = ? AND p.wholesaler_id = ?
    LIMIT 1
  `).get(last9(digits), platform.trim().toUpperCase(), email.trim(), wholesalerId) as any;
  if (row) return row;

  const override = findManualOverride(clientPhone, platform, email, wholesalerId);
  if (!override) return null;
  return { platform: override.platform, email: override.email, password: override.password, provider: override.provider, expiresAt: override.expiresAt };
}

// ─────────────────────────────────────────────────────────────
// REEMPLAZAR CUENTA (exclusivo de Soporte) — el cliente mantiene SIEMPRE
// la fecha de vencimiento de su cuenta anterior, sin importar si la cuenta
// destino ya tiene otros clientes o está recién creada. Se logra con
// access_profiles.expires_override, que prevalece sobre access_accounts.
// expires_at para ese cliente puntual (ver listAccountsByClientPhone) hasta
// que la cuenta destino se renueve de verdad (ver resetRenewalMarkers) o el
// cliente se libere de ahí (ver releaseProfile).
// ─────────────────────────────────────────────────────────────

// Fuente del reemplazo: o bien un perfil REAL (de Accesos) o un reemplazo
// manual anterior (ver manual-overrides.repository.ts) — un cliente puede
// reportar un problema dos veces seguidas y la segunda vez su "cuenta
// anterior" ya es ella misma una garantía manual, no una cuenta de pool.
type ReplaceSource =
  // fullAccount: la cuenta de origen es una cuenta completa (sin perfiles) —
  // su reemplazo «nuevo» tiene que ser otra cuenta entera, no un perfil.
  | { kind: "profile";  profileId: number;  preservedExpiresAt: string | null; fullAccount?: boolean }
  | { kind: "override"; overrideId: number; preservedExpiresAt: string | null };

/** wholesalerId: null busca la cuenta/garantía de un cliente retail; un id
 *  busca la de ESE mayorista — nunca se cruzan entre sí aunque coincida
 *  plataforma+correo. */
const NO_SOURCE_MSG = "No encontré la cuenta actual de este cliente en Accesos: puede que ya no tenga una de esta plataforma o que tenga varias. Búscalo en Accesos por su número.";

function findReplaceSource(clientPhone: string, platform: string, email: string, wholesalerId: number | null): ReplaceSource | null {
  const digits = clientPhone.replace(/\D/g, "");
  if (!digits) return null;
  const d9 = last9(digits);
  const plat = platform.trim().toUpperCase();
  const mail = email.trim().toLowerCase();

  // Se busca de lo más exacto a lo más amplio. Antes solo valía el correo
  // EXACTO del reporte: si después se editó la cuenta (correo nuevo), o el
  // correo venía con otras mayúsculas, salía «No se encontró la cuenta
  // actual del cliente» y no dejaba reemplazar.
  type Row = { profileId: number; preservedExpiresAt: string | null; hasProfiles: number };
  const profileBase = `
    SELECT p.id AS profileId, COALESCE(p.expires_override, a.expires_at) AS preservedExpiresAt, a.has_profiles AS hasProfiles
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE substr(p.client_phone, -9) = ? AND upper(trim(a.platform)) = ?`;
  // 1) Mismo correo (sin importar mayúsculas) y mismo dueño (retail o ese mayorista).
  let row = db.prepare(`${profileBase} AND lower(trim(a.email)) = ? AND p.wholesaler_id IS ? LIMIT 1`)
    .get(d9, plat, mail, wholesalerId) as Row | undefined;
  // 2) Mismo correo, aunque el perfil figure con otro dueño.
  if (!row) row = db.prepare(`${profileBase} AND lower(trim(a.email)) = ? LIMIT 1`).get(d9, plat, mail) as Row | undefined;
  if (row) return { kind: "profile", profileId: row.profileId, preservedExpiresAt: row.preservedExpiresAt, fullAccount: !row.hasProfiles };

  const ovBase = `SELECT id, expires_at AS expiresAt FROM manual_account_overrides
    WHERE substr(client_phone, -9) = ? AND upper(trim(platform)) = ?`;
  const ov = db.prepare(`${ovBase} AND lower(trim(email)) = ? ORDER BY (wholesaler_id IS ?) DESC LIMIT 1`)
    .get(d9, plat, mail, wholesalerId) as { id: number; expiresAt: string | null } | undefined;
  if (ov) return { kind: "override", overrideId: ov.id, preservedExpiresAt: ov.expiresAt };

  // 3) El correo ya no coincide (la cuenta se editó o el cliente se movió):
  //    si el cliente tiene UNA sola cuenta de esa plataforma, es esa.
  const profiles = db.prepare(`${profileBase} LIMIT 2`).all(d9, plat) as Row[];
  const overrides = db.prepare(`${ovBase} LIMIT 2`).all(d9, plat) as { id: number; expiresAt: string | null }[];
  if (profiles.length + overrides.length === 1) {
    if (profiles.length === 1) return { kind: "profile", profileId: profiles[0]!.profileId, preservedExpiresAt: profiles[0]!.preservedExpiresAt, fullAccount: !profiles[0]!.hasProfiles };
    return { kind: "override", overrideId: overrides[0]!.id, preservedExpiresAt: overrides[0]!.expiresAt };
  }
  return null;
}

/** ¿La cuenta actual de este cliente es una cuenta completa (sin perfiles)? */
export function isFullAccountSource(clientPhone: string, platform: string, email: string, wholesalerId: number | null): boolean {
  const source = findReplaceSource(clientPhone, platform, email, wholesalerId);
  return !!source && source.kind === "profile" && !!source.fullAccount;
}

/** Cuentas vigentes de la plataforma que están ENTERAS libres (ningún perfil
 *  con cliente ni de stock mayorista) — destino de un reemplazo de cuenta completa. */
export function listWholeFreeAccountIds(platform: string, todayISO: string): Set<number> {
  const rows = db.prepare(`
    SELECT a.id AS id FROM access_accounts a
    WHERE upper(a.platform) = ? AND (a.expires_at IS NULL OR a.expires_at >= ?) AND a.sale_paused = 0
      AND EXISTS (SELECT 1 FROM access_profiles p WHERE p.account_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM access_profiles p WHERE p.account_id = a.id AND (p.client_phone != '' OR p.wholesaler_id IS NOT NULL))
  `).all(platform.trim().toUpperCase(), todayISO) as { id: number }[];
  return new Set(rows.map(r => r.id));
}

function releaseReplaceSource(source: ReplaceSource): void {
  if (source.kind === "profile") releaseProfile(source.profileId);
  else deleteManualOverride(source.overrideId);
}

function findFreeProfileId(accountId: number): number | null {
  const row = db.prepare(`
    SELECT id FROM access_profiles WHERE account_id = ? AND client_phone = '' ORDER BY slot_number ASC LIMIT 1
  `).get(accountId) as { id: number } | undefined;
  return row ? row.id : null;
}

/** Cuentas con perfiles de esa plataforma, vigentes y con al menos
 *  `minFree` cupos libres — destino para "Enviar cuenta nueva" (Renovados). */
export function listAccountsWithFreeProfiles(platform: string, minFree: number, todayISO: string):
  { id: number; email: string; expiresAt: string | null; freeCount: number }[] {
  return db.prepare(`
    SELECT a.id AS id, a.email AS email, a.expires_at AS expiresAt,
           (SELECT COUNT(*) FROM access_profiles p WHERE p.account_id = a.id AND p.client_phone = '') AS freeCount
    FROM access_accounts a
    WHERE a.platform = ? AND a.has_profiles = 1 AND (a.expires_at IS NULL OR a.expires_at >= ?) AND a.sale_paused = 0
      AND (SELECT COUNT(*) FROM access_profiles p WHERE p.account_id = a.id AND p.client_phone = '') >= ?
    ORDER BY a.expires_at DESC
  `).all(platform.trim().toUpperCase(), todayISO, minFree) as { id: number; email: string; expiresAt: string | null; freeCount: number }[];
}

/** Cupos para acomodar a "Pendientes de cuenta nueva": perfiles sin
 *  cliente que no son stock de un mayorista, en cuentas vigentes de la
 *  plataforma (al menos uno por cuenta). */
export function listPlacementSlots(platform: string, todayISO: string):
  { id: number; email: string; expiresAt: string | null; freeCount: number }[] {
  return db.prepare(`
    SELECT a.id AS id, a.email AS email, a.expires_at AS expiresAt, COUNT(p.id) AS freeCount
    FROM access_accounts a
    JOIN access_profiles p ON p.account_id = a.id AND p.client_phone = '' AND p.wholesaler_id IS NULL
    WHERE a.platform = ? AND a.has_profiles = 1 AND (a.expires_at IS NULL OR a.expires_at >= ?) AND a.sale_paused = 0
    GROUP BY a.id
  `).all(platform.trim().toUpperCase(), todayISO) as { id: number; email: string; expiresAt: string | null; freeCount: number }[];
}

/** Coloca a un cliente (sin cuenta de origen — ej. un pendiente de cuenta
 *  nueva) en el primer cupo libre de `accountId` que no sea stock de un
 *  mayorista (ver listPlacementSlots), con su propia fecha. */
export const assignClientToFreeProfile = db.transaction((params: {
  accountId: number; clientPhone: string; wholesalerId: number | null; expiresAt: string;
}): number | null => {
  const row = db.prepare(`
    SELECT id FROM access_profiles WHERE account_id = ? AND client_phone = '' AND wholesaler_id IS NULL ORDER BY slot_number ASC LIMIT 1
  `).get(params.accountId) as { id: number } | undefined;
  const freeProfileId = row ? row.id : null;
  if (!freeProfileId) return null;
  assignProfileClient(freeProfileId, params.clientPhone);
  db.prepare(`
    UPDATE access_profiles SET expires_override = ?, wholesaler_id = ?, seen_by_wholesaler = ? WHERE id = ?
  `).run(params.expiresAt, params.wholesalerId, params.wholesalerId === null ? 1 : 0, freeProfileId);
  return freeProfileId;
});

/** Reemplazo de pool: mueve al cliente a un perfil libre de `targetAccountId`
 *  (llena o fresca, da igual), conservando su fecha anterior. Si es un
 *  cliente de mayorista, el perfil destino queda marcado como suyo (mismo
 *  criterio que una venta normal — ver sellProfileForWholesaler). */
export const replaceClientAccount = db.transaction((params: {
  clientPhone: string; platform: string; email: string; targetAccountId: number; wholesalerId: number | null;
  // Fecha nueva para el cliente (ej. una renovación pagada) — si no se
  // pasa, conserva la que ya tenía.
  expiresAt?: string;
}): { accountId: number; email: string } => {
  const source = findReplaceSource(params.clientPhone, params.platform, params.email, params.wholesalerId);
  if (!source) throw new Error(NO_SOURCE_MSG);

  const freeProfileId = findFreeProfileId(params.targetAccountId);
  if (!freeProfileId) throw new Error("La cuenta elegida no tiene perfiles libres.");
  // La venta sigue siendo la misma (perfil, cuenta, cuenta completa): se
  // lleva su referencia al lugar nuevo. Sin esto, al mayorista una venta
  // normal de una plataforma sin perfiles le figuraba como «Cuenta completa».
  const sourceRef = source.kind === "profile"
    ? ((db.prepare(`SELECT order_ref AS ref FROM access_profiles WHERE id = ?`).get(source.profileId) as { ref: string } | undefined)?.ref || "")
    : "";

  // Cuenta completa → la cuenta destino entera pasa a este cliente (como
  // «👤 Cuenta completa»): se quitan sus otros perfiles, todos libres.
  if (source.kind === "profile" && source.fullAccount) {
    const target = db.prepare(`SELECT has_profiles AS hasProfiles FROM access_accounts WHERE id = ?`).get(params.targetAccountId) as { hasProfiles: number } | undefined;
    if (target?.hasProfiles) {
      const busy = db.prepare(`
        SELECT 1 FROM access_profiles WHERE account_id = ? AND (client_phone != '' OR wholesaler_id IS NOT NULL) LIMIT 1
      `).get(params.targetAccountId);
      if (busy) throw new Error("Para reemplazar una cuenta completa, la cuenta nueva tiene que estar entera libre.");
      db.prepare(`DELETE FROM access_profiles WHERE account_id = ? AND id <> ?`).run(params.targetAccountId, freeProfileId);
      db.prepare(`UPDATE access_accounts SET has_profiles = 0, updated_at = datetime('now') WHERE id = ?`).run(params.targetAccountId);
    }
  }

  releaseReplaceSource(source);
  assignProfileClient(freeProfileId, params.clientPhone);
  db.prepare(`
    UPDATE access_profiles
    SET expires_override = ?, wholesaler_id = ?, seen_by_wholesaler = ?, order_ref = ?
    WHERE id = ?
  `).run(params.expiresAt ?? source.preservedExpiresAt, params.wholesalerId, params.wholesalerId === null ? 1 : 0, sourceRef, freeProfileId);
  // Cuenta de un solo lugar (cuenta completa, o plataforma sin perfiles): es
  // toda del cliente, así que su vencimiento ES el del cliente — se guarda en
  // la cuenta (lo ven Accesos, Códigos, renovaciones y avisos), no aparte.
  const keepDate = params.expiresAt ?? source.preservedExpiresAt;
  const single = db.prepare(`SELECT has_profiles AS hasProfiles, platform FROM access_accounts WHERE id = ?`).get(params.targetAccountId) as { hasProfiles: number; platform: string } | undefined;
  if (keepDate && single && !single.hasProfiles && !isBrainPlatform(single.platform)) {
    db.prepare(`UPDATE access_accounts SET expires_at = ?, updated_at = datetime('now') WHERE id = ?`).run(keepDate, params.targetAccountId);
    db.prepare(`UPDATE access_profiles SET expires_override = NULL WHERE id = ?`).run(freeProfileId);
  }

  const account = db.prepare(`SELECT email FROM access_accounts WHERE id = ?`).get(params.targetAccountId) as { email: string };
  return { accountId: params.targetAccountId, email: account.email };
});

/** Reemplazo manual: NO crea nada en Accesos — es solo una garantía para
 *  este cliente puntual (ver manual-overrides.repository.ts), visible en
 *  "Mis cuentas" / "Clientes" hasta que venza, conservando su fecha
 *  anterior. No ocupa stock, no la ve nadie más. */
export const replaceClientAccountManual = db.transaction((params: {
  clientPhone: string; platform: string; email: string; wholesalerId: number | null;
  newEmail: string; newPassword: string; newProfileName: string; newProvider: string;
  expiresAt?: string; // ver replaceClientAccount
}): { email: string } => {
  const source = findReplaceSource(params.clientPhone, params.platform, params.email, params.wholesalerId);
  if (!source) throw new Error(NO_SOURCE_MSG);

  releaseReplaceSource(source);
  createManualOverride({
    clientPhone:  params.clientPhone,
    wholesalerId: params.wholesalerId,
    platform:     params.platform,
    email:        params.newEmail,
    password:     params.newPassword,
    profileName:  params.newProfileName,
    provider:     params.newProvider,
    expiresAt:    params.expiresAt ?? source.preservedExpiresAt,
  });

  return { email: params.newEmail };
});

export type RenewalAccountView = {
  platform:    string;
  platformTag: string;
  email:       string;
  expiresAt:   string | null;
  price:       string;
};

/**
 * Para el check público de renovaciones en liordark.com — el cliente solo
 * pone su celular, sin login. A propósito NO trae password ni link, solo
 * lo necesario para decidir si renovar: qué cuenta, el correo (para
 * reconocerla) y cuánto cuesta. Los combos no se renuevan (se vuelven a
 * comprar), así que se excluyen acá.
 */
export function listRenewalAccountsByPhone(clientPhone: string): RenewalAccountView[] {
  const digits = clientPhone.replace(/\D/g, "");
  if (!digits) return [];

  return db.prepare(`
    SELECT a.platform AS platform, COALESCE(c.title, '') AS platformTag,
           a.email AS email, COALESCE(p.expires_override, a.expires_at) AS expiresAt, COALESCE(c.price, '') AS price
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    LEFT JOIN catalog_products c ON UPPER(TRIM(c.platform)) = a.platform
    WHERE substr(p.client_phone, -9) = ? AND p.order_ref NOT LIKE 'combo:%'
    ORDER BY a.expires_at ASC
  `).all(last9(digits)) as RenewalAccountView[];
}

export type RenewalMessageData = {
  profileName:  string;
  clientPhone:  string;
  platform:     string;
  platformTag:  string;
  email:        string;
  expiresAt:    string | null;
  price:        string;
};

/** Datos de un perfil puntual para armar el mensaje manual de renovación (botón 💬 del panel). */
export function getProfileForRenewalMessage(profileId: number): RenewalMessageData | null {
  const row = db.prepare(`
    SELECT p.profile_name AS profileName, p.client_phone AS clientPhone,
           a.platform AS platform, COALESCE(c.title, '') AS platformTag,
           a.email AS email, COALESCE(p.expires_override, a.expires_at) AS expiresAt, COALESCE(c.price, '') AS price
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    LEFT JOIN catalog_products c ON UPPER(TRIM(c.platform)) = a.platform
    WHERE p.id = ?
  `).get(profileId) as RenewalMessageData | undefined;
  return row || null;
}

export type ExpiringClient = {
  profileId:      number;
  clientPhone:    string;
  platform:       string;
  platformTag:    string; // título "amigable" del catálogo, para el mensaje al cliente
  price:          string; // precio del catálogo — para que el recordatorio diga cuánto pagar
  email:          string;
  password:       string;
  expiresAt:      string;
  reminderSentAt: string | null;
};

/**
 * Clientes ocupados cuya cuenta vence en los próximos `days` días (o ya
 * venció y sigue sin archivarse).
 *
 * `excludeAlreadyExpired` — para la tanda manual de recordatorios del
 * panel (Renovaciones): los que ya vencieron antes de hoy y nunca se les
 * mandó recordatorio, se omiten por ahora en vez de arrastrarse en cada
 * tanda — cada día que pasa la ventana avanza sola y van entrando los que
 * de verdad vencen pronto. No aplica a /api/stock/expiring (el bot sigue
 * viendo también los ya vencidos, para el aviso automático de WhatsApp).
 *
 * `exact` — en vez de "vence en `days` días o antes", solo "vence
 * exactamente en `days` días" (1 día de anticipación, ni más ni menos).
 */
export function listExpiringClients(days: number, opts?: { excludeAlreadyExpired?: boolean; exact?: boolean }): ExpiringClient[] {
  const today = limaTodayISOLocal();
  const limit = addDaysISOLocal(today, days);
  const dateFilter = opts?.exact
    ? "AND COALESCE(p.expires_override, a.expires_at) = @limit"
    : `AND COALESCE(p.expires_override, a.expires_at) <= @limit ${opts?.excludeAlreadyExpired ? "AND COALESCE(p.expires_override, a.expires_at) >= @today" : ""}`;
  return db.prepare(`
    SELECT p.id AS profileId, p.client_phone AS clientPhone, a.platform AS platform,
           COALESCE((SELECT c.title FROM catalog_products c WHERE UPPER(TRIM(c.platform)) = a.platform ORDER BY c.id LIMIT 1), '') AS platformTag,
           COALESCE((SELECT c.price FROM catalog_products c WHERE UPPER(TRIM(c.platform)) = a.platform ORDER BY c.id LIMIT 1), '') AS price,
           a.email AS email, a.password AS password, COALESCE(p.expires_override, a.expires_at) AS expiresAt,
           p.reminder_sent_at AS reminderSentAt
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE p.client_phone != '' AND p.wholesaler_id IS NULL AND COALESCE(p.expires_override, a.expires_at) IS NOT NULL
      ${dateFilter}
      AND p.order_ref NOT LIKE 'combo:%'
    ORDER BY (p.reminder_sent_at IS NOT NULL), COALESCE(p.expires_override, a.expires_at) ASC
  `).all({ today, limit }) as ExpiringClient[];
}

/** Igual que listExpiringClients, pero SOLO los sub-clientes de ESTE mayorista — panel mayorista > Recordatorios. */
export function listExpiringClientsForWholesaler(wholesalerId: number, days: number, opts?: { excludeAlreadyExpired?: boolean; exact?: boolean }): ExpiringClient[] {
  const today = limaTodayISOLocal();
  const limit = addDaysISOLocal(today, days);
  const dateFilter = opts?.exact
    ? "AND COALESCE(p.expires_override, a.expires_at) = @limit"
    : `AND COALESCE(p.expires_override, a.expires_at) <= @limit ${opts?.excludeAlreadyExpired ? "AND COALESCE(p.expires_override, a.expires_at) >= @today" : ""}`;
  return db.prepare(`
    SELECT p.id AS profileId, p.client_phone AS clientPhone, a.platform AS platform,
           COALESCE((SELECT c.title FROM catalog_products c WHERE UPPER(TRIM(c.platform)) = a.platform ORDER BY c.id LIMIT 1), '') AS platformTag,
           COALESCE((SELECT c.wholesale_price FROM catalog_products c WHERE UPPER(TRIM(c.platform)) = a.platform ORDER BY c.id LIMIT 1), '') AS price,
           a.email AS email, a.password AS password, COALESCE(p.expires_override, a.expires_at) AS expiresAt,
           p.reminder_sent_at AS reminderSentAt
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE p.client_phone != '' AND p.wholesaler_id = @wholesalerId AND COALESCE(p.expires_override, a.expires_at) IS NOT NULL
      ${dateFilter}
    ORDER BY (p.reminder_sent_at IS NOT NULL), COALESCE(p.expires_override, a.expires_at) ASC
  `).all({ today, limit, wholesalerId }) as ExpiringClient[];
}

/** Recordatorio manual de vencimiento mandado (panel > Renovaciones) — para no repetirle a la misma persona en la próxima tanda. */
export function markReminderSent(profileId: number): void {
  db.prepare(`UPDATE access_profiles SET reminder_sent_at = datetime('now') WHERE id = ?`).run(profileId);
}

/**
 * Clientes RETAIL (no mayoristas) que vencen EXACTO en esa fecha y
 * todavía no recibieron el SMS para ese ciclo de vencimiento — panel >
 * Renovaciones > SMS, selector de día (Hoy/Mañana). sms_reminder_sent_at
 * se limpia solo al renovar (ver resetRenewalMarkers), así que una vez
 * mandado no vuelve a aparecer para ese mismo ciclo.
 */
export function listUnSmsRemindedExpiringClientsForDate(dateISO: string): ExpiringClient[] {
  return listExpiringClientsForDate(dateISO, true);
}

/** Todos los clientes que vencen ese día (para el CSV de la difusión de
 *  WhatsApp, aunque ya se les haya mandado SMS). onlyWithoutSms = solo a
 *  los que todavía no se les mandó SMS. */
export function listExpiringClientsForDate(dateISO: string, onlyWithoutSms = false): ExpiringClient[] {
  return db.prepare(`
    SELECT p.id AS profileId, p.client_phone AS clientPhone, a.platform AS platform,
           COALESCE((SELECT c.title FROM catalog_products c WHERE UPPER(TRIM(c.platform)) = a.platform ORDER BY c.id LIMIT 1), '') AS platformTag,
           COALESCE((SELECT c.price FROM catalog_products c WHERE UPPER(TRIM(c.platform)) = a.platform ORDER BY c.id LIMIT 1), '') AS price,
           a.email AS email, a.password AS password, COALESCE(p.expires_override, a.expires_at) AS expiresAt,
           p.reminder_sent_at AS reminderSentAt
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE p.client_phone != '' AND p.wholesaler_id IS NULL
      AND COALESCE(p.expires_override, a.expires_at) = @dateISO
      AND p.order_ref NOT LIKE 'combo:%'
      AND (@onlyWithoutSms = 0 OR p.sms_reminder_sent_at IS NULL)
    ORDER BY p.client_phone ASC
  `).all({ dateISO, onlyWithoutSms: onlyWithoutSms ? 1 : 0 }) as ExpiringClient[];
}

/** Marca el SMS de vencimiento como mandado — separado de markReminderSent (WhatsApp). */
export function markSmsReminderSent(profileId: number): void {
  db.prepare(`UPDATE access_profiles SET sms_reminder_sent_at = datetime('now') WHERE id = ?`).run(profileId);
}

/** Marca que ya se le avisó por la campanita del panel mayorista — evita repetir en el próximo polling. */
export function markExpiryNotified(profileId: number): void {
  db.prepare(`UPDATE access_profiles SET expiry_notified_at = datetime('now') WHERE id = ?`).run(profileId);
}

/** Clientes que vencen en `days` días y aún no tienen su campanita, para UN cliente
 *  RETAIL (no mayorista) — campanita de liordark.com (ver GET /api/store/notifications). */
export function listUnnotifiedExpiringClientsForCustomer(
  phone: string, days: number
): { profileId: number; platform: string; email: string }[] {
  const today = limaTodayISOLocal();
  const limit = addDaysISOLocal(today, days);
  const last9 = phone.replace(/\D/g, "").slice(-9);
  return db.prepare(`
    SELECT p.id AS profileId, a.platform AS platform, a.email AS email
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE p.wholesaler_id IS NULL AND substr(p.client_phone, -9) = @last9
      AND COALESCE(p.expires_override, a.expires_at) <= @limit AND p.expiry_notified_at IS NULL
      AND p.order_ref NOT LIKE 'combo:%'
  `).all({ last9, limit }) as { profileId: number; platform: string; email: string }[];
}

/** Igual que arriba pero para TODOS los clientes retail a la vez — usado
 *  por el job proactivo (ver index.ts) para que la campanita se genere
 *  sola sin depender de que el cliente entre a pedir sus notificaciones. */
export function listAllUnnotifiedExpiringRetailClients(
  days: number
): { profileId: number; clientPhone: string; platform: string; email: string }[] {
  const today = limaTodayISOLocal();
  const limit = addDaysISOLocal(today, days);
  return db.prepare(`
    SELECT p.id AS profileId, p.client_phone AS clientPhone, a.platform AS platform, a.email AS email
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE p.wholesaler_id IS NULL AND p.client_phone != ''
      AND COALESCE(p.expires_override, a.expires_at) <= @limit AND p.expiry_notified_at IS NULL
      AND p.order_ref NOT LIKE 'combo:%'
  `).all({ limit }) as { profileId: number; clientPhone: string; platform: string; email: string }[];
}

export type EmailReminderCandidate = {
  profileId:      number;
  clientPhone:    string;
  customerEmail:  string;
  platform:       string;
  platformTag:    string;
  price:          string;
  imageUrl:       string;
  expiresAt:      string;
  d3AlreadySent:  boolean;
};

/** Clientes retail con correo registrado y a 3 días o menos de vencer, que
 *  todavía no recibieron el recordatorio FINAL por correo (el de 1 día) —
 *  ver expiry-reminder.job.ts, que decide ahí mismo (según los días que
 *  le queden de verdad) si toca mandar el de 3 días o el de 1 día. */
export function listEmailReminderCandidates(days: number): EmailReminderCandidate[] {
  const today = limaTodayISOLocal();
  const limit = addDaysISOLocal(today, days);
  return (db.prepare(`
    SELECT p.id AS profileId, p.client_phone AS clientPhone, c.email AS customerEmail,
           a.platform AS platform, COALESCE(cp.title, '') AS platformTag, COALESCE(cp.price, '') AS price,
           COALESCE(cp.image_url, '') AS imageUrl,
           COALESCE(p.expires_override, a.expires_at) AS expiresAt, p.email_reminder_3d_sent_at AS d3SentAt
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    JOIN customers c ON substr(c.phone, -9) = substr(p.client_phone, -9)
    LEFT JOIN catalog_products cp ON UPPER(TRIM(cp.platform)) = a.platform
    WHERE p.wholesaler_id IS NULL AND p.client_phone != '' AND c.email != ''
      AND COALESCE(p.expires_override, a.expires_at) <= @limit AND p.email_reminder_1d_sent_at IS NULL
      AND p.order_ref NOT LIKE 'combo:%'
      AND a.platform NOT LIKE '%YOUTUBE%'
  `).all({ limit }) as any[]).map(row => ({
    profileId:     row.profileId,
    clientPhone:   row.clientPhone,
    customerEmail: row.customerEmail,
    platform:      row.platform,
    platformTag:   row.platformTag || row.platform,
    price:         row.price,
    imageUrl:      row.imageUrl,
    expiresAt:     row.expiresAt,
    d3AlreadySent: !!row.d3SentAt,
  }));
}

export function markEmailReminder3dSent(profileId: number): void {
  db.prepare(`UPDATE access_profiles SET email_reminder_3d_sent_at = datetime('now') WHERE id = ?`).run(profileId);
}

export function markEmailReminder1dSent(profileId: number): void {
  db.prepare(`UPDATE access_profiles SET email_reminder_1d_sent_at = datetime('now') WHERE id = ?`).run(profileId);
}

export type RemindedClient = { profileId: number; clientPhone: string; platform: string; email: string; remindedAt: string };

/** Quiénes recibieron recordatorio en una fecha dada (YYYY-MM-DD, hora Lima) — detalle al hacer click en una corrida. */
export function listProfilesRemindedOn(dateISO: string): RemindedClient[] {
  return db.prepare(`
    SELECT p.id AS profileId, p.client_phone AS clientPhone, a.platform AS platform,
           a.email AS email, p.reminder_sent_at AS remindedAt
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE date(p.reminder_sent_at) = @dateISO
    ORDER BY p.reminder_sent_at ASC
  `).all({ dateISO }) as RemindedClient[];
}

/**
 * Todos los teléfonos de clientes que hayamos tenido alguna vez —
 * perfiles activos (access_profiles) + perfiles archivados cuando su
 * cuenta venció (access_accounts_history.profiles_json) — sin repetir
 * el mismo número. Para campañas puntuales (ej. avisar cambio de
 * número), no para operar cuentas.
 */
export function listAllClientPhones(): string[] {
  const activeRows = db.prepare(`
    SELECT DISTINCT client_phone AS clientPhone
    FROM access_profiles
    WHERE client_phone != ''
  `).all() as { clientPhone: string }[];

  const historyRows = db.prepare(`
    SELECT profiles_json AS profilesJson FROM access_accounts_history
  `).all() as { profilesJson: string }[];

  const phones = new Set<string>();
  for (const r of activeRows) phones.add(r.clientPhone);

  for (const row of historyRows) {
    let profiles: { clientPhone?: string }[] = [];
    try { profiles = JSON.parse(row.profilesJson || "[]"); } catch { /* fila corrupta — se salta */ }
    for (const p of profiles) {
      if (p.clientPhone) phones.add(p.clientPhone);
    }
  }

  return [...phones];
}

export type AccessClientStat = { phone: string; purchaseCount: number; firstSeenAt: string | null };

/**
 * Compras por celular — perfiles activos (access_profiles) + archivados
 * (access_accounts_history.profiles_json), sumados por el mismo cliente.
 * Para "Clientes > Registro" en el panel admin: a diferencia de
 * countProfilesByPhone (solo activos), esto cuenta TODO lo que compró
 * alguna vez, aunque esas cuentas ya hayan vencido y se archivaran.
 */
export function listAccessClientStats(): AccessClientStat[] {
  const activeRows = db.prepare(`
    SELECT client_phone AS phone, COUNT(*) AS count, MIN(updated_at) AS firstSeenAt
    FROM access_profiles
    WHERE client_phone != ''
    GROUP BY client_phone
  `).all() as { phone: string; count: number; firstSeenAt: string }[];

  const historyRows = db.prepare(`
    SELECT profiles_json AS profilesJson, archived_at AS archivedAt FROM access_accounts_history
  `).all() as { profilesJson: string; archivedAt: string }[];

  const map = new Map<string, { count: number; firstSeenAt: string | null }>();
  for (const r of activeRows) map.set(r.phone, { count: r.count, firstSeenAt: r.firstSeenAt });

  for (const row of historyRows) {
    let profiles: { clientPhone?: string }[] = [];
    try { profiles = JSON.parse(row.profilesJson || "[]"); } catch { continue; }
    for (const p of profiles) {
      if (!p.clientPhone) continue;
      const existing = map.get(p.clientPhone);
      if (existing) {
        existing.count += 1;
        if (!existing.firstSeenAt || row.archivedAt < existing.firstSeenAt) existing.firstSeenAt = row.archivedAt;
      } else {
        map.set(p.clientPhone, { count: 1, firstSeenAt: row.archivedAt });
      }
    }
  }

  return [...map.entries()].map(([phone, v]) => ({ phone, purchaseCount: v.count, firstSeenAt: v.firstSeenAt }));
}

export function limaTodayISOLocal(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
}

export function addDaysISOLocal(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const dt = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────
// BÚSQUEDA
// ─────────────────────────────────────────────────────────────

export type ProfileWithAccount = AccessProfile & {
  platform:         string;
  email:            string;
  password:         string;
  provider:         string;
  hasProfiles:      boolean;
  expiresAt:        string | null;
  renewalPendingAt: string | null;
};

/** Cuentas cuyo correo contiene el término buscado. */
export function searchAccountsByEmail(term: string): AccessAccountWithProfiles[] {
  const rows = db.prepare(`
    SELECT * FROM access_accounts WHERE email LIKE ? ORDER BY platform ASC
  `).all("%" + term.trim() + "%") as any[];
  return rows.map(row => ({ ...toAccount(row), profiles: getProfilesByAccount(row.id) }));
}

/**
 * Perfiles (con su cuenta) cuyo teléfono de cliente coincide. Compara por
 * los últimos 9 dígitos de AMBOS lados (como last9(), arriba) — no una
 * comparación directa — porque el prefijo "51" varía según por dónde
 * entró el dato: buscar "977 430 941" no encontraba a un cliente guardado
 * como "51977430941" (el LIKE plano exigía que el teléfono guardado
 * contuviera el término TAL CUAL se tipeó, sin ignorar el prefijo).
 */
export function searchProfilesByPhone(term: string): ProfileWithAccount[] {
  const digits = term.replace(/\D/g, "");
  if (!digits) return [];

  const rows = db.prepare(`
    SELECT p.*,
           a.platform AS platform, a.email AS email, a.password AS password,
           a.provider AS provider, a.has_profiles AS has_profiles, a.expires_at AS account_expires_at,
           a.renewal_pending_at AS renewal_pending_at
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE substr(p.client_phone, -9) LIKE '%' || substr(?, -9) || '%'
    ORDER BY a.expires_at ASC
  `).all(digits) as any[];

  return rows.map(row => ({
    ...toProfile(row),
    platform:         row.platform,
    email:            row.email,
    password:         row.password,
    provider:         row.provider ?? "",
    hasProfiles:      row.has_profiles === 1,
    expiresAt:        row.account_expires_at ?? null,
    renewalPendingAt: row.renewal_pending_at ?? null,
  }));
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function toAccount(row: any): AccessAccount {
  return {
    id:          row.id,
    platform:    row.platform,
    email:       row.email,
    password:    row.password,
    provider:    row.provider ?? "",
    hasProfiles: row.has_profiles === 1,
    expiresAt:   row.expires_at ?? null,
    link:        row.link ?? "",
    notes:       row.notes ?? "",
    providerRenewalEnabled:  row.provider_renewal_enabled === 1,
    providerRenewalCost:     row.provider_renewal_cost ?? "",
    providerRenewalCurrency: row.provider_renewal_currency || "USDT",
    providerRenewalNextDate: row.provider_renewal_next_date ?? null,
    renewalPendingAt: row.renewal_pending_at ?? null,
    codesEnabled: row.codes_enabled === 1,
    codesUnfiltered: row.codes_unfiltered === 1,
    codeSource:   row.code_source ?? null,
    totpSecret:   row.totp_secret ?? null,
    codeInboxUrl: row.code_inbox_url ?? "",
    renewalCleanupDueAt:   row.renewal_cleanup_due_at ?? null,
    passwordChangePending: row.password_change_pending === 1,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
    pinMode:        row.pin_mode === 1,
    salePaused:     row.sale_paused === 1,
    brainAction:    (row.brain_action ?? "") as "" | "renew" | "drop",
    brainActionFor: row.brain_action_for ?? null,
  };
}

function toProfile(row: any): AccessProfile {
  return {
    id:            row.id,
    accountId:     row.account_id,
    slotNumber:    row.slot_number,
    profileName:   row.profile_name ?? "",
    clientPhone:   row.client_phone ?? "",
    renewalStatus: (row.renewal_status ?? "") as RenewalStatus,
    orderRef:      row.order_ref ?? "",
    wholesalerId:  row.wholesaler_id ?? null,
    updatedAt:     row.updated_at,
    clientExpiresAt: row.expires_override ?? null,
    planMonths:      row.plan_months ?? null,
    pin:             row.pin ?? "",
    pinResetPending: row.pin_reset_pending === 1,
    movedAt:         row.moved_at ?? null,
  };
}
