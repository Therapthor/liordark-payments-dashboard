import { findCustomerByEmail } from "../db/customer.repository";
import { Router } from "express";
import { listManualOverridesForAccount, listManualOverridesByPhone, getManualOverrideById, type ManualAccountOverride } from "../db/manual-overrides.repository";
import { emitDashboardEvent } from "../utils/live-events.util";
import { db } from "../db/db";
import { replaceOptionsFor, replaceClientTo, type ReplaceSubject } from "../services/support-reports.service";
import { replaceClientAccount, replaceClientAccountManual, listAccountsWithFreeProfiles, setAccountPinMode, setAccountSalePaused, setProfilePin, dismissPinReminder, setAccountPins, pinLengthFor, validPinFor, randomPin, setClientDate, getProfileById } from "../db/access.repository";
import { isBrainPlatform, setNewClientDate, extendClientDate } from "../db/brain-platforms";
import { runBrain, brainOverview, markProviderRenewed } from "../services/brain.service";
import { planFor } from "../services/plans.service";
import {
  createAccountsBulk,
  updateAccount,
  deleteAccount,
  getAccountById,
  listPlatforms,
  listAccountsByPlatform,
  assignProfileClient,
  assignFullAccountToClient,
  releaseProfile,
  setProfileRenewal,
  searchAccountsByEmail,
  searchProfilesByPhone,
  listProviderRenewalAccounts,
  markProviderRenewalRenewed,
  setRenewalPending,
  sellProfile,
  listRenewingProfiles,
  listAccountsWithPendingRenewal,
  listAccountsNeedingPasswordChange,
  markPasswordChanged,
  listPendingActivations,
  markActivationDone,
  getProfileForRenewalMessage,
  setAccountExpiry,
  duplicateAccount,
  type AccessAccountWithProfiles,
  type BulkAccountPair,
  type ProfileWithAccount,
  type RenewalStatus,
  type SoldProfile,
} from "../db/access.repository";
import {
  renewAccount, accountStatus, daysLeft, runRenewalCutover, limaTodayISO, addDaysISO,
  listCycleRenewalsAwaitingConfirmation, confirmCycleRenewal, assignPendingClients,
  accountNoticeFor, listActiveSubscribers, notifyActiveSubscribers, minTargetExpiry,
} from "../services/access.service";
import { listPendingAssignments, countPendingAssignments } from "../db/pending-assignments.repository";
import { listPayLinkCandidates, createPayLink, cleanOldPayLinks, priceSelection } from "../db/renewal-pay-links.repository";
import { listCatalogProducts, getCatalogProductByPlatform } from "../db/catalog.repository";
import { plansFor } from "../services/plans.service";
import { listProviders } from "../db/provider.repository";
import { listArchivedAccounts, searchArchivedAccounts, searchArchivedByEmail } from "../db/access-history.repository";
import { listRenewalHistory } from "../db/renewal-history.repository";
import {
  setAccountCodesEnabled,
  setAccountCodesUnfiltered,
  setAccountCodeSource,
  setAccountTotpSecret,
  setAccountCodeInboxUrl,
  listCodesEnabledAccounts,
  getLatestCodeForAccount,
  getLastSeenCodeForEmail,
  saveIncomingCode,
  inheritCodeConfigFromSiblings,
  countCodeSiblings,
} from "../db/codes.repository";
import { lookupCodeActionWithRetries, lookupAnySourceWithRetries, listCodeSources, listSourceActions, codeSourceLabel, skipsRepeatedCodes, TOTP_SOURCE_ID, isAdminOnlyResult, isAccountChangeResult, deliversEverything, withLookupContext, LIST_SOURCES, normalizeInboxUrl, INBOX_LINK_SOURCES, loginApprovalOf, parseProviderDate, recentInboxMails, type CodeLookupResult } from "../services/codes-lookup.service";
import { listInbox, getInboxHtml, listActivity, sourcesHealth, runCodeWatch, watcherInfo, inboxInfoFor } from "../services/codes-brain.service";
import { listCodeRequests, rushRequest, typicalArrivalSeconds } from "../services/code-requests.service";
import { lanesStatus, laneIdOf } from "../services/codes-lanes";
import { getCurrentTotp, normalizeTotpSecret } from "../utils/totp.util";
import { createCustomerNotification } from "../db/customer-notifications.repository";
import { createWholesalerNotification } from "../db/wholesaler-notifications.repository";

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TOTP_SECRET_INVALID_MESSAGE =
  "La clave 2FA no es válida: debe tener al menos 16 caracteres, solo letras A–Z y números 2–7 " +
  "(los espacios y guiones se quitan solos). Revisa que la copiaste completa.";

/** Código 2FA de una cuenta para la lista de Códigos — una clave mala en
 *  UNA cuenta nunca tumba la lista entera: esa cuenta sale sin código. */
function safeTotp(secret: string, accountId: number): { code: string; secondsRemaining: number } | null {
  try {
    return getCurrentTotp(secret);
  } catch {
    console.warn(`⚠️ Clave 2FA inválida en la cuenta ${accountId} (Códigos la muestra sin código).`);
    return null;
  }
}

// ── serialización — agrega estado/días calculados a la cuenta ──

// ¿El cliente puede ver su reemplazo? Retail: si tiene usuario web lo ve en
// «Mis cuentas»; además, si ya leyó el aviso de la campanita. Mayorista: lo
// ve en su panel (Clientes).
function replacementSeen(clientPhone: string, wholesalerId: number | null, platform: string, email: string) {
  if (wholesalerId != null) return { wholesaler: true, web: false, read: null as boolean | null };
  const d9 = String(clientPhone || "").replace(/\D/g, "").slice(-9);
  if (!d9) return { wholesaler: false, web: false, read: null as boolean | null };
  const web = !!db.prepare(`SELECT 1 FROM customers WHERE substr(phone, -9) = ? LIMIT 1`).get(d9);
  const n = db.prepare(`
    SELECT read_at AS readAt FROM customer_notifications
    WHERE substr(client_phone, -9) = ? AND type = 'account_replaced' AND UPPER(platform) = UPPER(?) AND LOWER(account_email) = LOWER(?)
    ORDER BY id DESC LIMIT 1
  `).get(d9, platform, email) as { readAt: string | null } | undefined;
  return { wholesaler: false, web, read: n ? !!n.readAt : null };
}

function withStatus(account: AccessAccountWithProfiles) {
  return {
    ...account,
    profiles: account.profiles.map(p => p.replacedAt && p.clientPhone
      ? { ...p, replacedSeen: replacementSeen(p.clientPhone, p.wholesalerId, account.platform, account.email) }
      : p),
    // Reemplazos «en uso» a esta cuenta: no ocupan perfil, se muestran aparte.
    overrides: listManualOverridesForAccount(account.platform, account.email).map(o => ({
      id: o.id, clientPhone: o.clientPhone, wholesalerId: o.wholesalerId, profileName: o.profileName,
      expiresAt: o.expiresAt, createdAt: o.createdAt, replacedFrom: o.replacedFrom,
      seen: replacementSeen(o.clientPhone, o.wholesalerId, account.platform, account.email),
    })),
    status:   accountStatus(account.expiresAt),
    daysLeft: daysLeft(account.expiresAt),
    // Cerebro: cada cliente con su fecha; la de la cuenta es la del proveedor.
    brain:    isBrainPlatform(account.platform),
  };
}

function profileWithStatus(p: ProfileWithAccount) {
  return { ...p, status: accountStatus(p.expiresAt), daysLeft: daysLeft(p.expiresAt) };
}

