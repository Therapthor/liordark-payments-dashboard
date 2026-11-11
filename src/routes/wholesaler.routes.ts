import crypto from "crypto";
import { Router } from "express";
import axios from "axios";
import { env } from "../config/env";
import type { RequestWithWholesaler } from "../services/wholesaler-auth.service";
import { findWholesalerById, touchWholesalerActivity } from "../db/wholesaler.repository";
import { listLedgerForWholesaler, applyWholesalerCreditChange, hasRecentLedgerEntry } from "../db/wholesaler-credit.repository";
import {
  listWholesalerAvailability,
  listWholesalerClients,
  sellProfileForWholesaler,
  createManualActivationForWholesaler,
  getProfileById,
  getAccountById,
  releaseProfile,
  releaseProfilesByOrderRef,
  deleteAccount,
  setProfileRenewal,
  markReminderSent,
  listExpiringClientsForWholesaler,
  listUnnotifiedExpiringClientsForWholesaler,
  listAllUnnotifiedExpiringClientsForWholesalers,
  markExpiryNotified,
  type RenewalStatus,
} from "../db/access.repository";
import { listManualOverridesForWholesaler } from "../db/manual-overrides.repository";
import {
  createWholesalerNotification,
  listWholesalerNotifications,
  countUnreadWholesalerNotifications,
  markAllWholesalerNotificationsRead,
} from "../db/wholesaler-notifications.repository";
import { getCatalogProductByPlatform, listCatalogProducts, type CatalogProduct } from "../db/catalog.repository";
import { listPaymentMethods } from "../db/payment-method.repository";
import { renewAccount, limaTodayISO, addDaysISO } from "../services/access.service";
import { insertApprovedOrder } from "../db/orders.repository";
import { emitDashboardEvent } from "../utils/live-events.util";

// CANVA, GEMINI AI PRO y YOUTUBE PREMIUM se activan a mano — no tienen
// stock de perfiles, así que el catálogo mayorista las muestra siempre
// "disponibles" y la compra pide correo (y, para YOUTUBE, también
// contraseña: la activación es sobre la cuenta propia del cliente) en
// vez de sacar de un pool. CANVA se vende anual, el resto mensual.
function isManualActivationPlatform(platform: string): boolean {
  return /canva|gemini|youtube/i.test(platform);
}
function requiresPasswordPlatform(platform: string): boolean {
  return /youtube/i.test(platform);
}
function manualActivationPlanDays(platform: string): number {
  return /canva/i.test(platform) ? 365 : 30;
}
// YOUTUBE PREMIUM no es renovable — cada ciclo es una compra nueva.
function isNonRenewablePlatform(platform: string): boolean {
  return /youtube/i.test(platform);
}
import {
  createFullAccountOrder,
  listFullAccountOrdersForWholesaler,
  markFullAccountSeenByWholesaler,
  countUnseenFullAccountsForWholesaler,
} from "../db/wholesale-full-account.repository";
import { plansFor, planFor, planExpiresAt, money } from "../services/plans.service";
import { isSafeEmail, cleanEmail } from "../utils/email.util";
import { getAccountCodesConfig } from "../db/codes.repository";
import { createCodeLink, countWholesalerLinksToday, findOpenWholesalerLink } from "../db/code-links.repository";
import { codeWaitMinutes } from "../services/code-requests.service";
import { TOTP_SOURCE_ID } from "../services/codes-lookup.service";

// ─────────────────────────────────────────────────────────────
// PANEL MAYORISTA (mayorista.liordark.com) — todo detrás de sesión de
// mayorista (ver index.ts: requireWholesalerSession). Nunca toca
// access_profiles sin wholesaler_id = el de la sesión — cada mayorista
// solo ve/opera lo suyo.
// ─────────────────────────────────────────────────────────────

const router = Router();

function wid(req: any): number {
  return (req as RequestWithWholesaler).wholesalerId;
}

// ── SALDO / CRÉDITOS ──

router.get("/balance", (req, res) => {
  const wholesaler = findWholesalerById(wid(req));
  if (!wholesaler) return res.status(404).json({ message: "Mayorista no encontrado." });
  res.json({ balanceCents: wholesaler.balanceCents, displayName: wholesaler.displayName, phone: wholesaler.phone });
});

router.get("/ledger", (req, res) => {
  res.json({ entries: listLedgerForWholesaler(wid(req)) });
});

