import { Router } from "express";
import { replaceClientAccount, replaceClientAccountManual, listAccountsWithFreeProfiles } from "../db/access.repository";
import {
  createAccountsBulk,
  updateAccount,
  deleteAccount,
  getAccountById,
  listPlatforms,
  listAccountsByPlatform,
  assignProfileClient,
  releaseProfile,
  setProfileRenewal,
  searchAccountsByEmail,
  searchProfilesByPhone,
  createAccountFromRenewal,
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
  type AccessAccountWithProfiles,
  type ProfileWithAccount,
  type RenewalStatus,
  type SoldProfile,
} from "../db/access.repository";
import {
  renewAccount, accountStatus, daysLeft, runRenewalCutover, limaTodayISO,
  listCycleRenewalsAwaitingConfirmation, confirmCycleRenewal, assignPendingClients,
} from "../services/access.service";
import { listPendingAssignments, countPendingAssignments } from "../db/pending-assignments.repository";
import { listPayLinkCandidates, createPayLink, cleanOldPayLinks, priceSelection } from "../db/renewal-pay-links.repository";
import { listCatalogProducts, getCatalogProductByPlatform } from "../db/catalog.repository";
import { listProviders } from "../db/provider.repository";
import { listArchivedAccounts, searchArchivedAccounts } from "../db/access-history.repository";
import { listRenewalHistory } from "../db/renewal-history.repository";
import {
  setAccountCodesEnabled,
  setAccountCodeSource,
  setAccountTotpSecret,
  listCodesEnabledAccounts,
  getLatestCodeForAccount,
  getLastSeenCodeForEmail,
  saveIncomingCode,
} from "../db/codes.repository";
import { lookupCodeActionWithRetries, lookupAnySourceWithRetries, listCodeSources, listSourceActions, codeSourceLabel, skipsRepeatedCodes, TOTP_SOURCE_ID, isLoginCodeOnlySource, isLoginCode } from "../services/codes-lookup.service";
import { getCurrentTotp } from "../utils/totp.util";
import { createCustomerNotification } from "../db/customer-notifications.repository";
import { createWholesalerNotification } from "../db/wholesaler-notifications.repository";

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── serialización — agrega estado/días calculados a la cuenta ──

function withStatus(account: AccessAccountWithProfiles) {
  return {
    ...account,
    status:   accountStatus(account.expiresAt),
    daysLeft: daysLeft(account.expiresAt),
  };
}

function profileWithStatus(p: ProfileWithAccount) {
  return { ...p, status: accountStatus(p.expiresAt), daysLeft: daysLeft(p.expiresAt) };
}

// ── CATÁLOGO (para el desplegable de plataforma) ──
// Viene del catálogo propio del panel (Configuración > Catálogo), no del
// bot — se edita ahí. Ver src/db/catalog.repository.ts.