// Reemplazo «en uso» (temporal) para la búsqueda por celular: no ocupa
// perfil, así que va aparte de los perfiles. accountId = la cuenta de
// Accesos a la que apunta (si sigue existiendo), para «👁 Ver cuenta».
function overrideWithStatus(o: ManualAccountOverride) {
  const acc = db.prepare(`
    SELECT id, password, provider, expires_at AS expiresAt FROM access_accounts
    WHERE upper(trim(platform)) = upper(trim(?)) AND lower(trim(email)) = lower(trim(?)) LIMIT 1
  `).get(o.platform, o.email) as { id: number; password: string; provider: string; expiresAt: string | null } | undefined;
  return {
    id: o.id, clientPhone: o.clientPhone, wholesalerId: o.wholesalerId, platform: o.platform,
    email: o.email, password: o.password || acc?.password || "", profileName: o.profileName,
    provider: o.provider || acc?.provider || "", expiresAt: o.expiresAt, createdAt: o.createdAt,
    replacedFrom: o.replacedFrom, accountId: acc?.id ?? null, providerExpiresAt: acc?.expiresAt ?? null,
    status: accountStatus(o.expiresAt), daysLeft: daysLeft(o.expiresAt),
    seen: replacementSeen(o.clientPhone, o.wholesalerId, o.platform, o.email),
  };
}

// ── CATÁLOGO (para el desplegable de plataforma) ──
// Viene del catálogo propio del panel (Configuración > Catálogo), no del
// bot — se edita ahí. Ver src/db/catalog.repository.ts.

router.get("/platforms-catalog", (req, res) => {
  // plans: CANVA/GEMINI se venden por meses (Mayoristas › Asignar cuenta los ofrece).
  // ?all=1 (Accesos): también los apagados en el Catálogo, marcados — así una
  // cuenta de un producto apagado (ej. CLAUDE) nunca cae en otra plataforma.
  const all = req.query.all === "1";
  const platforms = listCatalogProducts(!all).map(p => {
    const plans = plansFor(p.platform);
    return {
      platform: p.platform, hasProfiles: p.hasProfiles, active: p.active,
      ...(plans ? { plans: plans.map(pl => ({ months: pl.months, days: pl.days, label: pl.label })) } : {}),
    };
  });
  res.json({ platforms });
});

// ── PROVEEDORES (para el desplegable "Proveedor" y el botón 🔑 de soporte) ──
// Viene de Configuración > Proveedores. Ver src/db/provider.repository.ts.

router.get("/providers-catalog", (_req, res) => {
  const providers = listProviders(true).map(p => ({ name: p.name, whatsapp: p.whatsapp }));
  res.json({ providers });
});

// ── HISTORIAL (cuentas ya vencidas — archivado automático, ver index.ts) ──

router.get("/history", (req, res) => {
  const term = String(req.query.q ?? "").trim();
  res.json({ accounts: term ? searchArchivedAccounts(term) : listArchivedAccounts() });
});

// ── PLATAFORMAS (agrupación de cuentas ya cargadas en Accesos) ──

// active=false si el producto está apagado en el Catálogo: el panel no lo
// cuenta como «Sin stock» (no se vende, así que no es una alerta).
router.get("/platforms", (_req, res) => {
  const off = new Set(listCatalogProducts().filter(p => !p.active).map(p => p.platform.trim().toUpperCase()));
  res.json({ platforms: listPlatforms().map(p => ({ ...p, active: !off.has(String(p.platform).trim().toUpperCase()), brain: isBrainPlatform(p.platform) })) });
});

router.get("/platforms/:platform/accounts", (req, res) => {
  const accounts = listAccountsByPlatform(req.params.platform);
  res.json({ accounts: accounts.map(withStatus) });
});

// ── CUENTAS ──

// Alta en formato "correo:contraseña" (una por línea) — todas comparten
// plataforma, proveedor y vencimiento inicial. hasProfiles se resuelve
// del catálogo propio del panel, nunca se confía en lo que mande el cliente.
// Con bandeja (Juanpa) cada línea lleva su link al final; con 2FA, su clave
// secreta después del primer espacio. Si alguna línea está mal no se crea
// nada y se responde qué línea falla y por qué (errors).
router.post("/accounts/bulk", async (req, res) => {
  const {
    platform, provider, expiresAt, lines,
    providerRenewalCost, providerRenewalCurrency, providerRenewalNextDate,
  } = req.body ?? {};
  // Plataformas del cerebro: el pago al proveedor lo maneja el cerebro
  // (Renovaciones › Pagos al proveedor), no el aviso viejo por cuenta.
  const providerRenewalEnabled = !!req.body?.providerRenewalEnabled && !isBrainPlatform(platform);

  // De dónde sacar el código para TODAS las cuentas del lote (vacío = sin
  // código).
  const codeSource = typeof req.body?.codeSource === "string" && req.body.codeSource.trim() ? req.body.codeSource.trim() : null;
  if (codeSource && !listCodeSources().some(s => s.id === codeSource)) {
    res.status(400).json({ message: "Ese tipo de código no existe." });
    return;
  }
  const needsInbox = !!codeSource && INBOX_LINK_SOURCES.includes(codeSource);
  const needsTotp  = codeSource === TOTP_SOURCE_ID;

  if (!platform?.trim()) { res.status(400).json({ message: "Elige una plataforma." }); return; }
  if (!expiresAt || !DATE_RE.test(expiresAt)) { res.status(400).json({ message: "Fecha de vencimiento inválida." }); return; }
  if (typeof lines !== "string" || !lines.trim()) { res.status(400).json({ message: "Pega al menos una línea correo:contraseña." }); return; }
  if (providerRenewalEnabled) {
    if (!providerRenewalCost?.trim()) { res.status(400).json({ message: "Falta el costo de la renovación con el proveedor." }); return; }
    if (!providerRenewalNextDate || !DATE_RE.test(providerRenewalNextDate)) {
      res.status(400).json({ message: "Falta la próxima fecha de renovación con el proveedor." });
      return;
    }
  }

  // Mismo criterio que parseBulkLines en public/js/access.js (el panel ya
  // avisa antes de mandar; esto es la segunda revisión). Las líneas se
  // numeran como se ven en el cuadro, contando las vacías.
  const pairs: BulkAccountPair[] = [];
  const lineErrors: { line: number; message: string }[] = [];
  lines.split("\n").forEach((raw: string, i: number) => {
    let rest = raw.trim();
    if (!rest) return;
    const line = i + 1;
    let inboxUrl: string | undefined;
    let totpSecret: string | undefined;
    if (needsTotp) {
      // 2FA: correo:contraseña CLAVE2FA — la clave va después del primer
      // espacio (puede venir en bloques separados por espacios).
      const sep = rest.search(/\s/);
      if (sep === -1) { lineErrors.push({ line, message: "falta la clave 2FA después de un espacio (correo:contraseña CLAVE2FA)." }); return; }
      const key = normalizeTotpSecret(rest.slice(sep + 1));
      if (!key) { lineErrors.push({ line, message: "la clave 2FA no es válida (mínimo 16 caracteres, solo letras A–Z y números 2–7)." }); return; }
      totpSecret = key;
      rest = rest.slice(0, sep).trim();
    } else if (needsInbox) {
      // Bandeja del proveedor (Juanpa): el link va al final de cada línea.
      const m = rest.match(/\s+(\S+)$/);
      const url = m ? normalizeInboxUrl(m[1]!) : null;
      if (!url) { lineErrors.push({ line, message: "falta el link de la bandeja al final (correo:contraseña https://mibalu.fun/buzon/…)." }); return; }
      inboxUrl = url;
      rest = rest.slice(0, m!.index).trim();
    }
    const idx = rest.indexOf(":");
    const email    = idx === -1 ? "" : rest.slice(0, idx).trim();
    const password = idx === -1 ? "" : rest.slice(idx + 1).trim();
    if (!email || !password) { lineErrors.push({ line, message: "debe tener el formato correo:contraseña." }); return; }
    pairs.push({ email, password, ...(inboxUrl ? { inboxUrl } : {}), ...(totpSecret ? { totpSecret } : {}) });
  });

  if (lineErrors.length > 0) {
    res.status(400).json({
      message: "Revisa estas líneas (no se creó ninguna cuenta):\n" + lineErrors.map(e => `Línea ${e.line}: ${e.message}`).join("\n"),
      errors: lineErrors,
    });
    return;
  }
  if (pairs.length === 0) {
    res.status(400).json({ message: "Pega al menos una línea correo:contraseña." });
    return;
  }

  const hasProfiles = getCatalogProductByPlatform(platform)?.hasProfiles ?? true;

  const accounts = createAccountsBulk({
    platform, provider: typeof provider === "string" ? provider : "",
    hasProfiles, expiresAt, pairs,
    codeSource,
    providerRenewalEnabled:  !!providerRenewalEnabled,
    providerRenewalCost:     typeof providerRenewalCost === "string" ? providerRenewalCost : "",
    providerRenewalCurrency: typeof providerRenewalCurrency === "string" ? providerRenewalCurrency : "USDT",
    providerRenewalNextDate: providerRenewalNextDate ?? null,
  });

  // «🔑 Código» compartido por correo: la cuenta nueva sin código toma el de
  // otra con el mismo correo; si trae uno, pasa a todas las de ese correo.
  for (const a of accounts) {
    if (!a.codeSource) { inheritCodeConfigFromSiblings(a.id); continue; }
    setAccountCodesEnabled(a.id, true);
    setAccountCodeSource(a.id, a.codeSource);
    setAccountTotpSecret(a.id, a.totpSecret);
    setAccountCodeInboxUrl(a.id, a.codeInboxUrl || null);
  }

  res.status(201).json({ accounts: accounts.map(a => withStatus(getAccountById(a.id)!)) });
});