// GET /payment-methods — mismo QR de Yape que ya muestra liordark.com
// (/api/store/payment-methods) — acá con sesión de mayorista en vez de
// cliente, mismo origen de datos (payment_methods es una sola lista).
router.get("/payment-methods", (_req, res) => {
  res.json({ methods: listPaymentMethods().filter(m => m.active) });
});

const ALLOWED_TOPUP_AMOUNTS = [20, 50, 100, 500];

// POST /topup — { amount } — arma la reserva Yape en el bot (mismo
// pipeline de monto único que usa liordark.com) y devuelve el monto
// exacto a pagar. El crédito en sí llega después, cuando el bot detecta
// el pago y llama a POST /api/stock/wholesale-credit acá mismo.
router.post("/topup", async (req, res) => {
  const amount = Number(req.body?.amount);
  if (!ALLOWED_TOPUP_AMOUNTS.includes(amount)) {
    return res.status(400).json({ message: "Monto inválido — debe ser S/20, 50, 100 o 500." });
  }
  const wholesaler = findWholesalerById(wid(req));
  if (!wholesaler) return res.status(404).json({ message: "Mayorista no encontrado." });

  try {
    const response = await axios.post(
      env.BOT_BASE_URL + "/api/wholesale/topup",
      { wholesalerId: wholesaler.id, phone: wholesaler.phone, amount },
      { headers: { "x-dashboard-key": env.DASHBOARD_API_KEY }, timeout: 15_000 }
    );
    res.json({ orderName: response.data.orderName, amount: response.data.amount });
  } catch (err: any) {
    console.error("❌ No se pudo crear la recarga en el bot:", err?.response?.data?.message ?? err?.message);
    res.status(502).json({ message: err?.response?.data?.message ?? "No se pudo conectar con el bot." });
  }
});

// ── CATÁLOGO (precio mayorista) — solo lo que tiene precio mayorista Y
// stock real disponible ahora mismo (propio o del pool compartido con
// retail). A diferencia de liordark.com (que sí deja "Reservar" sin
// stock), en el panel mayorista un producto en 0 simplemente no
// aparece — para que nunca intenten comprar/reservar algo que no hay.

router.get("/catalog", (req, res) => {
  const availability = listWholesalerAvailability(wid(req));
  const products = listCatalogProducts(true).filter(p => Number(p.wholesalePrice) > 0);

  const catalog = products
    .map(product => {
      const plat = product.platform.trim().toUpperCase();
      const manual = isManualActivationPlatform(plat);
      const stock = availability.find(s => s.platform === plat);
      const plans = plansFor(plat);
      return {
        platform:          plat,
        title:             product.title || plat,
        wholesalePrice:    plans ? money(plans[0]!.wholesalePrice) : product.wholesalePrice,
        // GEMINI: el mayorista elige 1, 3, 6 o 12 meses (S/ 1 menos que la tienda).
        plans:             plans ? plans.map(pl => ({ months: pl.months, label: pl.label, price: money(pl.wholesalePrice) })) : null,
        wholesaleFullPrice: product.wholesaleFullPrice,
        imageUrl:          product.imageUrl,
        // CANVA/GEMINI/YOUTUBE no tienen perfiles pre-cargados — nunca "sin stock".
        freeStock:         manual ? 999 : (stock?.free ?? 0),
        requiresEmail:     manual,
        requiresPassword:  requiresPasswordPlatform(plat),
      };
    })
    .filter(p => p.freeStock > 0);
  res.json({ catalog });
});