router.get("/platforms-catalog", (_req, res) => {
  const platforms = listCatalogProducts(true).map(p => ({ platform: p.platform, hasProfiles: p.hasProfiles }));
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

router.get("/platforms", (_req, res) => {
  res.json({ platforms: listPlatforms() });
});

router.get("/platforms/:platform/accounts", (req, res) => {
  const accounts = listAccountsByPlatform(req.params.platform);
  res.json({ accounts: accounts.map(withStatus) });
});

// ── CUENTAS ──

// Alta en formato "correo:contraseña" (una por línea) — todas comparten
// plataforma, proveedor y vencimiento inicial. hasProfiles se resuelve
// del catálogo propio del panel, nunca se confía en lo que mande el cliente.
router.post("/accounts/bulk", async (req, res) => {
  const {
    platform, provider, expiresAt, lines,
    providerRenewalEnabled, providerRenewalCost, providerRenewalCurrency, providerRenewalNextDate,
  } = req.body ?? {};

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

  const pairs = lines
    .split("\n")
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0)
    .map((line: string) => {
      const idx = line.indexOf(":");
      if (idx === -1) return null;
      return { email: line.slice(0, idx).trim(), password: line.slice(idx + 1).trim() };
    });

  const invalid = pairs.some((p: any) => !p || !p.email || !p.password);
  if (invalid || pairs.length === 0) {
    res.status(400).json({ message: "Cada línea debe tener el formato correo:contraseña." });
    return;
  }

  const hasProfiles = getCatalogProductByPlatform(platform)?.hasProfiles ?? true;

  const accounts = createAccountsBulk({
    platform, provider: typeof provider === "string" ? provider : "",
    hasProfiles, expiresAt, pairs: pairs as { email: string; password: string }[],
    providerRenewalEnabled:  !!providerRenewalEnabled,
    providerRenewalCost:     typeof providerRenewalCost === "string" ? providerRenewalCost : "",
    providerRenewalCurrency: typeof providerRenewalCurrency === "string" ? providerRenewalCurrency : "USDT",
    providerRenewalNextDate: providerRenewalNextDate ?? null,
  });

  res.status(201).json({ accounts: accounts.map(withStatus) });
});

router.get("/accounts/:id", (req, res) => {
  const account = getAccountById(Number(req.params.id));
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  res.json({ account: withStatus(account) });
});

router.put("/accounts/:id", (req, res) => {
  const {
    platform, email, password, provider, expiresAt, link, notes,
    providerRenewalEnabled, providerRenewalCost, providerRenewalCurrency, providerRenewalNextDate,
  } = req.body ?? {};

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

  const account = updateAccount(Number(req.params.id), {
    platform, email, password, provider, expiresAt, link, notes,
    ...(providerRenewalEnabled !== undefined ? { providerRenewalEnabled: !!providerRenewalEnabled } : {}),
    ...(typeof providerRenewalCost === "string" ? { providerRenewalCost } : {}),
    ...(typeof providerRenewalCurrency === "string" ? { providerRenewalCurrency } : {}),
    ...(providerRenewalNextDate !== undefined ? { providerRenewalNextDate } : {}),
  });
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  res.json({ account: withStatus(account) });
});

router.delete("/accounts/:id", (req, res) => {
  deleteAccount(Number(req.params.id));
  res.json({ ok: true });
});

// POST /accounts/:id/notify-password-change — "🔑 Cambiar contraseña a
// todos" (Accesos). La contraseña nueva YA está guardada en la cuenta (se
// edita aparte, en "✏️ Editar cuenta") — acá solo se avisa a cada perfil
// ocupado con la que ya tiene la cuenta ahora mismo, por la campanita de
// notificaciones (nunca por WhatsApp): al cliente retail directo si no es
// de un mayorista, o al mayorista dueño si el perfil es su stock.
router.post("/accounts/:id/notify-password-change", (req, res) => {
  const account = getAccountById(Number(req.params.id));
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }

  const occupied = account.profiles.filter(p => p.clientPhone);
  for (const p of occupied) {
    if (p.wholesalerId != null) {
      createWholesalerNotification(p.wholesalerId, "password_changed", account.platform, account.email, account.password);
    } else {
      createCustomerNotification(p.clientPhone, "password_changed", account.platform, account.email, account.password);
    }
  }

  res.json({ ok: true, notified: occupied.length });
});

// POST /accounts/:id/notify-replacement — "🔄 Enviar reemplazo a todos"
// (Accesos). Mismo criterio que notify-password-change (nunca por
// WhatsApp, solo por la campanita de notificaciones): la cuenta ya tiene
// guardado el correo/contraseña nuevos (se edita aparte, en "✏️ Editar
// cuenta"), acá solo se avisa a cada perfil ocupado con el detalle
// completo — correo, contraseña, perfil y días restantes.
router.post("/accounts/:id/notify-replacement", (req, res) => {
  const account = getAccountById(Number(req.params.id));
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }

  const left = daysLeft(account.expiresAt);
  const occupied = account.profiles.filter(p => p.clientPhone);
  for (const p of occupied) {
    const profileLine = p.profileName ? `\n👤 Perfil: ${p.profileName}` : "";
    const detail = `📧 Correo: ${account.email}\n🔑 Contraseña: ${account.password}${profileLine}` +
      (left !== null ? `\n⏳ Días restantes: ${left}` : "") +
      `\n\nCualquier inconveniente adicional, estamos atentos. 😊`;
    if (p.wholesalerId != null) {
      createWholesalerNotification(p.wholesalerId, "account_replaced", account.platform, account.email, detail);
    } else {
      createCustomerNotification(p.clientPhone, "account_replaced", account.platform, account.email, detail);
    }
  }

  res.json({ ok: true, notified: occupied.length });
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

  const orderRef = "COMBO-" + digits + "-" + Date.now();
  const sold: SoldProfile[] = [];
  const failed: string[] = [];

  for (const platform of platforms) {
    if (typeof platform !== "string" || !platform.trim()) continue;
    const result = sellProfile(platform, digits, orderRef);
    if (result) sold.push(result); else failed.push(platform);
  }

  res.status(sold.length > 0 ? 201 : 409).json({ orderRef, sold, failed });
});

// ── RENOVACIÓN CON PROVEEDOR (Pagos > Renovaciones) ──

router.get("/provider-renewals", (_req, res) => {
  res.json({ accounts: listProviderRenewalAccounts() });
});