router.get("/accounts/:id", (req, res) => {
  const account = getAccountById(Number(req.params.id));
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  // Para el "Avisar a los N clientes con suscripción vigente" de Editar cuenta.
  res.json({ account: withStatus(account), activeClientCount: listActiveSubscribers(account.id).length, codeSiblings: countCodeSiblings(account.id) });
});

// Editar cuenta — si cambió el correo (reemplazo de cuenta) o solo la
// contraseña, se avisa solo a los clientes con suscripción vigente, por la
// campanita (ver notifyActiveSubscribers). body.notifyClients: false = no
// avisar (por defecto sí). Cambiar la contraseña ya cumple el "Cuentas por
// cambiar contraseña" de Renovaciones.
router.put("/accounts/:id", (req, res) => {
  const {
    platform, email, password, provider, expiresAt, link, notes,
    providerRenewalCost, providerRenewalCurrency, providerRenewalNextDate,
  } = req.body ?? {};
  const id = Number(req.params.id);
  // Plataformas del cerebro: el aviso viejo de pago al proveedor queda apagado.
  const current = getAccountById(id);
  const providerRenewalEnabled = req.body?.providerRenewalEnabled === undefined ? undefined
    : (!!req.body.providerRenewalEnabled && !isBrainPlatform(platform ?? current?.platform));

  if (expiresAt !== undefined && expiresAt !== null && !DATE_RE.test(expiresAt)) {
    res.status(400).json({ message: "Fecha inválida, usa YYYY-MM-DD." });
    return;
  }
  if (providerRenewalEnabled) {
    if (!providerRenewalCost?.trim()) { res.status(400).json({ message: "Falta el costo de la renovación con el proveedor." }); return; }
    if (!providerRenewalNextDate || !DATE_RE.test(providerRenewalNextDate)) {
      res.status(400).json({ message: "Falta la próxima fecha de renovación con el proveedor." });
      return;
    }
  }

  const before = getAccountById(id);
  if (!before) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  const account = updateAccount(id, {
    platform, email, password, provider, expiresAt, link, notes,
    ...(providerRenewalEnabled !== undefined ? { providerRenewalEnabled: !!providerRenewalEnabled } : {}),
    ...(typeof providerRenewalCost === "string" ? { providerRenewalCost } : {}),
    ...(typeof providerRenewalCurrency === "string" ? { providerRenewalCurrency } : {}),
    ...(providerRenewalNextDate !== undefined ? { providerRenewalNextDate } : {}),
  });
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }

  // Pasó a otro correo (o plataforma) que ya tiene «🔑 Código»: toma ese.
  const sameKey = (x: { platform: string; email: string }) => x.platform.trim().toUpperCase() + "|" + x.email.trim().toLowerCase();
  if (sameKey(before) !== sameKey(account)) inheritCodeConfigFromSiblings(id, true);

  if (before.password !== account.password) markPasswordChanged(id);
  const notice = accountNoticeFor(before, account);
  const notified = notice && req.body?.notifyClients !== false ? notifyActiveSubscribers(id, notice) : 0;
  res.json({ account: withStatus(getAccountById(id)!), notice, notified });
});

router.delete("/accounts/:id", (req, res) => {
  deleteAccount(Number(req.params.id));
  res.json({ ok: true });
});

// ── PEDIDO (combo) — venta manual de varias plataformas a un solo
// cliente de una vez, para armar combos por WhatsApp sin mandar los
// perfiles uno por uno. Vende de verdad (ocupa perfiles reales). ──

router.post("/combo-order", (req, res) => {
  const { phone, platforms } = req.body ?? {};
  const digits = String(phone ?? "").replace(/\D/g, "");

  if (!digits) { res.status(400).json({ message: "Falta el teléfono del cliente." }); return; }
  if (!Array.isArray(platforms) || platforms.length === 0) {
    res.status(400).json({ message: "Elige al menos una plataforma." });
    return;
  }

  if (platforms.length > 30) { res.status(400).json({ message: "Máximo 30 perfiles por pedido." }); return; }

  const orderRef = "COMBO-" + digits + "-" + Date.now();
  const sold: SoldProfile[] = [];
  const failed: string[] = [];
  // Varios perfiles de la misma plataforma (cantidad ×2, ×3…): salen de la
  // misma cuenta mientras le queden perfiles libres.
  const lastAccount = new Map<string, number>();

  for (const platform of platforms) {
    if (typeof platform !== "string" || !platform.trim()) continue;
    const key = platform.trim().toUpperCase();
    const result = sellProfile(platform, digits, orderRef, lastAccount.get(key) ?? null);
    if (result) { sold.push(result); lastAccount.set(key, result.accountId); } else failed.push(platform);
  }

  res.status(sold.length > 0 ? 201 : 409).json({ orderRef, sold, failed });
});

// ── RENOVACIÓN CON PROVEEDOR (Pagos > Renovaciones) ──

router.get("/provider-renewals", (_req, res) => {
  res.json({ accounts: listProviderRenewalAccounts().filter(a => !isBrainPlatform(a.platform)) });
});

router.post("/accounts/:id/provider-renewal/mark-renewed", (req, res) => {
  const account = markProviderRenewalRenewed(Number(req.params.id));
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada o sin fecha de renovación." }); return; }
  res.json({ account });
});

// «↺ 30 días»: la cuenta vuelve a vencer en 30 días desde hoy (para el stock
// que no se vendió a tiempo). Sin aviso a clientes ni registro de renovación.
router.post("/accounts/:id/reset-expiry", (req, res) => {
  const id = Number(req.params.id);
  const current = getAccountById(id);
  if (!current) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  const target = addDaysISO(limaTodayISO(), 30);
  if (current.expiresAt && current.expiresAt > target) { res.status(400).json({ message: "Esta cuenta ya vence en más de 30 días." }); return; }
  const account = setAccountExpiry(id, target);
  res.json({ account: withStatus(account!) });
});

// «⧉ Duplicar»: copia la cuenta con todos los perfiles libres.
router.post("/accounts/:id/duplicate", (req, res) => {
  const src = getAccountById(Number(req.params.id));
  if (!src) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  const hasProfiles = getCatalogProductByPlatform(src.platform)?.hasProfiles ?? src.hasProfiles;
  const account = duplicateAccount(src.id, hasProfiles);
  res.status(201).json({ account: withStatus(account!) });
});