// POST /purchase — { platforms: string[], clientPhone } — carrito SIN
// descuento (el precio mayorista YA es el descuento). Server-side trust
// only: el precio se recalcula acá, nunca se confía en lo que mande el
// cliente. Todo o nada — si falta saldo o stock de alguna plataforma, no
// se vende nada.
router.post("/purchase", (req, res) => {
  const wholesalerId = wid(req);
  const rawPlatforms: unknown[] = Array.isArray(req.body?.platforms) ? req.body.platforms : [];
  const platforms = rawPlatforms.map(p => String(p).trim().toUpperCase()).filter(Boolean);
  const clientPhone = String(req.body?.clientPhone ?? "").replace(/\D/g, "");
  const rawEmails: Record<string, unknown> = req.body?.emails && typeof req.body.emails === "object" ? req.body.emails : {};
  const rawPasswords: Record<string, unknown> = req.body?.passwords && typeof req.body.passwords === "object" ? req.body.passwords : {};
  const rawMonths: Record<string, unknown> = req.body?.months && typeof req.body.months === "object" ? req.body.months : {};

  if (platforms.length === 0) return res.status(400).json({ message: "El carrito está vacío." });
  if (clientPhone.length < 9) return res.status(400).json({ message: "Celular del cliente inválido." });

  // CANVA/GEMINI/YOUTUBE piden el correo del cliente final para activarlas a
  // mano (YOUTUBE además la contraseña, se activa sobre la cuenta propia) —
  // una unidad por plataforma a la vez (cada una es una activación
  // distinta), para no complicar el carrito con varias credenciales por ítem.
  const emailByPlatform: Record<string, string> = {};
  const passwordByPlatform: Record<string, string> = {};
  for (const platform of platforms) {
    if (!isManualActivationPlatform(platform)) continue;
    if (platforms.filter(p => p === platform).length > 1) {
      return res.status(400).json({ message: `Compra "${platform}" de una en una — cada una necesita su propia activación.` });
    }
    const email = String(rawEmails[platform] ?? "").trim();
    if (!isSafeEmail(email)) {
      return res.status(400).json({ message: `Falta un correo válido para activar "${platform}".` });
    }
    emailByPlatform[platform] = email;

    if (requiresPasswordPlatform(platform)) {
      const password = String(rawPasswords[platform] ?? "").trim();
      if (!password) {
        return res.status(400).json({ message: `Falta la contraseña para activar "${platform}".` });
      }
      passwordByPlatform[platform] = password;
    }
  }

  // Planes por meses (GEMINI): el precio y el vencimiento salen del plan.
  const planByPlatform: Record<string, NonNullable<ReturnType<typeof planFor>>> = {};
  for (const platform of platforms) {
    if (!plansFor(platform)) continue;
    const plan = planFor(platform, rawMonths[platform] ?? 1);
    if (!plan) return res.status(400).json({ message: `Elige un plan válido para "${platform}" (1, 3, 6 o 12 meses).` });
    planByPlatform[platform] = plan;
  }

  let totalCents = 0;
  for (const platform of platforms) {
    const product = getCatalogProductByPlatform(platform);
    const plan = planByPlatform[platform];
    const price = plan ? plan.wholesalePrice : Number(product?.wholesalePrice ?? 0);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(422).json({ message: `"${platform}" no tiene precio mayorista configurado.` });
    }
    totalCents += Math.round(price * 100);
  }

  const orderRef = "wholesale:" + wholesalerId + ":" + Date.now() + ":" + crypto.randomUUID().slice(0, 8);
  const deduction = applyWholesalerCreditChange(wholesalerId, -totalCents, "purchase_profile", orderRef, "system");
  if (!deduction.ok) {
    return res.status(402).json({ message: deduction.error });
  }

  const sold: { platform: string; email: string; password: string; profileName: string; planLabel?: string; expiresAt?: string }[] = [];
  const createdManualAccountIds: number[] = [];
  const failedPlatforms: string[] = [];
  for (const platform of platforms) {
    if (isManualActivationPlatform(platform)) {
      const plan = planByPlatform[platform];
      const expiresAt = plan ? planExpiresAt(plan) : addDaysISO(limaTodayISO(), manualActivationPlanDays(platform));
      const created = createManualActivationForWholesaler({
        platform, email: emailByPlatform[platform], password: passwordByPlatform[platform], expiresAt,
        wholesalerId, clientPhone, orderRef, planMonths: plan?.months,
      });
      createdManualAccountIds.push(created.accountId);
      sold.push({ platform, email: created.email, password: "", profileName: "", ...(plan ? { planLabel: plan.label, expiresAt } : {}) });
      continue;
    }
    const result = sellProfileForWholesaler(platform, wholesalerId, clientPhone, orderRef);
    if (result) {
      const account = getAccountById(result.accountId);
      // result.profileName: el perfil/PIN que le tocó dentro de la cuenta
      // compartida (Crunchyroll, Netflix, etc.) — sin esto el mayorista ve
      // el correo/contraseña de todos pero no sabe cuál casilla es la suya.
      sold.push({ platform, email: account?.email ?? "", password: account?.password ?? "", profileName: result.profileName || "" });
    } else {
      failedPlatforms.push(platform);
    }
  }

  if (failedPlatforms.length > 0) {
    // Sin stock real para alguna plataforma (se agotó justo ahora) —
    // se revierte TODO: libera lo que sí se vendió (mismo orderRef),
    // borra las de activación manual recién creadas (no tiene sentido
    // dejar un correo ya invitado dando vueltas como "stock libre"), y
    // devuelve el crédito, para no dejar una compra parcial cobrada a medias.
    releaseProfilesByOrderRef(orderRef);
    createdManualAccountIds.forEach(id => deleteAccount(id));
    applyWholesalerCreditChange(wholesalerId, totalCents, "purchase_profile", orderRef + ":revert", "system");
    return res.status(409).json({
      message: `Sin stock disponible para: ${failedPlatforms.join(", ")}. No se cobró nada.`,
    });
  }

  touchWholesalerActivity(wholesalerId);

  // Espejo a "Aprobados recientes" del panel — antes una compra mayorista
  // no dejaba ningún rastro ahí (solo las recargas de saldo lo hacían).
  const wholesaler = findWholesalerById(wholesalerId);
  const approvedText =
    "✅ <b>Compra mayorista confirmada</b>\n\n" +
    "🏪 " + (wholesaler?.displayName || "Mayorista #" + wholesalerId) + " (" + (wholesaler?.phone ?? "") + ")\n" +
    "🎯 " + platforms.map(p => planByPlatform[p] ? `${p} (${planByPlatform[p]!.label})` : p).join(", ") + "\n" +
    "👤 Cliente final: " + clientPhone + "\n" +
    "💰 S/ " + (totalCents / 100).toFixed(2);
  const createdAt = new Date().toISOString();
  insertApprovedOrder(approvedText, createdAt);
  emitDashboardEvent({ type: "order_approved", message: approvedText, createdAt });

  res.json({ ok: true, accounts: sold, totalCents });
});

