import { db } from "./db";
import { normalizePeruPhone } from "../utils/phone.util";

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
  createdAt:   string;
  updatedAt:   string;
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

/** Crea varias cuentas de una — formato "correo:contraseña" ya parseado en pares. */
export function createAccountsBulk(params: {
  platform:    string;
  provider:    string;
  hasProfiles: boolean;
  expiresAt:   string | null;
  pairs:       { email: string; password: string }[];
  providerRenewalEnabled?:  boolean;
  providerRenewalCost?:     string;
  providerRenewalCurrency?: string;
  providerRenewalNextDate?: string | null;
}): AccessAccountWithProfiles[] {
  const slots = slotsFor(params.hasProfiles);

  const insertAccount = db.prepare(`
    INSERT INTO access_accounts (
      platform, email, password, provider, has_profiles, expires_at,
      provider_renewal_enabled, provider_renewal_cost, provider_renewal_currency, provider_renewal_next_date
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        params.providerRenewalEnabled ? (params.providerRenewalNextDate ?? null) : null
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

/**
 * Renovación con cuenta nueva: crea una cuenta aparte (mismas plataforma/
 * proveedor/perfiles que la vieja, con el correo y contraseña nuevos que ya
 * se cambiaron en el proveedor) y le pasa SOLO los clientes de la cuenta
 * vieja marcados "✅ Renueva" — el resto se queda como estaba en la vieja,
 * para decidir aparte qué hacer con ellos. No manda nada por WhatsApp ni
 * toca el bot — solo mueve datos dentro del panel.
 */
export function createAccountFromRenewal(oldAccountId: number, params: {
  email:     string;
  password:  string;
  expiresAt: string | null;
}): { oldAccount: AccessAccountWithProfiles; newAccount: AccessAccountWithProfiles } | null {
  const oldAccount = getAccountById(oldAccountId);
  if (!oldAccount) return null;

  const renewing = oldAccount.profiles.filter(p => p.clientPhone && p.renewalStatus === "yes");
  const slots = slotsFor(oldAccount.hasProfiles);

  const insertAccount = db.prepare(`
    INSERT INTO access_accounts (platform, email, password, provider, has_profiles, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertProfile = db.prepare(`
    INSERT INTO access_profiles (account_id, slot_number, profile_name, client_phone)
    VALUES (?, ?, ?, ?)
  `);
  const freeOldProfile = db.prepare(`
    UPDATE access_profiles SET client_phone = '', renewal_status = '', order_ref = '', updated_at = datetime('now') WHERE id = ?
  `);

  const newAccountId = db.transaction(() => {
    const result = insertAccount.run(
      oldAccount.platform, params.email.trim(), params.password.trim(),
      oldAccount.provider, oldAccount.hasProfiles ? 1 : 0, params.expiresAt
    );
    const id = result.lastInsertRowid as number;

    for (let slot = 1; slot <= slots; slot++) {
      const client = renewing[slot - 1];
      insertProfile.run(id, slot, slots === 1 ? "" : "Perfil " + slot, client ? client.clientPhone : "");
      if (client) freeOldProfile.run(client.id);
    }
    return id;
  })();

  return { oldAccount: getAccountById(oldAccountId)!, newAccount: getAccountById(newAccountId)! };
}

export function getAccountById(id: number): AccessAccountWithProfiles | null {
  const row = db.prepare(`SELECT * FROM access_accounts WHERE id = ?`).get(id) as any;
  if (!row) return null;
  return { ...toAccount(row), profiles: getProfilesByAccount(id) };
}

export function listPlatforms(): PlatformSummary[] {
  const floor = minSellableDateISO();
  return db.prepare(`
    SELECT
      a.platform AS platform,
      COUNT(DISTINCT a.id) AS accountCount,
      COUNT(p.id) AS profileCount,
      SUM(CASE WHEN p.client_phone != '' THEN 1 ELSE 0 END) AS occupiedCount,
      SUM(CASE WHEN p.client_phone = '' AND a.expires_at IS NOT NULL AND a.expires_at >= ? THEN 1 ELSE 0 END) AS sellableCount
    FROM access_accounts a
    LEFT JOIN access_profiles p ON p.account_id = a.id
    GROUP BY a.platform
    ORDER BY a.platform ASC
  `).all(floor) as PlatformSummary[];
}

export function listAccountsByPlatform(platform: string): AccessAccountWithProfiles[] {
  // id DESC como desempate: las cuentas migradas desde Sheets se insertaron
  // todas en una sola transacción (mismo created_at exacto), así que sin
  // este desempate el orden entre ellas queda indefinido. El id ascendente
  // sí refleja el orden real en que se agregaron (orden de fila en Sheets).
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

export function assignProfileClient(id: number, clientPhone: string): AccessProfile | null {
  const result = db.prepare(`
    UPDATE access_profiles SET client_phone = ?, updated_at = datetime('now') WHERE id = ?
  `).run(normalizePeruPhone(clientPhone), id);
  if (result.changes === 0) return null;
  return getProfileById(id);
}

export function releaseProfile(id: number): AccessProfile | null {
  const result = db.prepare(`
    UPDATE access_profiles SET client_phone = '', renewal_status = '', order_ref = '', updated_at = datetime('now') WHERE id = ?
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
 *  para que cada ciclo empiece con la marca en blanco de nuevo. */
export function resetRenewalMarkers(accountId: number): void {
  db.prepare(`UPDATE access_profiles SET renewal_status = '' WHERE account_id = ?`).run(accountId);
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
           COALESCE(c.title, '') AS platformTag, a.expires_at AS expiresAt
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    LEFT JOIN catalog_products c ON UPPER(TRIM(c.platform)) = a.platform
    WHERE p.renewal_status = 'yes' AND p.client_phone != '' AND p.wholesaler_id IS NULL
    ORDER BY a.expires_at ASC
  `).all() as RenewingProfile[];
}

// ─────────────────────────────────────────────────────────────
// STOCK — usado por la API que consume el bot de WhatsApp (Telegram/venta)
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
export const sellProfile = db.transaction((platform: string, clientPhone: string, orderRef: string): SoldProfile | null => {
  const plat = platform.trim().toUpperCase();
  const digits = normalizePeruPhone(clientPhone);
  const floor = minSellableDateISO();

  const row = db.prepare(`
    SELECT p.id AS profileId, p.profile_name AS profileName,
           a.id AS accountId, a.platform AS platform, a.email AS email,
           a.password AS password, a.expires_at AS expiresAt
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE a.platform = ? AND p.client_phone = '' AND p.wholesaler_id IS NULL
      AND a.expires_at IS NOT NULL AND a.expires_at >= ?
    ORDER BY a.expires_at ASC
    LIMIT 1
  `).get(plat, floor) as any;

  if (!row) return null;

  db.prepare(`
    UPDATE access_profiles SET client_phone = ?, order_ref = ?, updated_at = datetime('now') WHERE id = ?
  `).run(digits, orderRef, row.profileId);

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
  platform: string, wholesalerId: number, clientPhone: string, orderRef: string
): SoldProfile | null => {
  const plat = platform.trim().toUpperCase();
  const digits = normalizePeruPhone(clientPhone);
  const floor = minSellableDateISO();

  const row = db.prepare(`
    SELECT p.id AS profileId, p.profile_name AS profileName,
           a.id AS accountId, a.platform AS platform, a.email AS email,
           a.password AS password, a.expires_at AS expiresAt
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE a.platform = ? AND p.client_phone = ''
      AND (p.wholesaler_id = ? OR p.wholesaler_id IS NULL)
      AND a.expires_at IS NOT NULL AND a.expires_at >= ?
    ORDER BY (p.wholesaler_id IS NULL) ASC, a.expires_at ASC
    LIMIT 1
  `).get(plat, wholesalerId, floor) as any;

  if (!row) return null;

  db.prepare(`
    UPDATE access_profiles
    SET client_phone = ?, order_ref = ?, wholesaler_id = ?, seen_by_wholesaler = 0, updated_at = datetime('now')
    WHERE id = ?
  `).run(digits, orderRef, wholesalerId, row.profileId);

  return row as SoldProfile;
});

/**
 * Cuánto stock puede comprar este mayorista por plataforma: lo que ya
 * tiene asignado de antemano + lo disponible del pool compartido de
 * retail (mismo piso de MIN_SELLABLE_DAYS que sellProfile) — es lo mismo
 * que vería sellProfileForWholesaler si vendiera ahora mismo.
 */
export function listWholesalerAvailability(wholesalerId: number): { platform: string; free: number }[] {
  const floor = minSellableDateISO();
  return db.prepare(`
    SELECT a.platform AS platform,
           SUM(CASE WHEN p.client_phone = '' AND a.expires_at IS NOT NULL AND a.expires_at >= @floor THEN 1 ELSE 0 END) AS free
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE p.wholesaler_id = @wholesalerId OR p.wholesaler_id IS NULL
    GROUP BY a.platform
    ORDER BY a.platform ASC
  `).all({ wholesalerId, floor }) as { platform: string; free: number }[];
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
};

/** Sub-clientes de ESTE mayorista (perfiles con wholesaler_id = ? y cliente asignado).
 *  Incluye password — "Enviar cuenta" desde el panel mayorista necesita
 *  mandar el acceso completo, no solo el correo. */
export function listWholesalerClients(wholesalerId: number): WholesalerClientProfile[] {
  return db.prepare(`
    SELECT p.id, p.account_id AS accountId, p.slot_number AS slotNumber, p.profile_name AS profileName,
           p.client_phone AS clientPhone, p.renewal_status AS renewalStatus, p.order_ref AS orderRef,
           p.updated_at AS updatedAt, a.platform AS platform, a.expires_at AS expiresAt,
           a.email AS email, a.password AS password
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE p.wholesaler_id = ? AND p.client_phone != ''
    ORDER BY a.expires_at ASC
  `).all(wholesalerId) as WholesalerClientProfile[];
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

export type CustomerAccount = {
  platform:    string;
  email:       string;
  password:    string;
  link:        string;
  profileName: string;
  expiresAt:   string | null;
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

  return (db.prepare(`
    SELECT a.platform AS platform, a.email AS email, a.password AS password,
           a.link AS link, p.profile_name AS profileName, a.expires_at AS expiresAt
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    WHERE substr(p.client_phone, -9) = ?
    ORDER BY a.expires_at ASC
  `).all(last9(digits)) as CustomerAccount[]);
}

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
           a.email AS email, a.expires_at AS expiresAt, COALESCE(c.price, '') AS price
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    LEFT JOIN catalog_products c ON UPPER(TRIM(c.platform)) = a.platform
    WHERE substr(p.client_phone, -9) = ? AND p.order_ref NOT LIKE 'combo:%'
    ORDER BY a.expires_at ASC
  `).all(last9(digits)) as RenewalAccountView[];
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
 */
export function listExpiringClients(days: number, opts?: { excludeAlreadyExpired?: boolean }): ExpiringClient[] {
  const today = limaTodayISOLocal();
  const limit = addDaysISOLocal(today, days);
  const lowerBound = opts?.excludeAlreadyExpired ? "AND a.expires_at >= @today" : "";
  return db.prepare(`
    SELECT p.id AS profileId, p.client_phone AS clientPhone, a.platform AS platform,
           COALESCE(c.title, '') AS platformTag, COALESCE(c.price, '') AS price,
           a.email AS email, a.password AS password, a.expires_at AS expiresAt,
           p.reminder_sent_at AS reminderSentAt
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    LEFT JOIN catalog_products c ON UPPER(TRIM(c.platform)) = a.platform
    WHERE p.client_phone != '' AND p.wholesaler_id IS NULL AND a.expires_at IS NOT NULL AND a.expires_at <= @limit
      ${lowerBound}
      AND p.order_ref NOT LIKE 'combo:%'
    ORDER BY (p.reminder_sent_at IS NOT NULL), a.expires_at ASC
  `).all({ today, limit }) as ExpiringClient[];
}

/** Igual que listExpiringClients, pero SOLO los sub-clientes de ESTE mayorista — panel mayorista > Recordatorios. */
export function listExpiringClientsForWholesaler(wholesalerId: number, days: number, opts?: { excludeAlreadyExpired?: boolean }): ExpiringClient[] {
  const today = limaTodayISOLocal();
  const limit = addDaysISOLocal(today, days);
  const lowerBound = opts?.excludeAlreadyExpired ? "AND a.expires_at >= @today" : "";
  return db.prepare(`
    SELECT p.id AS profileId, p.client_phone AS clientPhone, a.platform AS platform,
           COALESCE(c.title, '') AS platformTag, COALESCE(c.wholesale_price, '') AS price,
           a.email AS email, a.password AS password, a.expires_at AS expiresAt,
           p.reminder_sent_at AS reminderSentAt
    FROM access_profiles p
    JOIN access_accounts a ON a.id = p.account_id
    LEFT JOIN catalog_products c ON UPPER(TRIM(c.platform)) = a.platform
    WHERE p.client_phone != '' AND p.wholesaler_id = @wholesalerId AND a.expires_at IS NOT NULL AND a.expires_at <= @limit
      ${lowerBound}
    ORDER BY (p.reminder_sent_at IS NOT NULL), a.expires_at ASC
  `).all({ today, limit, wholesalerId }) as ExpiringClient[];
}

/** Recordatorio manual de vencimiento mandado (panel > Renovaciones) — para no repetirle a la misma persona en la próxima tanda. */
export function markReminderSent(profileId: number): void {
  db.prepare(`UPDATE access_profiles SET reminder_sent_at = datetime('now') WHERE id = ?`).run(profileId);
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

function limaTodayISOLocal(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
}

function addDaysISOLocal(dateISO: string, days: number): string {
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
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
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
  };
}