router.post("/accounts/:id/renew", (req, res) => {
  const account = renewAccount(Number(req.params.id));
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  res.json({ account: withStatus(account) });
});

// ── RENOVADOS (Pagos > Renovaciones) — cuentas con perfiles donde algún
// cliente ya pagó su renovación. La cuenta entera NO suma días sola: el
// admin confirma cuando ya la renovó con el proveedor, o les manda a los
// que pagaron otra cuenta. Ver confirmCycleRenewal en access.service.ts. ──

router.get("/cycle-renewals", (_req, res) => {
  res.json({ accounts: listCycleRenewalsAwaitingConfirmation() });
});

// Para las tarjetas del Resumen.
router.get("/cycle-renewals/summary", (_req, res) => {
  const awaiting = listCycleRenewalsAwaitingConfirmation();
  res.json({
    worthRenewing: awaiting.filter(a => a.worthRenewing).length,
    pendingNewAccounts: countPendingAssignments(),
  });
});

// ── PENDIENTES DE CUENTA NUEVA (Accesos) ──
router.get("/pending-assignments", (_req, res) => {
  res.json({ pending: listPendingAssignments() });
});

router.post("/pending-assignments/assign", (_req, res) => {
  res.json(assignPendingClients());
});

router.post("/cycle-renewals/:id/confirm", (req, res) => {
  const result = confirmCycleRenewal(Number(req.params.id));
  if (!result.ok) return res.status(409).json({ message: result.error });
  res.json(result);
});

// Cuentas de la misma plataforma con cupos libres suficientes para mover
// a todos los que pagaron, y que les duren al menos 28 de sus 30 días (ver
// minTargetExpiry).
router.get("/cycle-renewals/:id/candidates", (req, res) => {
  const pending = listCycleRenewalsAwaitingConfirmation().find(a => a.id === Number(req.params.id));
  if (!pending) return res.status(404).json({ message: "Esta cuenta ya no tiene renovaciones por confirmar." });
  const floor = pending.newExpiresAt ? minTargetExpiry(pending.newExpiresAt) : limaTodayISO();
  res.json({ accounts: listAccountsWithFreeProfiles(pending.platform, pending.renewing.length, floor).filter(a => a.id !== pending.id) });
});

// Mueve a los que pagaron a otra cuenta (del stock o escrita a mano), ya con
// su fecha nueva (+30 días desde el vencimiento actual). Los que no pagaron
// se quedan en la cuenta vieja hasta que venza.
router.post("/cycle-renewals/:id/send-new", (req, res) => {
  const pending = listCycleRenewalsAwaitingConfirmation().find(a => a.id === Number(req.params.id));
  if (!pending || !pending.newExpiresAt) return res.status(404).json({ message: "Esta cuenta ya no tiene renovaciones por confirmar." });

  const targetAccountId = Number(req.body?.targetAccountId) || 0;
  const newEmail    = String(req.body?.newEmail ?? "").trim();
  const newPassword = String(req.body?.newPassword ?? "").trim();
  if (!targetAccountId && !newEmail) return res.status(400).json({ message: "Elige una cuenta del stock o escribe el correo de la cuenta nueva." });

  const target = targetAccountId ? getAccountById(targetAccountId) : null;
  if (targetAccountId && !target) return res.status(404).json({ message: "La cuenta elegida ya no existe." });
  const email    = target ? target.email : newEmail;
  const password = target ? target.password : newPassword;
  const expiresAt = pending.newExpiresAt;

  try {
    for (const p of pending.renewing) {
      const base = { clientPhone: p.clientPhone, platform: pending.platform, email: pending.email, wholesalerId: p.wholesalerId, expiresAt };
      if (target) replaceClientAccount({ ...base, targetAccountId: target.id });
      else replaceClientAccountManual({ ...base, newEmail, newPassword, newProfileName: p.profileName, newProvider: "" });
    }
  } catch (err: any) {
    return res.status(400).json({ message: err?.message || "No se pudo enviar la cuenta nueva." });
  }

  const detail = `📧 Correo: ${email}` + (password ? `\n🔑 Contraseña: ${password}` : "") +
    `\n📅 Vence: ${expiresAt}\n\n¡Tu renovación ya está activa! Cualquier inconveniente, estamos atentos. 😊`;
  for (const p of pending.renewing) {
    if (p.wholesalerId != null) createWholesalerNotification(p.wholesalerId, "account_replaced", pending.platform, email, detail);
    else createCustomerNotification(p.clientPhone, "account_replaced", pending.platform, email, detail);
  }
  res.json({ ok: true, moved: pending.renewing.length, email, expiresAt });
});

// ── CAMBIAR CUENTA (Accesos) — sin reporte de por medio: cuando se cae una
// cuenta, el cliente pasa a otra nueva (perfil libre) o a una en uso
// (temporal, sin ocupar perfil). Misma lógica que «Reemplazar» de Soportes. ──
function profileReplaceSubject(profileId: number): ReplaceSubject | null {
  const row = db.prepare(`
    SELECT p.client_phone AS clientPhone, p.wholesaler_id AS wholesalerId, a.platform AS platform, a.email AS email
    FROM access_profiles p JOIN access_accounts a ON a.id = p.account_id WHERE p.id = ?
  `).get(profileId) as { clientPhone: string; wholesalerId: number | null; platform: string; email: string } | undefined;
  if (!row || !row.clientPhone) return null;
  return { clientPhone: row.clientPhone, platform: row.platform, accountEmail: row.email, wholesalerId: row.wholesalerId ?? null };
}

router.get("/profiles/:id/replace-options", (req, res) => {
  const subject = profileReplaceSubject(Number(req.params.id));
  if (!subject) return res.status(404).json({ message: "Ese perfil ya no tiene cliente." });
  res.json(replaceOptionsFor(subject));
});

router.post("/profiles/:id/replace", (req, res) => {
  const subject = profileReplaceSubject(Number(req.params.id));
  if (!subject) return res.status(404).json({ message: "Ese perfil ya no tiene cliente." });
  const mode = req.body?.mode === "shared" ? "shared" : "fresh";
  const targetAccountId = Number(req.body?.targetAccountId);
  if (!targetAccountId) return res.status(400).json({ message: "Elige la cuenta nueva." });
  const result = replaceClientTo(subject, mode, targetAccountId, String(req.body?.profileName ?? ""));
  if (!result.ok) return res.status(400).json({ message: result.message });
  res.json(result);
});

// Cambiar de nuevo a un cliente que está en una cuenta «en uso» (temporal):
// a un perfil libre (queda fijo) o a otra cuenta en uso. Mismo flujo que
// /profiles/:id/replace; el origen es el reemplazo temporal.
function overrideReplaceSubject(id: number): ReplaceSubject | null {
  const o = getManualOverrideById(id);
  if (!o || !o.clientPhone) return null;
  return { clientPhone: o.clientPhone, platform: o.platform, accountEmail: o.email, wholesalerId: o.wholesalerId ?? null };
}

router.get("/overrides/:id/replace-options", (req, res) => {
  const subject = overrideReplaceSubject(Number(req.params.id));
  if (!subject) return res.status(404).json({ message: "Ese reemplazo ya no existe." });
  res.json(replaceOptionsFor(subject));
});

router.post("/overrides/:id/replace", (req, res) => {
  const subject = overrideReplaceSubject(Number(req.params.id));
  if (!subject) return res.status(404).json({ message: "Ese reemplazo ya no existe." });
  const mode = req.body?.mode === "shared" ? "shared" : "fresh";
  const targetAccountId = Number(req.body?.targetAccountId);
  if (!targetAccountId) return res.status(400).json({ message: "Elige la cuenta nueva." });
  const result = replaceClientTo(subject, mode, targetAccountId, String(req.body?.profileName ?? ""));
  if (!result.ok) return res.status(400).json({ message: result.message });
  res.json(result);
});