// ── CUENTAS COMPLETAS A PEDIDO ──

router.post("/full-account-orders", (req, res) => {
  const wholesalerId = wid(req);
  const platform      = String(req.body?.platform ?? "").trim().toUpperCase();
  const quantity       = Math.max(1, Number(req.body?.quantity) || 1);
  if (!Number.isInteger(quantity) || quantity > 20) return res.status(400).json({ message: "La cantidad debe ser un número entero entre 1 y 20." });
  const clientPhone    = String(req.body?.clientPhone ?? "").replace(/\D/g, "");

  if (!platform) return res.status(400).json({ message: "Falta la plataforma." });
  if (clientPhone.length < 9) return res.status(400).json({ message: "Celular del cliente inválido." });

  const product = getCatalogProductByPlatform(platform);
  const unitPrice = Number(product?.wholesaleFullPrice ?? 0);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    return res.status(422).json({ message: `"${platform}" no tiene precio de cuenta completa configurado.` });
  }
  const unitPriceCents = Math.round(unitPrice * 100);
  const totalCents = unitPriceCents * quantity;

  const orderRef = "wholesale-full:" + wholesalerId + ":" + Date.now() + ":" + crypto.randomUUID().slice(0, 8);
  const deduction = applyWholesalerCreditChange(wholesalerId, -totalCents, "purchase_full_account", orderRef, "system");
  if (!deduction.ok) return res.status(402).json({ message: deduction.error });

  const order = createFullAccountOrder({ wholesalerId, platform, quantity, unitPriceCents, endClientPhone: clientPhone });
  touchWholesalerActivity(wholesalerId);
  res.status(201).json({ order });
});

router.get("/full-account-orders", (req, res) => {
  res.json({ orders: listFullAccountOrdersForWholesaler(wid(req)) });
});

// ── CUENTAS (perfiles + cuentas completas, badge de no vistos) ──

router.get("/accounts", (req, res) => {
  const wholesalerId = wid(req);
  const clients = listWholesalerClients(wholesalerId);
  const fullOrders = listFullAccountOrdersForWholesaler(wholesalerId);
  const unseenCount = countUnseenFullAccountsForWholesaler(wholesalerId) +
    clients.filter((c: any) => c.seenByWholesaler === false).length;
  res.json({ profiles: clients, fullAccountOrders: fullOrders, unseenCount });
});

router.post("/accounts/mark-seen", (req, res) => {
  markFullAccountSeenByWholesaler(wid(req));
  res.json({ ok: true });
});

// ── CLIENTES (sub-clientes del mayorista) ──

// ── PRECIO DE RENOVACIÓN ──
// Se renueva al mismo precio que se compró: la CUENTA COMPLETA (la que el
// admin asigna en "Asignar cuenta › Cuenta completa (a mano)") al precio
// mayorista de cuenta completa; un perfil, al de perfil. Antes todo salía
// al precio de perfil — un mayorista lo vio al renovar su cuenta completa.

type RenewKind = "perfil" | "cuenta" | "cuenta_completa";
type RenewQuote = { kind: RenewKind; label: string; priceCents: number; pending: boolean };
type RenewQuoteResult = { ok: true; quote: RenewQuote } | { ok: false; status: number; message: string };