router.post("/accounts/:id/provider-renewal/mark-renewed", (req, res) => {
  const account = markProviderRenewalRenewed(Number(req.params.id));
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada o sin fecha de renovación." }); return; }
  res.json({ account });
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
// a todos los que pagaron.
router.get("/cycle-renewals/:id/candidates", (req, res) => {
  const pending = listCycleRenewalsAwaitingConfirmation().find(a => a.id === Number(req.params.id));
  if (!pending) return res.status(404).json({ message: "Esta cuenta ya no tiene renovaciones por confirmar." });
  res.json({ accounts: listAccountsWithFreeProfiles(pending.platform, pending.renewing.length, limaTodayISO()).filter(a => a.id !== pending.id) });
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
  const secret = typeof req.body?.totpSecret === "string" && req.body.totpSecret.trim() ? req.body.totpSecret.trim() : null;
  if (!getAccountById(accountId)) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  setAccountTotpSecret(accountId, secret);
  res.json({ account: withStatus(getAccountById(accountId)!) });
});

router.get("/code-sources", (_req, res) => {
  res.json({ sources: listCodeSources() });
});

router.get("/codes", async (_req, res) => {
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

  const accounts = await Promise.all([...groups.values()].map(async group => {
    const a = group[0]!;
    const { totpSecret, ...rest } = a;
    const latestCodeRaw = group
      .map(g => getLatestCodeForAccount(g.id))
      .filter(c => c !== null)
      .sort((x, y) => y.receivedAt.localeCompare(x.receivedAt))[0] ?? null;
    // Netflix por Pally / José: ya no se trabaja con enlaces — no se
    // muestran como "último código" aunque se hayan guardado antes.
    const latestCode = isLoginCodeOnlySource(a.codeSource) && latestCodeRaw?.code.startsWith("http") ? null : latestCodeRaw;
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
      totp: totpSecret ? await getCurrentTotp(totpSecret) : null,
    };
  }));
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

  const found = await lookupAnySourceWithRetries(email, getLastSeenCodeForEmail(email));
  if (!found) { res.json({ found: false, kind: null, value: null, sourceLabel: null }); return; }

  res.json({
    found: true, kind: found.result.kind, value: found.result.value, sourceLabel: found.label,
    receivedAt: found.result.providerReceivedAt ?? null,
  });
});

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

  const codeOnly = isLoginCodeOnlySource(account.codeSource);
  // Netflix por Pally / José Streaming: solo el código de 4 dígitos.
  const actionId = account.codeSource === "netflix_con_opciones"
    ? "codigo_login"
    : (typeof req.body?.actionId === "string" ? req.body.actionId : undefined);
  const exclude = skipsRepeatedCodes(account.codeSource) ? getLastSeenCodeForEmail(account.email) : null;
  let result = await lookupCodeActionWithRetries(account.codeSource, account.email, actionId, exclude);
  if (codeOnly && result.found && !isLoginCode(result)) {
    result = { found: false, kind: null, value: null };
  }
  if (result.found && result.value) {
    const snippet = result.providerReceivedAt ? `Recibido: ${result.providerReceivedAt}` : "";
    saveIncomingCode({ accountId, code: result.value, snippet, source: "external" });
  }
  res.json({ found: result.found, kind: result.kind, value: result.value });
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

// Renovación con cuenta nueva — crea una cuenta aparte y le pasa solo los
// clientes marcados "✅ Renueva" de la vieja. No manda WhatsApp ni toca el
// bot, solo mueve datos del panel (ver createAccountFromRenewal).
router.post("/accounts/:id/renew-new", (req, res) => {
  const { email, password, expiresAt } = req.body ?? {};
  if (!email?.trim())    { res.status(400).json({ message: "El correo es obligatorio." }); return; }
  if (!password?.trim()) { res.status(400).json({ message: "La contraseña es obligatoria." }); return; }

  const result = createAccountFromRenewal(Number(req.params.id), {
    email, password, expiresAt: expiresAt?.trim() || null,
  });
  if (!result) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }

  res.json({
    oldAccount: withStatus(result.oldAccount),
    newAccount: withStatus(result.newAccount),
  });
});

// ── PERFILES (solo el teléfono del cliente — el resto vive en la cuenta) ──

router.put("/profiles/:id", (req, res) => {
  const { clientPhone } = req.body ?? {};
  if (!clientPhone?.trim()) { res.status(400).json({ message: "El teléfono es obligatorio." }); return; }

  const profile = assignProfileClient(Number(req.params.id), clientPhone);
  if (!profile) { res.status(404).json({ message: "Perfil no encontrado." }); return; }
  res.json({ profile });
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
// cuenta — mismo aviso que "🔑 Cambiar contraseña a todos" en Accesos,
// para no tener que ir a hacerlo aparte a mano cada vez.
router.post("/accounts/:id/password-changed", (req, res) => {
  const id = Number(req.params.id);
  const account = getAccountById(id);
  if (!account) return res.status(404).json({ message: "Cuenta no encontrada." });
  markPasswordChanged(id);

  const occupied = account.profiles.filter(p => p.clientPhone);
  for (const p of occupied) {
    if (p.wholesalerId != null) {
      createWholesalerNotification(p.wholesalerId, "password_changed", account.platform, account.email, account.password);
    } else {
      createCustomerNotification(p.clientPhone, "password_changed", account.platform, account.email, account.password);
    }
  }

  res.json({ ok: true, notified: occupied.length });
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
    res.json({ mode: "phone", profiles });
    return;
  }

  const accounts = searchAccountsByEmail(q).map(withStatus);
  res.json({ mode: "email", accounts });
});

export default router;