// ── CÓDIGOS — marcar cuenta, ver últimos códigos, resetear pedidos ──
// (prueba: solo habilitado en liordark.com para el celular de test, ver
// src/routes/store.routes.ts / codes.service.ts — acá el toggle ya
// funciona para cualquier cuenta, sin restricción, para poder probarlo).

router.post("/accounts/:id/codes-enabled", (req, res) => {
  const accountId = Number(req.params.id);
  const enabled   = req.body?.enabled === true;
  if (!getAccountById(accountId)) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  setAccountCodesEnabled(accountId, enabled);
  res.json({ account: withStatus(getAccountById(accountId)!) });
});

// «Mayorista ve todos los códigos» de esta cuenta (sin filtros).
router.post("/accounts/:id/codes-unfiltered", (req, res) => {
  const accountId = Number(req.params.id);
  if (!getAccountById(accountId)) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  setAccountCodesUnfiltered(accountId, req.body?.unfiltered === true);
  res.json({ account: withStatus(getAccountById(accountId)!) });
});

// Cuál página externa usar para sacar el código de esta cuenta (ver
// services/codes-lookup.service.ts). null = la quita.
router.post("/accounts/:id/code-source", (req, res) => {
  const accountId = Number(req.params.id);
  const sourceId   = req.body?.codeSource ? String(req.body.codeSource) : null;
  if (!getAccountById(accountId)) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  setAccountCodeSource(accountId, sourceId);
  res.json({ account: withStatus(getAccountById(accountId)!) });
});

// Clave secreta de 2FA (TOTP) de esta cuenta (ver utils/totp.util.ts).
// null = la quita. Independiente de code-source — una cuenta usa UNO de
// los dos mecanismos.
router.post("/accounts/:id/totp-secret", (req, res) => {
  const accountId = Number(req.params.id);
  if (!getAccountById(accountId)) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  const raw = typeof req.body?.totpSecret === "string" ? req.body.totpSecret.trim() : "";
  // Se guarda ya limpia (sin espacios ni guiones, en mayúsculas).
  const secret = raw ? normalizeTotpSecret(raw) : null;
  if (raw && !secret) { res.status(400).json({ message: TOTP_SECRET_INVALID_MESSAGE }); return; }
  setAccountTotpSecret(accountId, secret);
  res.json({ account: withStatus(getAccountById(accountId)!) });
});

// Link privado de la bandeja del proveedor (Juanpa: https://…/buzon/<id>).
// '' o null = lo quita. Nunca se le muestra al cliente.
router.post("/accounts/:id/code-inbox-url", (req, res) => {
  const accountId = Number(req.params.id);
  if (!getAccountById(accountId)) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  const raw = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!raw) { setAccountCodeInboxUrl(accountId, null); res.json({ account: withStatus(getAccountById(accountId)!) }); return; }
  const url = normalizeInboxUrl(raw);
  if (!url) { res.status(400).json({ message: "El link de la bandeja debe ser como https://mibalu.fun/buzon/…" }); return; }
  setAccountCodeInboxUrl(accountId, url);
  res.json({ account: withStatus(getAccountById(accountId)!) });
});

router.get("/code-sources", (_req, res) => {
  res.json({ sources: listCodeSources().map(s => ({ ...s, watched: LIST_SOURCES.includes(s.id) })) });
});

// ── BANDEJA DE CÓDIGOS (ver services/codes-brain.service.ts) ──

router.get("/codes/inbox", (req, res) => {
  res.json({
    items: listInbox({
      limit: Number(req.query.limit) || 150,
      q: typeof req.query.q === "string" ? req.query.q : "",
      sourceId: typeof req.query.source === "string" && req.query.source ? req.query.source : "",
      onlyCodes: req.query.onlyCodes === "1",
    }),
    watcher: watcherInfo(),
  });
});

router.get("/codes/inbox/:id", (req, res) => {
  const found = getInboxHtml(Number(req.params.id));
  if (!found) { res.status(404).json({ message: "Ese correo ya no está en la bandeja." }); return; }
  res.json(found);
});

router.get("/codes/health", (_req, res) => {
  res.json({ sources: sourcesHealth(), watcher: watcherInfo(), lanes: lanesStatus() });
});

// Pedidos de código de los clientes (pendientes primero) y la fila de cada proveedor.
router.get("/codes/requests", (req, res) => {
  res.json({ requests: listCodeRequests(Number(req.query.hours) || 24), lanes: lanesStatus(), typical: typicalArrivalSeconds() });
});

// «Revisar ya»: el pedido pasa adelante en su turno.
router.post("/codes/requests/:token/now", (req, res) => {
  rushRequest(String(req.params.token));
  res.json({ ok: true });
});

router.get("/codes/activity", (req, res) => {
  res.json({ rows: listActivity({ limit: Number(req.query.limit) || 150, onlyProblems: req.query.problems === "1" }) });
});

// «Revisar ahora» del vigilante (no espera a los 2 minutos).
router.post("/codes/watch-now", async (_req, res) => {
  const { checked } = await runCodeWatch();
  res.json({ checked, watcher: watcherInfo() });
});

router.get("/codes", (_req, res) => {
  // Varias cuentas suelen compartir el mismo login (ej. ChatGPT, una por
  // cliente) — el código es el mismo para todas, así que se muestra una
  // fila por correo+fuente en vez de repetirla. La fila usa la primera
  // cuenta del grupo para "Consultar", y el código más reciente de todas.
  const groups = new Map<string, ReturnType<typeof listCodesEnabledAccounts>>();
  for (const a of listCodesEnabledAccounts()) {
    const key = [a.email.trim().toLowerCase(), a.codeSource ?? "", a.totpSecret ?? ""].join("|");
    const group = groups.get(key);
    if (group) group.push(a); else groups.set(key, [a]);
  }

  const accounts = [...groups.values()].map(group => {
    const a = group[0]!;
    const { totpSecret, ...rest } = a;
    const latestCodeRaw = group
      .map(g => getLatestCodeForAccount(g.id))
      .filter(c => c !== null)
      .sort((x, y) => y.receivedAt.localeCompare(x.receivedAt))[0] ?? null;
    // El admin ve todo lo que llega; se marca lo que el cliente NO recibe.
    const latestCode = latestCodeRaw ? { ...latestCodeRaw, adminOnly: adminOnlyValue(a.codeSource, latestCodeRaw.code) } : null;
    return {
      ...rest,
      accountCount: group.length,
      codeSourceLabel: codeSourceLabel(a.codeSource),
      latestCode,
      // Si la fuente tiene sub-acciones (ej. "PallyStore con opciones"),
      // el admin elige puntualmente cuál consultar en vez de probarlas
      // todas a ciegas — null si la fuente no las tiene.
      sourceActions: listSourceActions(a.codeSource),
      // 2FA por TOTP — se calcula al vuelo, sin consultar nada externo.
      // No se manda la clave en sí, solo el código ya calculado.
      hasTotp: !!totpSecret,
      totp: totpSecret ? safeTotp(totpSecret, a.id) : null,
    };
  });
  res.json({ accounts });
});

// Buscador libre del tab "🔑 Códigos" — solo el correo, no hace falta
// elegir plataforma ni que esté dado de alta como cuenta en Accesos:
// prueba todas las fuentes configuradas, reintentando hasta ~1 minuto
// (el correo puede tardar en llegar), sin filtrar por dígitos: el admin
// ve todo.
router.post("/codes/lookup", async (req, res) => {
  const email = String(req.body?.email || "").trim();
  if (!email) { res.status(400).json({ message: "Falta el correo." }); return; }

  const found = await withLookupContext({ origin: "busqueda" }, () => lookupAnySourceWithRetries(email, getLastSeenCodeForEmail(email)));
  if (!found) { res.json({ found: false, kind: null, value: null, sourceLabel: null, approval: null }); return; }

  res.json({
    found: true, kind: found.result.kind, value: found.result.value, sourceLabel: found.label,
    ...lookupExtras(found.sourceId, email, found.result),
  });
});