/** Cuenta entera (sin perfiles) de una plataforma que se vende por
 *  perfiles = cuenta completa. No cuentan las de activación manual
 *  (Canva/Gemini/YouTube: cada compra ya es una cuenta individual) ni lo
 *  comprado en "Comprar" (orden "wholesale:…": se pagó como perfil). */
function isFullAccountSale(hasProfiles: boolean, platform: string, orderRef: string, product: CatalogProduct | null): boolean {
  if (hasProfiles || !product) return false;
  if (isManualActivationPlatform(platform)) return false;
  if (String(orderRef || "").startsWith("wholesale:")) return false;
  return product.hasProfiles || Number(product.wholesaleFullPrice) > 0;
}

function renewQuoteFor(
  account: { platform: string; hasProfiles: boolean },
  orderRef: string,
  products?: Map<string, CatalogProduct | null>,
): RenewQuoteResult {
  if (isNonRenewablePlatform(account.platform)) {
    return { ok: false, status: 400, message: account.platform + " no es renovable — se compra nuevamente." };
  }
  let product: CatalogProduct | null;
  if (products?.has(account.platform)) product = products.get(account.platform) ?? null;
  else {
    product = getCatalogProductByPlatform(account.platform);
    products?.set(account.platform, product);
  }
  const full = isFullAccountSale(account.hasProfiles, account.platform, orderRef, product);
  const price = Number(full ? product?.wholesaleFullPrice : product?.wholesalePrice);
  if (!Number.isFinite(price) || price <= 0) {
    return {
      ok: false, status: 422,
      message: full
        ? `La cuenta completa de "${account.platform}" todavía no tiene precio de renovación. Escríbenos por Soporte y te la renovamos.`
        : `"${account.platform}" no tiene precio mayorista configurado.`,
    };
  }
  return {
    ok: true,
    quote: {
      kind:  full ? "cuenta_completa" : account.hasProfiles ? "perfil" : "cuenta",
      label: full ? "Cuenta completa" : account.hasProfiles ? "Perfil" : "Cuenta",
      priceCents: Math.round(price * 100),
      // Con perfiles: se paga y el admin la confirma con el proveedor
      // ("Renovados"). Sin perfiles: suma los días al toque.
      pending: account.hasProfiles,
    },
  };
}

/** Lo que el panel muestra de la renovación de cada cliente. */
function renewInfo(r: RenewQuoteResult) {
  return r.ok
    ? { renew: { kind: r.quote.kind, label: r.quote.label, price: money(r.quote.priceCents / 100), priceCents: r.quote.priceCents, pending: r.quote.pending }, renewBlocked: null }
    : { renew: null, renewBlocked: r.message };
}

// ── CÓDIGOS ──
// El mayorista ve el código que llega al correo de SUS cuentas sin entrar
// a la bandeja del proveedor: se abre una consulta (el buscador del
// servidor revisa al proveedor por turnos, igual que para el cliente en
// liordark.com/codigo) y el panel la lee. Mismos filtros que al cliente
// (nunca códigos de cambio de datos). Límite por día (Lima) y por venta:
// cuenta completa 10, perfil 3. Una consulta abierta se reutiliza sin
// gastar otra.
const CODES_PER_DAY_FULL = 10;
const CODES_PER_DAY_PROFILE = 3;

function codesInfoFor(profileId: number, account: { id: number; hasProfiles: boolean; expiresAt: string | null }) {
  const cfg = getAccountCodesConfig(account.id);
  const active = !account.expiresAt || account.expiresAt >= limaTodayISO();
  const limit = account.hasProfiles ? CODES_PER_DAY_PROFILE : CODES_PER_DAY_FULL;
  if (!cfg.enabled || !active) return { enabled: false as const, sourceId: null, limit, used: 0, remaining: 0, open: false };
  const used = countWholesalerLinksToday(profileId);
  return {
    enabled: true as const, sourceId: cfg.sourceId!, limit, used,
    remaining: Math.max(0, limit - used), open: !!findOpenWholesalerLink(profileId),
  };
}

/** Lo que ve el panel (sin decir de qué proveedor sale el código). */
function publicCodesInfo(info: ReturnType<typeof codesInfoFor>) {
  return { enabled: info.enabled, limit: info.limit, used: info.used, remaining: info.remaining, open: info.open };
}

router.get("/clients", (req, res) => {
  const wholesalerId = wid(req);
  const products = new Map<string, CatalogProduct | null>();
  const clients = listWholesalerClients(wholesalerId).map(c => ({
    ...c,
    ...renewInfo(renewQuoteFor({ platform: c.platform, hasProfiles: c.accountHasProfiles }, c.orderRef, products)),
    codes: publicCodesInfo(codesInfoFor(c.id, { id: c.accountId, hasProfiles: c.accountHasProfiles, expiresAt: c.expiresAt })),
  }));
  res.json({
    clients,
    manualOverrides: listManualOverridesForWholesaler(wholesalerId),
  });
});

// Al mayorista solo lo que su pantalla usa — nunca la cuenta completa
// (traía la clave 2FA, las notas, el costo del proveedor, el link de la
// bandeja de códigos…).
function publicAccount(a: ReturnType<typeof getAccountById>) {
  return a ? { id: a.id, platform: a.platform, expiresAt: a.expiresAt } : null;
}

function ownProfileAndAccount(wholesalerId: number, profileId: number) {
  const profile = getProfileById(profileId);
  // 404 (no 403) a propósito — no confirma ni niega que el perfil exista
  // si no es de este mayorista, igual que el resto de este archivo.
  if (!profile || profile.wholesalerId !== wholesalerId) return null;
  const account = getAccountById(profile.accountId);
  return account ? { profile, account } : null;
}

// Precio exacto antes de confirmar — el mismo cálculo que el cobro.
router.get("/clients/:profileId/renew-quote", (req, res) => {
  const found = ownProfileAndAccount(wid(req), Number(req.params.profileId));
  if (!found) return res.status(404).json({ message: "Perfil no encontrado." });
  const q = renewQuoteFor(found.account, found.profile.orderRef);
  if (!q.ok) return res.status(q.status).json({ message: q.message });
  res.json({
    kind: q.quote.kind, label: q.quote.label, price: money(q.quote.priceCents / 100),
    priceCents: q.quote.priceCents, pending: q.quote.pending,
    alreadyPaid: q.quote.pending && found.profile.renewalStatus === "yes",
  });
});

/** Rastro en "Aprobados recientes" del panel admin — sobre todo para la
 *  cuenta completa: suma los días al toque y hay que renovarla con el
 *  proveedor. */
function notifyAdminOfRenewal(
  wholesalerId: number, account: { platform: string; email: string }, clientPhone: string,
  quote: RenewQuote, newExpiresAt: string | null,
): void {
  const wholesaler = findWholesalerById(wholesalerId);
  const next = quote.pending
    ? "⏳ Confírmala en Accesos › Renovados cuando la renueves con el proveedor."
    : "📅 Nueva fecha: " + (newExpiresAt ?? "—") + (quote.kind === "cuenta_completa" ? " — renuévala con el proveedor." : "");
  const text =
    "🔁 <b>Renovación mayorista pagada</b>\n\n" +
    "🏪 " + (wholesaler?.displayName || "Mayorista #" + wholesalerId) + " (" + (wholesaler?.phone ?? "") + ")\n" +
    "🎯 " + account.platform + " — " + quote.label + " · " + account.email + "\n" +
    "👤 Cliente final: " + clientPhone + "\n" +
    "💰 S/ " + (quote.priceCents / 100).toFixed(2) + "\n" +
    next;
  const createdAt = new Date().toISOString();
  insertApprovedOrder(text, createdAt);
  emitDashboardEvent({ type: "order_approved", message: text, createdAt });
}