// Lo que la búsqueda rápida de Códigos muestra junto al resultado: la
// solicitud de inicio de sesión de Netflix (Aprobar / Rechazar), cuándo
// llegó el correo y su id en la bandeja (para «Ver correo»).
function lookupExtras(sourceId: string, email: string, result: CodeLookupResult) {
  const inbox = inboxInfoFor(sourceId, email, result);
  // «🔒 Solo admin»: llegó y lo ves tú, pero al cliente no se le entrega
  // (ej. Netflix 6 dígitos o cambio de datos).
  const adminOnly = result.found && (isAdminOnlyResult(sourceId, result) || (!deliversEverything(sourceId) && isAccountChangeResult(result)));
  const received = parseProviderDate(result.providerReceivedAt);
  return {
    approval: loginApprovalOf(result),
    receivedAt: result.providerReceivedAt ?? null,
    receivedIso: received && !Number.isNaN(received.getTime()) ? received.toISOString() : inbox.seenIso,
    inboxId: inbox.inboxId,
    adminOnly,
    repeated: !!result.repeated,
    // Los últimos 4 correos de la bandeja en fila (el nuevo + los 3 de antes).
    recent: recentInboxMails(sourceId, email, result),
  };
}

/** Un código guardado (solo su valor): ¿lo recibiría el cliente? */
function adminOnlyValue(sourceId: string | null, value: string): boolean {
  if (!sourceId || !value) return false;
  const isLink = /^https?:\/\//i.test(value);
  return isAdminOnlyResult(sourceId, { found: true, kind: isLink ? "link" : "code", value });
}

// "Consultar" de una cuenta puntual (lista de abajo del tab Códigos) —
// reintenta hasta ~1 minuto (no basta un solo intento, el correo puede
// tardar en llegar), sin filtrar por cantidad de dígitos: el admin ve
// todo. Si la fuente tiene sub-acciones (ver listSourceActions),
// body.actionId dice cuál puntual consultar — si no se manda, cae a la
// consulta normal (prueba todas).
router.post("/codes/:accountId/lookup-now", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const account = getAccountById(accountId);
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  if (!account.codeSource) { res.status(409).json({ message: "Esta cuenta no tiene fuente de códigos configurada." }); return; }
  if (account.codeSource === TOTP_SOURCE_ID) { res.status(409).json({ message: "Esta cuenta usa 2FA: falta pegar la clave secreta en Accesos > Editar cuenta." }); return; }

  // Netflix por Pally con opciones: UNA opción por consulta (código o link).
  const actionId = account.codeSource === "netflix_con_opciones"
    ? (req.body?.actionId === "link_login" ? "link_login" : "codigo_login")
    : (typeof req.body?.actionId === "string" ? req.body.actionId : undefined);
  const exclude = skipsRepeatedCodes(account.codeSource) ? getLastSeenCodeForEmail(account.email) : null;
  // Pally ya espera el correo por su cuenta (10–40 s): una sola consulta.
  // Bandejas (Juanpa, Gralexander): 4 intentos ≈ 40 s, bajo el minuto que
  // nginx espera al panel (6 intentos pasaban de 60 s y salía error 504).
  const attempts = laneIdOf(account.codeSource) === "pally" ? 1 : LIST_SOURCES.includes(account.codeSource) ? 4 : undefined;
  let result = await withLookupContext({ origin: "panel", accountId },
    () => lookupCodeActionWithRetries(account.codeSource!, account.email, actionId, exclude, attempts));
  // El admin ve TODO lo que llega (6 dígitos, cambio de datos…); en la
  // respuesta va marcado «adminOnly» si al cliente no se le entrega.
  if (result.found && result.value && !result.repeated) {
    const snippet = result.providerReceivedAt ? `Recibido: ${result.providerReceivedAt}` : "";
    saveIncomingCode({ accountId, code: result.value, snippet, source: "external" });
  }
  res.json({
    found: result.found, kind: result.kind, value: result.value, sourceLabel: codeSourceLabel(account.codeSource),
    ...lookupExtras(account.codeSource, account.email, result),
  });
});

// Renovar en dos pasos: "Renovar" solo marca pendiente de pago (no toca el
// vencimiento) — recién /renew de arriba, llamado desde "Confirmar pago",
// suma los 30 días de verdad. Sirve para no perder registro de si el
// cliente ya pagó antes de extender la cuenta.
router.post("/accounts/:id/renewal-pending", (req, res) => {
  const account = setRenewalPending(Number(req.params.id), true);
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  res.json({ account: withStatus(account) });
});

router.post("/accounts/:id/renewal-pending/cancel", (req, res) => {
  const account = setRenewalPending(Number(req.params.id), false);
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  res.json({ account: withStatus(account) });
});

// ── PERFILES (solo el teléfono del cliente — el resto vive en la cuenta) ──

// Por qué el cliente NO vería «Códigos» en liordark.com con esta cuenta (o
// null si sí los ve). Sin «🔑 Código» solo se avisa si esa plataforma suele
// tenerlo (otra cuenta de la misma plataforma lo tiene), para no molestar
// con plataformas que no usan códigos.
function clientCodesWarning(accountId: number): string | null {
  const a = getAccountById(accountId);
  if (!a) return null;
  if (!a.codesEnabled || !a.codeSource) {
    const usual = db.prepare(`SELECT 1 FROM access_accounts WHERE upper(platform) = upper(?) AND codes_enabled = 1 AND code_source IS NOT NULL AND id <> ? LIMIT 1`).get(a.platform, a.id);
    return usual ? "Esta cuenta no tiene «🔑 Código» activado: el cliente no verá Códigos en liordark.com hasta que lo actives (⋯ › Editar cuenta)." : null;
  }
  if (!a.expiresAt) return "Esta cuenta no tiene fecha de vencimiento: el cliente no verá Códigos hasta que la pongas (⋯ › Editar cuenta › Vencimiento).";
  if (a.expiresAt < limaTodayISO()) return "Esta cuenta está vencida: el cliente no verá Códigos hasta que la renueves.";
  return null;
}

router.put("/profiles/:id", (req, res) => {
  const { clientPhone } = req.body ?? {};
  if (!clientPhone?.trim()) { res.status(400).json({ message: "El teléfono es obligatorio." }); return; }

  const before = getProfileById(Number(req.params.id));
  const profile = assignProfileClient(Number(req.params.id), clientPhone);
  if (!profile) { res.status(404).json({ message: "Perfil no encontrado." }); return; }
  // Cerebro: cliente NUEVO en el perfil → su propia fecha según el plan
  // elegido (1 mes por defecto). Si solo se corrigió el celular, la conserva.
  const account = getAccountById(profile.accountId);
  if (account && isBrainPlatform(account.platform) && !before?.clientPhone) {
    const months = Number(req.body?.months) || 1;
    const plan = planFor(account.platform, months);
    setNewClientDate(profile.id, plan ? plan.days : months * 30, plan ? plan.months : months);
  }
  res.json({ profile: getProfileById(profile.id), codesWarning: clientCodesWarning(profile.accountId) });
});

// ── CEREBRO (Pagos › Renovaciones y Accesos) ──

router.get("/brain", (_req, res) => {
  res.json(brainOverview());
});

router.post("/brain/run", (_req, res) => {
  // Igual que las 10 pm: el cerebro y después el corte de las plataformas
  // que no son del cerebro (y los «Pendientes de cuenta nueva»).
  const plan = runBrain("manual");
  let cutover: ReturnType<typeof runRenewalCutover> | null = null;
  try { cutover = runRenewalCutover(); } catch (err: any) { console.error("⚠️ Corte de renovación:", err?.message); }
  res.json({ plan, cutover, overview: brainOverview() });
});