// Renovar = consume créditos a precio mayorista (el de lo que se compró,
// ver renewQuoteFor). Bloquea sin tocar nada si no alcanza el saldo.
router.post("/clients/:profileId/renew", (req, res) => {
  const wholesalerId = wid(req);
  const profileId = Number(req.params.profileId);
  const found = ownProfileAndAccount(wholesalerId, profileId);
  if (!found) return res.status(404).json({ message: "Perfil no encontrado." });
  const { profile, account } = found;

  const q = renewQuoteFor(account, profile.orderRef);
  if (!q.ok) return res.status(q.status).json({ message: q.message });
  const { quote } = q;

  // Se cobra exactamente lo que el mayorista vio al confirmar: si el precio
  // cambió en el medio (catálogo editado), no se cobra y se vuelve a mostrar.
  const expected = req.body?.expectedPriceCents;
  if (expected !== undefined && expected !== null && Number(expected) !== quote.priceCents) {
    return res.status(409).json({ message: `El precio cambió: ahora es S/ ${money(quote.priceCents / 100)}. Vuelve a intentarlo.` });
  }

  // Cuenta con perfiles: ya pagó este ciclo → no se cobra dos veces.
  if (quote.pending && profile.renewalStatus === "yes") {
    return res.status(409).json({ message: "Esta renovación ya está pagada — se activa apenas confirmemos la cuenta con el proveedor." });
  }
  // Doble clic / dos pestañas: la misma renovación recién cobrada.
  const refPrefix = "wholesale-renew:" + wholesalerId + ":" + profileId + ":";
  if (hasRecentLedgerEntry(wholesalerId, "renewal", refPrefix, 90)) {
    return res.status(409).json({ message: "Esta cuenta se acaba de renovar. Si quieres sumar otro mes, inténtalo en un par de minutos." });
  }

  const orderRef = refPrefix + Date.now() + ":" + crypto.randomUUID().slice(0, 8);
  const deduction = applyWholesalerCreditChange(wholesalerId, -quote.priceCents, "renewal", orderRef, "system");
  if (!deduction.ok) return res.status(402).json({ message: deduction.error });

  touchWholesalerActivity(wholesalerId);

  // Cuenta con perfiles: NO se suman días a la cuenta entera al pagar —
  // queda marcado "renueva" y el admin la confirma en "Renovados" cuando ya
  // la renovó con el proveedor (ver confirmCycleRenewal).
  if (quote.pending) {
    setProfileRenewal(profile.id, "yes");
    notifyAdminOfRenewal(wholesalerId, account, profile.clientPhone, quote, null);
    return res.json({
      ok: true, pending: true, account: publicAccount(account), kind: quote.kind, priceCents: quote.priceCents,
      message: "✅ Pago recibido. La renovación se activa apenas confirmemos la cuenta con el proveedor — te avisamos por aquí.",
    });
  }

  const renewed = renewAccount(account.id);
  notifyAdminOfRenewal(wholesalerId, account, profile.clientPhone, quote, renewed?.expiresAt ?? null);
  res.json({ ok: true, account: publicAccount(renewed ?? getAccountById(account.id)), kind: quote.kind, priceCents: quote.priceCents });
});

// Abre (o reutiliza) la consulta de códigos de este cliente → token para
// leerla en /api/code-link/<token>/check, igual que la página del cliente.
router.post("/clients/:profileId/codes/open", (req, res) => {
  const wholesalerId = wid(req);
  const found = ownProfileAndAccount(wholesalerId, Number(req.params.profileId));
  if (!found) return res.status(404).json({ message: "Perfil no encontrado." });
  const { profile, account } = found;

  const info = codesInfoFor(profile.id, account);
  if (!info.enabled) return res.status(409).json({ message: "Esta cuenta no tiene códigos disponibles." });

  const base = { platform: account.platform, email: account.email, profileName: profile.profileName || "", limit: info.limit };
  const open = findOpenWholesalerLink(profile.id);
  if (open) return res.json({ ...base, token: open.token, reused: true, remaining: info.remaining });

  if (info.used >= info.limit) {
    return res.status(429).json({
      message: `Ya usaste tus ${info.limit} consultas de hoy para esta cuenta. Mañana se renuevan; si es urgente, escríbenos por Soporte.`,
    });
  }

  const isTotp = info.sourceId === TOTP_SOURCE_ID;
  const minutes = isTotp ? 2 : codeWaitMinutes(info.sourceId, account.platform) > 1 ? 8 : 5;
  const wholesaler = findWholesalerById(wholesalerId);
  const link = createCodeLink({
    accountId: account.id, email: account.email, sourceId: info.sourceId, clientPhone: wholesaler?.phone ?? "",
    createdBy: "wholesaler", minutes, profileId: profile.id,
  });
  touchWholesalerActivity(wholesalerId);
  res.json({ ...base, token: link.token, reused: false, remaining: Math.max(0, info.limit - info.used - 1) });
});

router.delete("/clients/:profileId", (req, res) => {
  const profile = getProfileById(Number(req.params.profileId));
  if (!profile || profile.wholesalerId !== wid(req)) {
    return res.status(404).json({ message: "Perfil no encontrado." });
  }
  releaseProfile(profile.id);
  res.json({ ok: true });
});