// «✅ Ya la renové» con el proveedor: la cuenta suma 30 días (los clientes no cambian).
router.post("/accounts/:id/provider-renewed", (req, res) => {
  const r = markProviderRenewed(Number(req.params.id));
  if (!r.ok) { res.status(404).json({ message: r.message }); return; }
  res.json({ ok: true, expiresAt: r.expiresAt, account: withStatus(getAccountById(Number(req.params.id))!) });
});

// «🔒 Perfiles con PIN» en una cuenta.
// ⏸ / ▶ Venta: con la venta en pausa la cuenta no se ofrece a nadie (tienda,
// bot, mayoristas, combos, cerebro); sus clientes siguen igual.
router.post("/accounts/:id/sale", (req, res) => {
  const id = Number(req.params.id);
  if (!setAccountSalePaused(id, req.body?.paused === true)) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  emitDashboardEvent({ type: "stock_changed" });
  res.json({ account: withStatus(getAccountById(id)!) });
});

router.post("/accounts/:id/pin-mode", (req, res) => {
  const id = Number(req.params.id);
  if (!getAccountById(id)) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  setAccountPinMode(id, req.body?.on === true);
  res.json({ account: withStatus(getAccountById(id)!) });
});

// PIN de un perfil (4 a 6 dígitos). Quita el «PIN por cambiar».
router.post("/profiles/:id/pin", (req, res) => {
  // «Dejar igual»: quita el aviso «¿cambiar PIN?» sin tocar el PIN.
  if (req.body?.keep === true) {
    const kept = dismissPinReminder(Number(req.params.id));
    if (!kept) { res.status(404).json({ message: "Perfil no encontrado." }); return; }
    res.json({ profile: kept });
    return;
  }
  const pin = String(req.body?.pin ?? "").trim();
  const current = getProfileById(Number(req.params.id));
  const platform = current ? (getAccountById(current.accountId)?.platform ?? "") : "";
  if (pin && !validPinFor(platform, pin)) {
    res.status(400).json({ message: pinLengthFor(platform) === 5 ? "En Prime Video el PIN tiene 5 números." : "El PIN debe tener de 4 a 6 números." });
    return;
  }
  const profile = setProfilePin(Number(req.params.id), pin);
  if (!profile) { res.status(404).json({ message: "Perfil no encontrado." }); return; }
  res.json({ profile });
});

// PIN de TODOS los perfiles de una cuenta (prende «Perfiles con PIN»):
//  · { pins: ["1234", "-", …] } → en orden de perfil; «-» o vacío = dejarlo igual.
//  · { generate: "empty" | "all" } → al azar: 4 números (Prime Video: 5),
//    solo a los que no tienen PIN o a todos.
// A los clientes cuyo PIN cambió les llega aviso por su campanita.
router.post("/accounts/:id/pins", (req, res) => {
  const id = Number(req.params.id);
  const account = getAccountById(id);
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  if (!account.hasProfiles) { res.status(400).json({ message: "Esta cuenta no tiene perfiles." }); return; }
  const profiles = [...account.profiles].sort((a, b) => a.slotNumber - b.slotNumber);
  const len = pinLengthFor(account.platform);
  const entries: { profileId: number; pin: string }[] = [];

  if (Array.isArray(req.body?.pins)) {
    const pins = (req.body.pins as unknown[]).map(x => String(x ?? "").trim());
    if (pins.length > profiles.length) { res.status(400).json({ message: `Escribiste ${pins.length} PIN y la cuenta tiene ${profiles.length} perfiles.` }); return; }
    for (let i = 0; i < pins.length; i++) {
      const pin = pins[i]!;
      if (!pin || pin === "-") continue;
      if (!validPinFor(account.platform, pin)) {
        res.status(400).json({ message: `El PIN n.º ${i + 1} («${pin}») no sirve: ${len === 5 ? "en Prime Video son 5 números" : "deben ser de 4 a 6 números"}.` });
        return;
      }
      entries.push({ profileId: profiles[i]!.id, pin });
    }
  } else if (req.body?.generate === "empty" || req.body?.generate === "all") {
    const all = req.body.generate === "all";
    const taken = new Set(all ? [] : profiles.map(p => p.pin).filter(Boolean));
    for (const p of profiles) {
      if (!all && p.pin) continue;
      const pin = randomPin(len, taken);
      taken.add(pin);
      entries.push({ profileId: p.id, pin });
    }
  } else {
    res.status(400).json({ message: "Faltan los PIN." });
    return;
  }

  const updated = setAccountPins(id, entries);
  res.json({ changed: entries.length, profiles: updated.map(p => ({ id: p.id, name: p.profileName || ("Perfil " + p.slotNumber), pin: p.pin, client: !!p.clientPhone })) });
});

// Fecha propia del cliente: «➕ días» (renovación cobrada a mano) o una
// fecha exacta (corrección). Solo plataformas del cerebro.
router.post("/profiles/:id/client-date", (req, res) => {
  const profile = getProfileById(Number(req.params.id));
  if (!profile || !profile.clientPhone) { res.status(404).json({ message: "Ese perfil no tiene cliente." }); return; }
  const account = getAccountById(profile.accountId);
  if (!account || !isBrainPlatform(account.platform)) { res.status(400).json({ message: "Esta plataforma no maneja fecha por cliente." }); return; }
  const days = Number(req.body?.addDays);
  const date = String(req.body?.date ?? "").trim();
  let newDate: string | null = null;
  if (Number.isFinite(days) && days > 0 && days <= 400) {
    newDate = extendClientDate(profile.id, Math.round(days));
    if (newDate) {
      if (profile.wholesalerId !== null) createWholesalerNotification(profile.wholesalerId, "renewal_active", account.platform, account.email);
      else createCustomerNotification(profile.clientPhone, "renewed", account.platform, account.email);
    }
  } else if (DATE_RE.test(date)) {
    setClientDate(profile.id, date);
    newDate = date;
  } else {
    res.status(400).json({ message: "Indica los días a sumar o la fecha (AAAA-MM-DD)." });
    return;
  }
  res.json({ ok: true, expiresAt: newDate, profile: getProfileById(profile.id) });
});

// «👤 Cuenta completa» — la cuenta entera (todos sus perfiles libres) pasa a
// un cliente normal (no mayorista). Queda como cuenta sin perfiles con su
// celular, igual que una cuenta completa de mayorista.
router.post("/accounts/:id/full-client", (req, res) => {
  const digits = String(req.body?.clientPhone ?? "").replace(/\D/g, "");
  if (digits.length < 9) { res.status(400).json({ message: "Escribe el celular del cliente (9 dígitos)." }); return; }
  const expiresAt = String(req.body?.expiresAt ?? "").trim();
  if (expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) { res.status(400).json({ message: "Fecha de vencimiento inválida." }); return; }

  const result = assignFullAccountToClient({ accountId: Number(req.params.id), clientPhone: digits, expiresAt: expiresAt || undefined });
  if (!result.ok) { res.status(result.status).json({ message: result.message }); return; }
  res.json({ account: result.account, codesWarning: clientCodesWarning(result.account.id) });
});

router.post("/profiles/:id/release", (req, res) => {
  const profile = releaseProfile(Number(req.params.id));
  if (!profile) { res.status(404).json({ message: "Perfil no encontrado." }); return; }
  res.json({ profile });
});

// Marcador manual — ¿el cliente confirmó que renueva? '' | 'yes' | 'no'.
// Puramente informativo para el admin, no afecta el vencimiento.
router.post("/profiles/:id/renewal", (req, res) => {
  const status = req.body?.status as RenewalStatus;
  if (!["", "yes", "no"].includes(status)) {
    res.status(400).json({ message: "Estado inválido." });
    return;
  }
  const profile = setProfileRenewal(Number(req.params.id), status);
  if (!profile) { res.status(404).json({ message: "Perfil no encontrado." }); return; }
  res.json({ profile });
});

// GET /profiles/:id/renewal-message — datos para armar a mano el mensaje
// de renovación (botón 💬 del panel) mientras no hay API de WhatsApp para
// mandarlo solo: el panel arma el texto y abre wa.me con todo ya escrito.
router.get("/profiles/:id/renewal-message", (req, res) => {
  const data = getProfileForRenewalMessage(Number(req.params.id));
  if (!data) { res.status(404).json({ message: "Perfil no encontrado." }); return; }
  res.json(data);
});

// GET /profiles/renewing — todos los clientes marcados "✅ Renueva", de
// cualquier cuenta, en un solo lugar (en vez de revisar cuenta por cuenta).
router.get("/profiles/renewing", (_req, res) => {
  res.json({ profiles: listRenewingProfiles() });
});

// GET /accounts/renewing — reemplaza el listado de arriba en el panel:
// la CUENTA completa es lo que se renueva (los perfiles sueltos se
// autogestionan solos, ver confirmRenewalLog en renewal-log.repository.ts).
router.get("/accounts/renewing", (_req, res) => {
  res.json({ accounts: listAccountsWithPendingRenewal() });
});

// ── CORTE AUTOMÁTICO DE CICLO (ver runRenewalCutover en access.service.ts) ──
// Corre solo una vez al día (index.ts), pero este endpoint deja dispararlo
// a mano desde el panel para una gestión puntual — es idempotente, no pasa
// nada si se llama varias veces.
router.post("/renewal-cutover/run", (_req, res) => {
  const result = runRenewalCutover();
  res.json({ ok: true, ...result });
});

// Cuentas a las que el admin todavía tiene que cambiarles la contraseña —
// se sacó a algún cliente que no renovó y no debe poder volver a entrar.
router.get("/password-change-pending", (_req, res) => {
  res.json({ accounts: listAccountsNeedingPasswordChange() });
});

// Al confirmar "✅ Ya la cambié" (Pagos > Renovaciones > Cuentas por
// cambiar contraseña) también se avisa de una vez a quien se quedó con la
// cuenta — mismo aviso que al cambiar la contraseña en "✏️ Editar cuenta":
// solo a los clientes con suscripción vigente, por la campanita.
router.post("/accounts/:id/password-changed", (req, res) => {
  const id = Number(req.params.id);
  if (!getAccountById(id)) return res.status(404).json({ message: "Cuenta no encontrada." });
  markPasswordChanged(id);
  res.json({ ok: true, notified: notifyActiveSubscribers(id, "password") });
});

// GET /renewal-history — registro permanente de renovaciones ya hechas
// (quién estaba en la cuenta al apretar "Renovar"), para el resumen
// exportable "Renovados — registro".
router.get("/renewal-history", (_req, res) => {
  res.json({ entries: listRenewalHistory() });
});

// ── ACTIVACIÓN MANUAL PENDIENTE (CANVA, GEMINI AI PRO, YOUTUBE PREMIUM)
// — se crea la cuenta sola en Accesos, pero alguien todavía tiene que ir
// a la plataforma real a invitar el correo / loguearse y activar el plan.
// Se muestra en "Pedidos pendientes" hasta que el admin la marca hecha. ──

router.get("/activation-pending", (_req, res) => {
  res.json({ pending: listPendingActivations() });
});

router.post("/activation-pending/:id/done", (req, res) => {
  markActivationDone(Number(req.params.id));
  res.json({ ok: true });
});

// ── BUSCADOR ──
// ?q= dígitos → busca cliente por teléfono (todas sus cuentas/perfiles)
// ?q= texto   → busca cuenta por correo

// ── LINK DE PAGO DE RENOVACIÓN (💬 Reno-manual) ──
// GET: las cuentas del cliente que pueden ir en el link (con precio y
// motivo si no se puede). POST: arma el link con las elegidas — vale
// hasta la medianoche de hoy (ver renewal-pay-links.repository.ts).
router.get("/renewal-pay-link/candidates", (req, res) => {
  const phone = String(req.query.phone ?? "").replace(/\D/g, "");
  if (phone.length < 9) { res.status(400).json({ message: "Celular inválido." }); return; }
  res.json({ candidates: listPayLinkCandidates(phone, daysLeft).map(c => ({ ...c, daysLeft: daysLeft(c.expiresAt) })) });
});

router.post("/renewal-pay-link", (req, res) => {
  const phone = String(req.body?.phone ?? "").replace(/\D/g, "");
  const keys: string[] = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : [];
  if (phone.length < 9) { res.status(400).json({ message: "Celular inválido." }); return; }
  if (keys.length === 0) { res.status(400).json({ message: "Elige al menos una cuenta." }); return; }

  const candidates = listPayLinkCandidates(phone, daysLeft);
  const chosen = candidates.filter(c => keys.includes(c.key));
  const blocked = chosen.filter(c => !c.eligible);
  if (chosen.length !== keys.length) { res.status(400).json({ message: "Alguna cuenta ya no es de este cliente. Vuelve a buscarlo." }); return; }
  if (blocked.length) { res.status(400).json({ message: `${blocked[0]!.label}: ${blocked[0]!.reason}.` }); return; }

  cleanOldPayLinks();
  const link = createPayLink(phone, chosen);
  res.json({
    code: link.code,
    url: "https://liordark.com/renovar.html?pack=" + link.code,
    expiresAt: link.expiresAt,
    ...priceSelection(link.items),
    items: link.items.map(i => ({ ...i, daysLeft: daysLeft(i.expiresAt) })),
  });
});

router.get("/search", (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) { res.json({ mode: "none", accounts: [], profiles: [] }); return; }

  const looksLikePhone = /^\+?[\d\s-]{6,}$/.test(q);

  if (looksLikePhone) {
    const profiles = searchProfilesByPhone(q).map(profileWithStatus);
    // Antes solo perfiles: al cambiar a un cliente a una cuenta «en uso»
    // (temporal) dejaba de salir aquí — la búsqueda decía que no tenía cuentas.
    const overrides = listManualOverridesByPhone(q).map(overrideWithStatus);
    // Vencidas (historial): solo los perfiles de ESTE cliente, debajo de las activas.
    const d9 = q.replace(/\D/g, "").slice(-9);
    const archived = searchArchivedAccounts(q).slice(0, 30).map(a => ({
      ...a, profiles: a.profiles.filter(p => String(p.clientPhone || "").replace(/\D/g, "").slice(-9) === d9),
    }));
    res.json({ mode: "phone", profiles, overrides, archived });
    return;
  }

  // Correo de un CLIENTE (el que registró en la tienda): se muestran sus
  // cuentas como si se hubiera buscado su celular. Sirve cuando alguien
  // escribe por WhatsApp y solo da su correo.
  const customer = q.includes("@") ? findCustomerByEmail(q) : null;
  if (customer) {
    const d9 = customer.phone.replace(/\D/g, "").slice(-9);
    const profiles = searchProfilesByPhone(customer.phone).map(profileWithStatus);
    const overrides = listManualOverridesByPhone(customer.phone).map(overrideWithStatus);
    const archived = searchArchivedAccounts(customer.phone).slice(0, 30).map(a => ({
      ...a, profiles: a.profiles.filter(p => String(p.clientPhone || "").replace(/\D/g, "").slice(-9) === d9),
    }));
    res.json({ mode: "phone", profiles, overrides, archived, customer: { email: customer.email, phone: customer.phone } });
    return;
  }

  const accounts = searchAccountsByEmail(q).map(withStatus);
  res.json({ mode: "email", accounts, archived: searchArchivedByEmail(q) });
});

export default router;