// Marca del mayorista: "" (sin marcar) o "no" (no renueva). "✅ Renueva"
// queda SOLO para la renovación pagada — antes se podía marcar con este
// botón sin pagar y en "Renovados" se veía igual que una pagada.
router.post("/clients/:profileId/renewal-marker", (req, res) => {
  const status = String(req.body?.status ?? "") as RenewalStatus;
  if (status === "yes") {
    return res.status(400).json({ message: "Para que renueve, usa «💰 Renovar» (se descuenta de tu saldo)." });
  }
  if (!["", "no"].includes(status)) return res.status(400).json({ message: "Status inválido." });

  const found = ownProfileAndAccount(wid(req), Number(req.params.profileId));
  if (!found) return res.status(404).json({ message: "Perfil no encontrado." });
  if (found.profile.renewalStatus === "yes" && found.account.hasProfiles) {
    return res.status(409).json({ message: "Esta renovación ya está pagada — se activa apenas confirmemos la cuenta con el proveedor." });
  }

  const profile = setProfileRenewal(found.profile.id, status);
  res.json({ profile });
});

// ── RESUMEN ──

router.get("/summary", (req, res) => {
  const clients = listWholesalerClients(wid(req));
  const today = new Date().toISOString().slice(0, 10);
  const activeCount = clients.filter((c: any) => !c.expiresAt || c.expiresAt >= today).length;
  const expiringCount = clients.filter((c: any) => c.expiresAt && c.expiresAt < today).length;
  res.json({ activeCount, expiringCount, totalClients: clients.length });
});

// ── RECORDATORIOS (tanda manual de WhatsApp a los PROPIOS sub-clientes) ──

router.get("/renewals/expiring", (req, res) => {
  const wholesalerId = wid(req);
  const days = Number(req.query.days ?? 0);
  const products = new Map<string, CatalogProduct | null>();
  // price = lo que cuesta renovar ESA cuenta (perfil o cuenta completa),
  // no siempre el precio de perfil del catálogo.
  const clients = listExpiringClientsForWholesaler(wholesalerId, Number.isFinite(days) ? days : 0, { excludeAlreadyExpired: true })
    .map(c => {
      const found = ownProfileAndAccount(wholesalerId, c.profileId);
      if (!found) return c;
      const q = renewQuoteFor(found.account, found.profile.orderRef, products);
      // Sin precio de renovación (cuenta completa sin precio configurado): el
      // recordatorio sale sin monto en vez de con el de perfil.
      const price = q.ok ? money(q.quote.priceCents / 100) : q.status === 422 ? "" : c.price;
      return { ...c, ...renewInfo(q), price };
    });
  res.json({ clients });
});

router.post("/renewals/:profileId/mark-reminded", (req, res) => {
  const profile = getProfileById(Number(req.params.profileId));
  if (!profile || profile.wholesalerId !== wid(req)) {
    return res.status(404).json({ message: "Perfil no encontrado." });
  }
  markReminderSent(profile.id);
  res.json({ ok: true });
});

// ── NOTIFICACIONES (campanita del header) ──

const EXPIRY_NOTIFY_DAYS = 1;

// A diferencia de compra añadida/cuenta lista (eventos puntuales, se
// escriben en el momento desde access.repository/wholesale-full-account.
// repository), "cliente por vencer" no tiene un evento propio — se genera
// acá mismo, de forma perezosa, cada vez que el mayorista pide sus
// notificaciones (mismo polling de 20s del front).
function generateExpiryNotifications(wholesalerId: number): void {
  const expiring = listUnnotifiedExpiringClientsForWholesaler(wholesalerId, EXPIRY_NOTIFY_DAYS);
  for (const c of expiring) {
    createWholesalerNotification(wholesalerId, "client_expiring", c.platform, c.email);
    markExpiryNotified(c.profileId);
  }
}

/** Mismo criterio, pero para TODOS los mayoristas de una — job proactivo
 *  (ver runGenerateExpiryNotifications en index.ts) para que la campanita
 *  no dependa de que el mayorista entre al panel a pedirla. */
export function generateExpiryNotificationsForAllWholesalers(): void {
  const expiring = listAllUnnotifiedExpiringClientsForWholesalers(EXPIRY_NOTIFY_DAYS);
  for (const c of expiring) {
    createWholesalerNotification(c.wholesalerId, "client_expiring", c.platform, c.email);
    markExpiryNotified(c.profileId);
  }
}

router.get("/notifications", (req, res) => {
  const wholesalerId = wid(req);
  generateExpiryNotifications(wholesalerId);
  res.json({
    notifications: listWholesalerNotifications(wholesalerId),
    unreadCount:   countUnreadWholesalerNotifications(wholesalerId),
  });
});

router.post("/notifications/read", (req, res) => {
  markAllWholesalerNotificationsRead(wid(req));
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
export default router;
