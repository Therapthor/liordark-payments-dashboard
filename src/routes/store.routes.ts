import { Router } from "express";
import axios from "axios";
import { env } from "../config/env";
import { requireCustomerSession, type RequestWithCustomer } from "../services/customer-auth.service";
import { findCustomerById, setCustomerEmail } from "../db/customer.repository";
import { listCatalogProducts } from "../db/catalog.repository";
import { listCombos } from "../db/combo.repository";
import { listPaymentMethods } from "../db/payment-method.repository";
import {
  listAccountsByClientPhone, listPlatforms, listRenewalAccountsByPhone,
  listUnnotifiedExpiringClientsForCustomer, listAllUnnotifiedExpiringRetailClients, markExpiryNotified,
} from "../db/access.repository";
import { listArchivedAccountsByPhone } from "../db/access-history.repository";
import { daysLeft } from "../services/access.service";
import { normalizePeruPhone } from "../utils/phone.util";
import {
  listClientCodesAccounts,
  getAccountCodeSource,
} from "../db/codes.repository";
import { TOTP_SOURCE_ID } from "../services/codes-lookup.service";
import { createCodeLink, countClientLinksToday, findOpenClientLink } from "../db/code-links.repository";
import { codeWaitMinutes } from "./code-viewer.routes";
import {
  createCustomerNotification,
  listCustomerNotifications,
  countUnreadCustomerNotifications,
  markAllCustomerNotificationsRead,
  deleteAllCustomerNotifications,
} from "../db/customer-notifications.repository";
import { verifyRenewalToken } from "../utils/renewal-token.util";
import { findSmsRenewalLink } from "../db/sms-renewal-links.repository";
import { findPayLink, isPayLinkExpired, itemStates, setPayLinkOrder, isPayLinkOrderPaid, priceSelection, MULTI_DISCOUNT_MIN, MULTI_DISCOUNT_PCT, listPayLinkCandidates, findOrCreateSelfPayLink, cleanOldPayLinks } from "../db/renewal-pay-links.repository";
import { loginRateLimit } from "../utils/rate-limit.util";
import { listReportableAccounts, reportNoSubscription } from "../services/support-reports.service";
import { emitDashboardEvent } from "../utils/live-events.util";
import { plansFor, planFor, savePlanOrder, money } from "../services/plans.service";
import { isSafeEmail, cleanEmail } from "../utils/email.util";
import { suspiciousReason, autoBlockCustomer, clientIp } from "../services/security.service";
import { CUSTOMER_SESSION_COOKIE } from "../services/customer-auth.service";
import { saleLinkStatus, saleLinkForCustomer } from "./sale-links.routes";
import { findSaleLink, saleLinkState, isSaleLinkUsable, addSaleLinkOrder } from "../db/sale-links.repository";
import { saveStoreWebOrder, storeOrderPaymentStatus, listRecentConfirmedPurchases, type RecentPurchase } from "../db/store-orders.repository";


// Mismo criterio de disponibilidad que ya usa el bot de WhatsApp
// (GET /api/stock/catalog y /combos) — sellableCount ya excluye
// perfiles libres pero a punto de vencer, no se vuelve a inventar acá.
function availabilityByPlatform(): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of listPlatforms()) map.set(s.platform.trim().toUpperCase(), s.sellableCount);
  return map;
}

// CANVA, GEMINI AI PRO y YOUTUBE PREMIUM no tienen perfiles pre-cargados
// — se activan a mano tras cada pedido (YOUTUBE sobre la cuenta propia
// del cliente, con su correo y contraseña). Mismo chequeo para dos
// cosas: su sellableCount real es siempre 0 (sin este caso especial la
// web las mostraría como "sin stock" permanentemente), y el checkout
// exige el correo (y, para YOUTUBE, también la contraseña) — sin eso el
// pedido no tiene forma de completarse.
function isManualActivationPlatform(platform: string): boolean {
  return /canva|gemini|youtube/i.test(platform);
}
function requiresPasswordPlatform(platform: string): boolean {
  return /youtube/i.test(platform);
}

// YOUTUBE PREMIUM no es renovable — cada ciclo es una compra nueva (correo
// y contraseña otra vez), nunca una extensión de la cuenta anterior.
function isNonRenewablePlatform(platform: string): boolean {
  return /youtube/i.test(platform);
}

// 999 en vez de Infinity: esto viaja como JSON y JSON.stringify(Infinity)
// serializa a null, lo que volvería a mostrarlo como "sin stock".
function availableFor(platform: string, stock: Map<string, number>): number {
  if (isManualActivationPlatform(platform)) return 999;
  return stock.get(platform.trim().toUpperCase()) ?? 0;
}

// ─────────────────────────────────────────────────────────────
// COMBO ARMADO POR EL CLIENTE ("¿Quieres armar tu combo? ¡Hazlo!") —
// descuento por cantidad de productos distintos, no por catálogo fijo.
// ─────────────────────────────────────────────────────────────

const MIN_CUSTOM_COMBO_ITEMS = 2;

function customComboDiscountRate(itemCount: number): number {
  if (itemCount >= 3) return 0.15;
  if (itemCount === 2) return 0.05;
  return 0;
}

// ─────────────────────────────────────────────────────────────
// TIENDA WEB (liordark.com) — el catálogo (/catalog, más abajo) es
// público a propósito; todo lo demás (comprar, Mis cuentas, Códigos,
// notificaciones) sigue detrás de sesión de cliente, como pidió el negocio.
// ─────────────────────────────────────────────────────────────

// «Contraseña» de la cuenta propia del cliente (YouTube Premium): se ve en
// el panel, así que nunca puede llevar HTML (< >) ni
// caracteres de control. Máximo 64.
const BAD_CLIENT_PASSWORD = "La contraseña no puede tener los símbolos < ni > y debe tener como máximo 64 caracteres.";
function isSafeClientPassword(v: unknown): boolean {
  const s = String(v);
  return s.length <= 64 && !/[<>\u0000-\u001f\u007f]/.test(s);
}

const router = Router();

// ─────────────────────────────────────────────────────────────
// RENOVACIONES — PÚBLICO, sin sesión de cliente a propósito. Muchos
// clientes compraron por WhatsApp y nunca se registraron en la web, así
// que exigir login los dejaría afuera. El celular ya es la identidad que
// se usa en todo el negocio (WhatsApp, Accesos) — acá se reutiliza igual,
// nunca se expone contraseña, solo correo (para reconocer la cuenta) y
// precio (para saber cuánto pagar).
// ─────────────────────────────────────────────────────────────

// Con sesión y SOLO el celular de esa sesión: antes era público por
// ?phone= y cualquiera veía correos y vencimientos de otro (auditoría A2).
function sessionPhone(req: any): string {
  const c = findCustomerById((req as RequestWithCustomer).customerId);
  return c ? normalizePeruPhone(c.phone) : "";
}

router.get("/renewals", requireCustomerSession, (req, res) => {
  const phone = sessionPhone(req).replace(/\D/g, "");
  if (phone.length < 9) {
    return res.status(401).json({ message: "Sesión inválida." });
  }

  const accounts = listRenewalAccountsByPhone(phone).map(a => ({
    ...a,
    daysLeft: daysLeft(a.expiresAt),
  }));

  res.json({ accounts });
});

router.post("/renewals/checkout", requireCustomerSession, async (req, res) => {
  // Normalizado ACÁ (con el "51" si hace falta) antes de mandarlo al bot —
  // si no, un cliente que tipeó su celular sin el prefijo terminaría con
  // una orden/perfil sin el prefijo, y WhatsApp nunca le llegaría el
  // mensaje de confirmación (la API de Meta exige el número completo).
  const phone          = sessionPhone(req);
  const platform       = req.body?.platform ? String(req.body.platform).trim() : undefined;
  const clientEmail    = cleanEmail(req.body?.clientEmail);
  if (req.body?.clientPassword && !isSafeClientPassword(req.body.clientPassword)) {
    return res.status(400).json({ message: BAD_CLIENT_PASSWORD });
  }
  const clientPassword = req.body?.clientPassword ? String(req.body.clientPassword) : undefined;

  if (phone.length < 9 || !platform) {
    return res.status(400).json({ message: "Falta 'phone' o 'platform'." });
  }

  if (isNonRenewablePlatform(platform)) {
    return res.status(400).json({ message: platform + " no es renovable — se compra nuevamente." });
  }

  // CANVA, GEMINI AI PRO y YOUTUBE PREMIUM se activan a mano con el correo
  // del cliente (YOUTUBE además con su contraseña) — igual que en una
  // compra nueva, sin eso el pedido llega sin forma de completarse.
  if (isManualActivationPlatform(platform) && !clientEmail) {
    return res.status(400).json({ message: "Falta el correo para activar " + platform + "." });
  }
  if (requiresPasswordPlatform(platform) && !clientPassword) {
    return res.status(400).json({ message: "Falta la contraseña para activar " + platform + "." });
  }

  // Nunca renovar algo que ese celular no tiene — evita que cualquiera
  // arme una orden de renovación con un platform inventado.
  const account = listRenewalAccountsByPhone(phone).find(a => a.platform.trim().toUpperCase() === platform.trim().toUpperCase());
  if (!account) {
    return res.status(404).json({ message: "No encontramos esa cuenta para este celular." });
  }

  // El corte automático (runRenewalCutover) solo suma los 30 días cuando
  // falta exactamente 1 día — el mismo día que vence (o ya vencida) ya no
  // da tiempo de aplicarlo, así que no se acepta el pago: toca comprar de
  // nuevo en vez de cobrar una "renovación" que nunca se iba a reflejar.
  const accountDaysLeft = daysLeft(account.expiresAt);
  if (accountDaysLeft === null || accountDaysLeft <= 0) {
    return res.status(400).json({ message: "Esta cuenta ya no se puede renovar el mismo día — compra una cuenta nueva." });
  }

  try {
    const response = await axios.post(
      env.BOT_BASE_URL + "/api/web-orders",
      { phone, platform, clientEmail, clientPassword, isRenewal: true },
      { headers: { "x-dashboard-key": env.DASHBOARD_API_KEY }, timeout: 15_000 }
    );
    res.json({ orderName: response.data.orderName, amount: response.data.amount });
  } catch (err: any) {
    const message = err?.response?.data?.message || "No se pudo crear la orden. Intenta de nuevo.";
    res.status(err?.response?.status || 502).json({ message });
  }
});

// ─────────────────────────────────────────────────────────────
// RENOVAR DESDE EL CORREO — botón "Renovar ahora" del recordatorio de
// vencimiento (ver expiry-reminder.job.ts). El token ya trae celular +
// plataforma firmados (ver renewal-token.util.ts), así que esta página NO
// pide login — igual de público que /renewals/checkout, solo que acá no
// hace falta que el cliente tipee nada para identificarse.
// ─────────────────────────────────────────────────────────────

function renewalAccountInfo(phone: string, platform: string): any {
  const account = listRenewalAccountsByPhone(phone)
    .find(a => a.platform.trim().toUpperCase() === platform.trim().toUpperCase());
  if (!account) return null;

  const left = daysLeft(account.expiresAt);
  return {
    platform:    account.platform,
    platformTag: account.platformTag,
    price:       account.price,
    daysLeft:    left,
    needsEmail:    isManualActivationPlatform(account.platform),
    needsPassword: requiresPasswordPlatform(account.platform),
    // Mismo umbral que el checkout: el día que vence (o ya vencida) ya no
    // se puede renovar — el frontend muestra "comprar cuenta nueva" en vez
    // del formulario de renovación.
    canRenew: left !== null && left > 0,
  };
}

async function renewalCheckout(
  phone: string, platform: string, clientEmail: string | undefined, clientPassword: string | undefined
): Promise<{ status: number; body: any }> {
  if (isNonRenewablePlatform(platform)) {
    return { status: 400, body: { message: platform + " no es renovable — se compra nuevamente." } };
  }
  if (isManualActivationPlatform(platform) && !clientEmail) {
    return { status: 400, body: { message: "Falta el correo para activar " + platform + "." } };
  }
  if (requiresPasswordPlatform(platform) && !clientPassword) {
    return { status: 400, body: { message: "Falta la contraseña para activar " + platform + "." } };
  }

  const account = listRenewalAccountsByPhone(phone).find(a => a.platform.trim().toUpperCase() === platform.trim().toUpperCase());
  if (!account) {
    return { status: 404, body: { message: "Esa cuenta ya no está pendiente de renovar." } };
  }

  // Mismo criterio que /renewals/checkout: el mismo día que vence (o ya
  // vencida) el corte automático ya no alcanza a aplicar la extensión.
  const accountDaysLeft = daysLeft(account.expiresAt);
  if (accountDaysLeft === null || accountDaysLeft <= 0) {
    return { status: 400, body: { message: "Esta cuenta ya no se puede renovar el mismo día — compra una cuenta nueva." } };
  }

  try {
    const response = await axios.post(
      env.BOT_BASE_URL + "/api/web-orders",
      { phone, platform, clientEmail, clientPassword, isRenewal: true },
      { headers: { "x-dashboard-key": env.DASHBOARD_API_KEY }, timeout: 15_000 }
    );
    return { status: 200, body: { orderName: response.data.orderName, amount: response.data.amount } };
  } catch (err: any) {
    const message = err?.response?.data?.message || "No se pudo crear la orden. Intenta de nuevo.";
    return { status: err?.response?.status || 502, body: { message } };
  }
}

router.get("/renew/:token", (req, res) => {
  const payload = verifyRenewalToken(req.params.token);
  if (!payload) {
    return res.status(410).json({ message: "Este link ya venció. Entra a liordark.com para renovar." });
  }

  const info = renewalAccountInfo(payload.phone, payload.platform);
  if (!info) {
    return res.status(404).json({ message: "Esa cuenta ya no está pendiente de renovar." });
  }
  res.json(info);
});

router.post("/renew/:token/checkout", async (req, res) => {
  const payload = verifyRenewalToken(req.params.token);
  if (!payload) {
    return res.status(410).json({ message: "Este link ya venció. Entra a liordark.com para renovar." });
  }

  const clientEmail    = cleanEmail(req.body?.clientEmail);
  if (req.body?.clientPassword && !isSafeClientPassword(req.body.clientPassword)) {
    return res.status(400).json({ message: BAD_CLIENT_PASSWORD });
  }
  const clientPassword = req.body?.clientPassword ? String(req.body.clientPassword) : undefined;
  const { status, body } = await renewalCheckout(payload.phone, payload.platform, clientEmail, clientPassword);
  res.status(status).json(body);
});

// RENOVAR DESDE EL SMS — mismo destino final (renovar.html), pero el SMS
// no tiene espacio para el token largo firmado del correo: en su lugar
// lleva un código corto que apunta a la fila con celular + plataforma(s)
// (ver sms-renewal-links.repository.ts). Un combo trae más de una
// plataforma en el mismo código — el cliente elige cuál renovar
// (respuesta con multi:true y la lista, en vez de una sola cuenta).
router.get("/renew-code/:code", (req, res) => {
  const link = findSmsRenewalLink(req.params.code);
  if (!link) {
    return res.status(410).json({ message: "Este link ya venció. Entra a liordark.com para renovar." });
  }

  if (link.platforms.length === 1) {
    const info = renewalAccountInfo(link.phone, link.platforms[0]!);
    if (!info) {
      return res.status(404).json({ message: "Esa cuenta ya no está pendiente de renovar." });
    }
    return res.json(info);
  }

  const accounts = link.platforms
    .map(p => renewalAccountInfo(link.phone, p))
    .filter((a): a is NonNullable<typeof a> => !!a);
  if (accounts.length === 0) {
    return res.status(404).json({ message: "Esas cuentas ya no están pendientes de renovar." });
  }
  res.json({ multi: true, accounts });
});

router.post("/renew-code/:code/checkout", async (req, res) => {
  const link = findSmsRenewalLink(req.params.code);
  if (!link) {
    return res.status(410).json({ message: "Este link ya venció. Entra a liordark.com para renovar." });
  }

  // Un solo código: se renueva directo (compatible con el link viejo,
  // que no mandaba "platform" porque solo había una opción posible).
  // Combo (2+ plataformas): el cliente elige cuál en la página, así que
  // acá hace falta que lo diga.
  const platform = link.platforms.length === 1
    ? link.platforms[0]!
    : String(req.body?.platform ?? "").trim();

  if (!link.platforms.some(p => p.trim().toUpperCase() === platform.trim().toUpperCase())) {
    return res.status(400).json({ message: "Elige una de las cuentas del link." });
  }

  const clientEmail    = cleanEmail(req.body?.clientEmail);
  if (req.body?.clientPassword && !isSafeClientPassword(req.body.clientPassword)) {
    return res.status(400).json({ message: BAD_CLIENT_PASSWORD });
  }
  const clientPassword = req.body?.clientPassword ? String(req.body.clientPassword) : undefined;
  const { status, body } = await renewalCheckout(link.phone, platform, clientEmail, clientPassword);
  res.status(status).json(body);
});

// ─────────────────────────────────────────────────────────────
// LINK DE PAGO DE RENOVACIÓN (💬 Reno-manual) — varias cuentas, un solo
// pago. Público como /renew-code (el código del link es la llave). Cada
// monto Yape reservado dura 5 min (igual que en el bot); si se vence sin
// pagar, el siguiente POST /order reserva uno nuevo. El link entero vale
// hasta la medianoche (hora Lima) del día en que se creó.
// ─────────────────────────────────────────────────────────────

const PAY_LINK_ORDER_TTL_MS = 5 * 60 * 1000;
// Margen para no mostrar un monto al que le quedan segundos — si quedan
// menos de 30s se reserva uno nuevo de una vez.
const PAY_LINK_ORDER_MIN_LEFT_MS = 30 * 1000;

type PayLinkView =
  | { status: number; error: string }
  | { status: 200; link: NonNullable<ReturnType<typeof findPayLink>>; states: ReturnType<typeof itemStates> };

function loadPayLink(code: string): PayLinkView {
  const link = findPayLink(code);
  if (!link) return { status: 404, error: "Este link no existe. Pídele uno nuevo a tu vendedor." };
  const states = itemStates(link).filter(s => s.valid);
  const allPaid = states.length > 0 && states.every(s => s.paid);
  if (!allPaid && isPayLinkExpired(link)) {
    return { status: 410, error: "Este link ya venció (era válido solo hasta la medianoche). Pídele uno nuevo a tu vendedor." };
  }
  if (states.length === 0) return { status: 410, error: "Estas cuentas ya no están pendientes de renovar." };
  return { status: 200, link, states };
}

function publicPayLinkBody(view: Extract<PayLinkView, { link: unknown }>, extra: Record<string, unknown> = {}) {
  const { link, states } = view;
  return {
    paid: states.every(s => s.paid),
    expiresAt: link.expiresAt,
    discountMin: MULTI_DISCOUNT_MIN, discountPct: MULTI_DISCOUNT_PCT,
    items: states.map(s => ({
      // Link abierto solo con el número (liordark.com/renovar): el nombre
      // del perfil va tapado, por si alguien prueba un número ajeno.
      key: s.key, kind: s.kind, label: s.label, profileName: link.origin === "self" ? maskName(s.profileName) : s.profileName,
      price: s.price, daysLeft: daysLeft(s.expiresAt), paid: s.paid,
    })),
    ...extra,
  };
}

function maskName(name: string): string {
  const n = String(name || "").trim();
  return n ? n.slice(0, 2) + "•••" : "";
}

// ─────────────────────────────────────────────────────────────
// RENOVAR CON UN SOLO LINK — liordark.com/renovar
// El mismo enlace para todos (difusión o SMS): el cliente escribe su
// celular y entra directo a su link de pago con TODAS sus cuentas que
// vencen en los próximos 3 días (los avisos salen 1 día antes; por su
// cuenta puede adelantarse hasta 3 días). Mismo descuento por 2 o más y mismo pago Yape automático que el
// 💬 Reno-manual). Solo se muestra plataforma, días y precio — nunca
// correos ni contraseñas — y con límite de intentos por conexión.
// ─────────────────────────────────────────────────────────────
const SELF_RENEW_WINDOW_DAYS = 3;
const renewLookupLimit = loginRateLimit("renew-lookup", 10, 10 * 60 * 1000);

router.post("/renew-lookup", renewLookupLimit, (req, res) => {
  const digits = String(req.body?.phone ?? "").replace(/\D/g, "");
  const last9 = digits.slice(-9);
  if (last9.length < 9 || !last9.startsWith("9")) {
    return res.status(400).json({ message: "Escribe tu número de celular (9 dígitos, empieza con 9)." });
  }
  const all = listPayLinkCandidates(last9, daysLeft);
  const soon = all.filter(c => {
    const left = daysLeft(c.expiresAt);
    return c.eligible && left !== null && left <= SELF_RENEW_WINDOW_DAYS;
  });
  if (soon.length === 0) {
    const alreadyPaid = all.some(c => c.reason === "Ya pagó su renovación");
    const later = all
      .filter(c => c.eligible)
      .map(c => daysLeft(c.expiresAt))
      .filter((d): d is number => d !== null && d > SELF_RENEW_WINDOW_DAYS)
      .sort((a, b) => a - b)[0];
    return res.status(404).json({
      message: alreadyPaid
        ? "Ya renovaste tus cuentas. ¡Gracias! 🥭"
        : later !== undefined
          ? `Tu cuenta vence en ${later} días. Podrás renovarla desde ${SELF_RENEW_WINDOW_DAYS} días antes de que venza. 🥭`
          : "No encontramos cuentas por renovar con ese número. Revisa que sea el número con el que compraste.",
    });
  }
  cleanOldPayLinks();
  const link = findOrCreateSelfPayLink("51" + last9, soon);
  res.json({ code: link.code });
});

// GET ?order=<orderName> → además dice si ESA orden ya se pagó (la página
// lo consulta cada 4s mientras muestra el monto).
router.get("/renew-pack/:code", (req, res) => {
  const view = loadPayLink(req.params.code);
  if (!("link" in view)) return res.status(view.status).json({ message: view.error });
  const order = String(req.query.order ?? "");
  res.json(publicPayLinkBody(view, order ? { orderPaid: isPayLinkOrderPaid(view.link.code, order) } : {}));
});

// POST { keys } → reserva (o reutiliza) el monto Yape para lo que el
// cliente marcó. Si cambia la selección se reserva otro monto; el anterior
// se vence solo en 5 min (el bot lo borra).
router.post("/renew-pack/:code/order", async (req, res) => {
  const view = loadPayLink(req.params.code);
  if (!("link" in view)) return res.status(view.status).json({ message: view.error });
  const { link, states } = view;

  const requested: string[] = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : states.map(s => s.key);
  const chosen = states.filter(s => !s.paid && requested.includes(s.key));
  if (chosen.length === 0) {
    return res.json(publicPayLinkBody(view, { order: null }));
  }
  const keys = chosen.map(s => s.key).sort();
  const pricing = priceSelection(chosen);

  const sameSelection = link.currentKeys.slice().sort().join("|") === keys.join("|");
  if (sameSelection && link.currentOrder && link.currentAmount && link.currentOrderAt
      && !isPayLinkOrderPaid(link.code, link.currentOrder)) {
    const expiresAtMs = new Date(link.currentOrderAt).getTime() + PAY_LINK_ORDER_TTL_MS;
    if (expiresAtMs - Date.now() > PAY_LINK_ORDER_MIN_LEFT_MS) {
      return res.json(publicPayLinkBody(view, { ...pricing, order: { name: link.currentOrder, amount: link.currentAmount, expiresAtMs } }));
    }
  }

  const label = ("RENOVACIÓN x" + chosen.length + ": " + chosen.map(c => c.label).join(" + ")).slice(0, 120);
  try {
    const response = await axios.post(
      env.BOT_BASE_URL + "/api/web-orders",
      {
        phone: link.clientPhone,
        isRenewal: true,
        renewalBundle: { platforms: chosen.flatMap(c => c.platforms), totalPrice: parseFloat(pricing.total), label },
      },
      { headers: { "x-dashboard-key": env.DASHBOARD_API_KEY }, timeout: 15_000 }
    );
    const orderName = String(response.data.orderName);
    const amount    = String(response.data.amount);
    setPayLinkOrder(link.code, orderName, amount, keys);
    res.json(publicPayLinkBody(view, { ...pricing, order: { name: orderName, amount, expiresAtMs: Date.now() + PAY_LINK_ORDER_TTL_MS } }));
  } catch (err: any) {
    const message = err?.response?.data?.message || "No se pudo generar el monto. Intenta de nuevo en unos segundos.";
    res.status(err?.response?.status === 422 ? 409 : 502).json({ message });
  }
});

// GET /api/store/catalog — productos + combos activos, con disponibilidad
// real (mismo dato que ya usa el bot) para que la web no venda algo que
// no se puede entregar. PÚBLICO a propósito — liordark.com ahora abre
// directo en el catálogo, sin pedir sesión; recién se exige login al
// intentar comprar (ver /checkout, /checkout de combo, etc. abajo).
router.get("/catalog", (_req, res) => {
  const available = availabilityByPlatform();

  const products = listCatalogProducts(true).map(p => {
    const plans = plansFor(p.platform);
    return {
      ...p,
      ...(plans ? {
        price: money(plans[0]!.price),
        plans: plans.map(pl => ({ months: pl.months, label: pl.label, price: money(pl.price) })),
      } : {}),
      available: availableFor(p.platform, available),
    };
  });

  const combos = listCombos(true).map(c => ({
    ...c,
    inStock: c.items.every(i => availableFor(i.platform, available) >= i.quantity),
  }));

  res.json({ products, combos });
});

// GET /api/store/payment-methods — QR de Yape, etc. PÚBLICO a propósito,
// igual que /catalog: no es sensible, y ahora también lo usa renovar.html
// (link del correo, sin sesión de cliente).
router.get("/payment-methods", (_req, res) => {
  res.json({ methods: listPaymentMethods().filter(m => m.active) });
});

// GET /api/store/recent-purchases — «movimiento» de la tienda: compras
// CONFIRMADAS de las últimas 72 h (máx. 20, la más nueva primero). PÚBLICO:
// solo { platformLabel, minutesAgo } — sin nombres, celulares, correos ni
// montos. Se guarda 60 s en memoria para no consultar la base en cada visita.
const RECENT_PURCHASES_TTL_MS = 60_000;
let recentPurchasesCache: { at: number; data: RecentPurchase[] } | null = null;
router.get("/recent-purchases", (_req, res) => {
  if (!recentPurchasesCache || Date.now() - recentPurchasesCache.at > RECENT_PURCHASES_TTL_MS) {
    let data: RecentPurchase[] = [];
    try { data = listRecentConfirmedPurchases(72, 20); } catch (err) { console.error("recent-purchases:", err); }
    recentPurchasesCache = { at: Date.now(), data };
  }
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json({ purchases: recentPurchasesCache.data });
});

// Link de venta: estado público (vencido/pagado/anulado), sin datos del pedido.
router.get("/sale-link-status/:code", (req, res) => {
  res.json(saleLinkStatus(String(req.params.code)));
});

router.use(requireCustomerSession);

// GET /api/store/orders/:orderName/status — ¿ya se confirmó el pago de MI
// pedido? Solo responde por pedidos hechos por este mismo cliente desde la
// tienda (ver store_web_orders); para cualquier otro, 404. Lo usa el
// checkout de una reserva sin stock para mostrar «¡Pago aprobado!» recién
// cuando el pago de esa orden está confirmado, nunca antes.
router.get("/orders/:orderName/status", (req, res) => {
  const customerId = (req as unknown as RequestWithCustomer).customerId;
  const orderName = String(req.params.orderName || "");
  if (!orderName || orderName.length > 80) return res.status(400).json({ message: "Pedido inválido." });
  const status = storeOrderPaymentStatus(orderName, customerId);
  if (!status.found) return res.status(404).json({ message: "Ese pedido no es de tu cuenta." });
  res.setHeader("Cache-Control", "no-store");
  res.json({ paid: status.paid });
});

// Link de venta: el pedido armado por el admin (solo si es de este cliente).
router.get("/sale-link/:code", (req, res) => {
  const data = saleLinkForCustomer(String(req.params.code), (req as unknown as RequestWithCustomer).customerId);
  if (!data) return res.status(404).json({ message: "Este link no es de tu cuenta." });
  res.json(data);
});

// ─────────────────────────────────────────────────────────────
// CÓDIGOS — el cliente ve sus cuentas activas con código y toca la que
// necesita: se abre una consulta (el mismo visor de liordark.com/codigo/…,
// que revisa al proveedor cada 30 s). Máximo CODES_PER_ACCOUNT_PER_DAY
// consultas por cuenta al día; si ya hay una abierta se reutiliza (no
// gasta otra). El cliente nunca elige qué se consulta ni a quién: solo
// el id de una cuenta que sea suya; el resto lo decide el servidor.
// ─────────────────────────────────────────────────────────────

const CODES_PER_ACCOUNT_PER_DAY = 3;

function codesAccountsFor(phone: string) {
  const seen = new Set<number>();
  return listClientCodesAccounts(phone).filter(a => {
    if (seen.has(a.accountId)) return false;
    seen.add(a.accountId);
    return !!getAccountCodeSource(a.accountId);
  });
}

router.get("/codes", (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const customer   = findCustomerById(customerId);
  if (!customer) return res.status(401).json({ message: "Sesión inválida." });

  const accounts = codesAccountsFor(customer.phone).map(a => {
    const used = countClientLinksToday(a.accountId, customer.phone);
    const open = findOpenClientLink(a.accountId, customer.phone);
    return {
      accountId:   a.accountId,
      platform:    a.platform,
      email:       a.email,
      profileName: a.profileName || "",
      expiresAt:   a.expiresAt,
      is2fa:       getAccountCodeSource(a.accountId) === TOTP_SOURCE_ID,
      used,
      limit:       CODES_PER_ACCOUNT_PER_DAY,
      remaining:   Math.max(0, CODES_PER_ACCOUNT_PER_DAY - used),
      openUrl:     open ? "/codigo/" + open.token + "?from=tienda" : null,
    };
  });
  res.json({ accounts, limit: CODES_PER_ACCOUNT_PER_DAY });
});

router.post("/codes/:accountId/open", (req, res) => {
  const customerId = (req as unknown as RequestWithCustomer).customerId;
  const customer   = findCustomerById(customerId);
  if (!customer) return res.status(401).json({ message: "Sesión inválida." });

  const accountId = Number(req.params.accountId);
  const account = codesAccountsFor(customer.phone).find(a => a.accountId === accountId);
  if (!account) return res.status(404).json({ message: "Esa cuenta no tiene códigos disponibles en tu perfil." });

  // Ya hay una consulta abierta para esta cuenta: se reutiliza.
  const open = findOpenClientLink(accountId, customer.phone);
  if (open) return res.json({ url: "/codigo/" + open.token + "?from=tienda", reused: true });

  const used = countClientLinksToday(accountId, customer.phone);
  if (used >= CODES_PER_ACCOUNT_PER_DAY) {
    return res.status(429).json({
      message: `Ya usaste tus ${CODES_PER_ACCOUNT_PER_DAY} consultas de hoy para esta cuenta. Mañana se renuevan; si es urgente, escríbenos por Soporte.`,
    });
  }

  const sourceId = getAccountCodeSource(accountId)!;
  const isTotp = sourceId === TOTP_SOURCE_ID;
  const minutes = isTotp ? 2 : codeWaitMinutes(sourceId, account.platform) > 1 ? 8 : 5;
  const link = createCodeLink({
    accountId, email: account.email, sourceId, clientPhone: customer.phone, createdBy: "client", minutes,
  });
  res.json({ url: "/codigo/" + link.token + "?from=tienda", reused: false, remaining: CODES_PER_ACCOUNT_PER_DAY - used - 1 });
});

// GET /api/store/dashboard — cuentas activas del cliente logueado, con
// días restantes. El checkout de la web hace polling acá para saber si
// ya le llegó la cuenta que acaba de pagar (no hay WhatsApp que le avise).
router.get("/dashboard", (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const customer   = findCustomerById(customerId);
  if (!customer) {
    return res.status(401).json({ message: "Sesión inválida." });
  }

  const accounts = listAccountsByClientPhone(customer.phone).map(a => ({
    ...a,
    daysLeft: daysLeft(a.expiresAt),
  }));

  // Vencidas — sin password, ver listArchivedAccountsByPhone.
  const expiredAccounts = listArchivedAccountsByPhone(customer.phone);

  res.json({ accounts, expiredAccounts });
});

// ─────────────────────────────────────────────────────────────
// CORREO PARA AVISO DE VENCIMIENTO — banner al ingresar (si no tiene) y
// botón "Recordatorio de vencimiento" en Mis cuentas. GET lo consulta
// (para no volver a pedirlo si ya lo tiene), POST lo guarda/actualiza.
// ─────────────────────────────────────────────────────────────

router.get("/account/email", (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const customer   = findCustomerById(customerId);
  if (!customer) {
    return res.status(401).json({ message: "Sesión inválida." });
  }
  res.json({ email: customer.email });
});

router.post("/account/email", (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const customer   = findCustomerById(customerId);
  if (!customer) {
    return res.status(401).json({ message: "Sesión inválida." });
  }

  const email = String(req.body?.email ?? "").trim();
  if (!isSafeEmail(email)) {
    return res.status(400).json({ message: "Ingresa un correo válido." });
  }

  const updated = setCustomerEmail(customer.id, email);
  res.json({ email: updated?.email || email });
});

// Igual que generateExpiryNotifications en wholesaler.routes.ts — "cuenta por
// vencer" no tiene un evento propio, se genera acá mismo, de forma perezosa,
// cada vez que ESTE cliente pide sus notificaciones (mismo polling del front).
const EXPIRY_NOTIFY_DAYS = 1;

function generateExpiryNotificationsForCustomer(phone: string): void {
  const expiring = listUnnotifiedExpiringClientsForCustomer(phone, EXPIRY_NOTIFY_DAYS);
  for (const c of expiring) {
    createCustomerNotification(phone, "expiring", c.platform, c.email);
    markExpiryNotified(c.profileId);
  }
}

/** Mismo criterio, pero para TODOS los clientes de una — job proactivo
 *  (ver runGenerateExpiryNotifications en index.ts) para que la campanita
 *  no dependa de que el cliente entre a la web a pedirla. */
export function generateExpiryNotificationsForAllCustomers(): void {
  const expiring = listAllUnnotifiedExpiringRetailClients(EXPIRY_NOTIFY_DAYS);
  for (const c of expiring) {
    createCustomerNotification(c.clientPhone, "expiring", c.platform, c.email);
    markExpiryNotified(c.profileId);
  }
}

// GET /api/store/notifications — campanita del topbar: solo avisos de
// cuenta nueva o renovada, para ESTE cliente logueado.
router.get("/notifications", (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const customer   = findCustomerById(customerId);
  if (!customer) {
    return res.status(401).json({ message: "Sesión inválida." });
  }

  generateExpiryNotificationsForCustomer(customer.phone);

  res.json({
    notifications: listCustomerNotifications(customer.phone),
    unreadCount:   countUnreadCustomerNotifications(customer.phone),
  });
});

// POST /api/store/notifications/read — marca todas las notificaciones
// como leídas (se llama al abrir la campanita).
router.post("/notifications/read", (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const customer   = findCustomerById(customerId);
  if (!customer) {
    return res.status(401).json({ message: "Sesión inválida." });
  }

  markAllCustomerNotificationsRead(customer.phone);
  res.json({ ok: true });
});

// POST /api/store/notifications/clear — tachito: borra todo el historial.
router.post("/notifications/clear", (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const customer   = findCustomerById(customerId);
  if (!customer) {
    return res.status(401).json({ message: "Sesión inválida." });
  }

  deleteAllCustomerNotifications(customer.phone);
  res.json({ ok: true });
});

// POST /api/store/checkout — { platform } o { comboId } → reserva el
// monto único en el bot (mismo mecanismo que ya usa WhatsApp) y lo devuelve.
router.post("/checkout", async (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const customer   = findCustomerById(customerId);
  if (!customer) {
    return res.status(401).json({ message: "Sesión inválida." });
  }

  const platform       = req.body?.platform ? String(req.body.platform).trim() : undefined;
  const comboId        = req.body?.comboId ? Number(req.body.comboId) : undefined;
  const clientEmail    = cleanEmail(req.body?.clientEmail);
  if (req.body?.clientPassword && !isSafeClientPassword(req.body.clientPassword)) {
    return res.status(400).json({ message: BAD_CLIENT_PASSWORD });
  }
  const clientPassword = req.body?.clientPassword ? String(req.body.clientPassword) : undefined;

  // Planes por meses (GEMINI): 1, 3, 6 o 12 meses — el precio sale del plan,
  // nunca del navegador.
  const planOptions = platform ? plansFor(platform) : null;
  const plan = platform && planOptions ? planFor(platform, req.body?.months ?? 1) : null;
  if (planOptions && !plan) {
    return res.status(400).json({ message: "Elige un plan válido (1, 3, 6 o 12 meses)." });
  }

  // Combo armado por el cliente ("¿Quieres armar tu combo? ¡Hazlo!") —
  // lista de plataformas elegidas, sin id de catálogo. Se valida y se
  // calcula el precio ACÁ (el panel es la fuente real de precios), nunca
  // se confía en un total que mande el navegador.
  const rawCustomCombo: unknown[] | undefined = Array.isArray(req.body?.customComboPlatforms) ? req.body.customComboPlatforms : undefined;
  const customComboPlatforms: string[] | undefined = rawCustomCombo
    ? [...new Set(rawCustomCombo.map((p: unknown) => String(p).trim().toUpperCase()).filter((s: string) => s.length > 0))]
    : undefined;

  if (!platform && !comboId && !customComboPlatforms) {
    return res.status(400).json({ message: "Falta 'platform', 'comboId' o 'customComboPlatforms'." });
  }

  // CANVA, GEMINI AI PRO y YOUTUBE PREMIUM se activan a mano con el correo
  // del cliente (YOUTUBE además con su contraseña) — sin eso el pedido
  // llega sin forma de completarse.
  if (platform && isManualActivationPlatform(platform) && !clientEmail) {
    return res.status(400).json({ message: "Falta el correo para activar " + platform + "." });
  }
  if (platform && requiresPasswordPlatform(platform) && !clientPassword) {
    return res.status(400).json({ message: "Falta la contraseña para activar " + platform + "." });
  }

  // Defensa por si algo saltea la validación del navegador (ej. una
  // pestaña vieja que no recargó el catálogo) — para combos, nunca vender
  // sin stock real (serían varias plataformas a la vez, no se maneja
  // reserva parcial acá). Un perfil SUELTO sin stock SÍ se deja pasar a
  // propósito — el cliente paga como reserva y la orden queda pendiente
  // hasta que el bot revalide stock solo (misma cola que ya usa
  // WhatsApp — ver startAutoRevalidateNoStockJob en el repo del bot).
  const available = availabilityByPlatform();
  let customComboTotalPrice = 0;

  if (platform) {
    // sin guard de stock — reserva permitida
  } else if (comboId) {
    const combo = listCombos(true).find(c => c.id === comboId);
    if (!combo) {
      return res.status(404).json({ message: "Combo no encontrado." });
    }
    const inStock = combo.items.every(i => availableFor(i.platform, available) >= i.quantity);
    if (!inStock) {
      return res.status(409).json({ message: "Sin stock disponible ahora mismo para este combo." });
    }
  } else if (customComboPlatforms) {
    if (customComboPlatforms.length < MIN_CUSTOM_COMBO_ITEMS) {
      return res.status(400).json({ message: `Un combo armado necesita al menos ${MIN_CUSTOM_COMBO_ITEMS} productos.` });
    }
    // CANVA, GEMINI AI PRO y YOUTUBE PREMIUM dentro de un combo armado —
    // mismo correo (y, si incluye YOUTUBE, contraseña) que se les pide en
    // la compra suelta, acá para todo el combo de una vez.
    if (customComboPlatforms.some(isManualActivationPlatform) && !clientEmail) {
      return res.status(400).json({ message: "Falta el correo para activar las plataformas de tu combo." });
    }
    if (customComboPlatforms.some(requiresPasswordPlatform) && !clientPassword) {
      return res.status(400).json({ message: "Falta la contraseña para activar YouTube Premium en tu combo." });
    }
    const catalog = listCatalogProducts(true);
    let sum = 0;
    for (const plat of customComboPlatforms) {
      const product = catalog.find(p => p.platform.trim().toUpperCase() === plat);
      if (!product) {
        return res.status(404).json({ message: "Producto no encontrado: " + plat });
      }
      if (availableFor(plat, available) <= 0) {
        return res.status(409).json({ message: "Sin stock disponible ahora mismo para " + product.title + "." });
      }
      sum += parseFloat(product.price);
    }
    const rate = customComboDiscountRate(customComboPlatforms.length);
    customComboTotalPrice = Math.round(sum * (1 - rate) * 100) / 100;
  }

  try {
    // normalizePeruPhone por si el customer.phone quedó guardado sin el
    // "51" (cuenta creada antes del fix, o dato viejo) — igual que en
    // /renewals/checkout, evita mandar una orden sin el prefijo completo.
    const response = await axios.post(
      env.BOT_BASE_URL + "/api/web-orders",
      {
        phone: normalizePeruPhone(customer.phone),
        platform, comboId, clientEmail, clientPassword,
        ...(plan ? { planPrice: plan.price, planMonths: plan.months } : {}),
        customCombo: customComboPlatforms
          ? {
              platforms:  customComboPlatforms,
              totalPrice: customComboTotalPrice,
              comboName:  "Combo armado (" + customComboPlatforms.length + ")",
            }
          : undefined,
      },
      { headers: { "x-dashboard-key": env.DASHBOARD_API_KEY }, timeout: 15_000 }
    );
    if (plan && platform && response.data?.orderName) savePlanOrder(String(response.data.orderName), platform, plan.months);
    if (response.data?.orderName) saveStoreWebOrder(String(response.data.orderName), customerId);
    // Compra que vino de un link de venta: la orden queda ligada al link
    // (el panel lo marca «Pagado» cuando llega el Yape de esa orden).
    if (req.body?.saleLink && response.data?.orderName) {
      const sl = findSaleLink(String(req.body.saleLink));
      if (sl && sl.customerId === customerId && isSaleLinkUsable(saleLinkState(sl))) {
        addSaleLinkOrder(sl.code, String(response.data.orderName));
      }
    }
    res.json({ orderName: response.data.orderName, amount: response.data.amount });
  } catch (err: any) {
    const message = err?.response?.data?.message || "No se pudo crear la orden. Intenta de nuevo.";
    res.status(err?.response?.status || 502).json({ message });
  }
});

// ─────────────────────────────────────────────────────────────
// SOPORTE — el asistente de la tienda es solo botones y no guarda ninguna
// conversación. Lo único que llega al panel (Soportes) es el reporte de
// una cuenta «sin suscripción», una vez por cuenta mientras siga abierto.
// El resto (no puedo ingresar, otro problema) va directo a WhatsApp.
// ─────────────────────────────────────────────────────────────

function requireStoreUser(req: any, res: any): { phone: string } | null {
  const customerId = (req as RequestWithCustomer).customerId;
  const customer   = findCustomerById(customerId);
  if (!customer) { res.status(401).json({ message: "Sesión inválida." }); return null; }
  return { phone: customer.phone };
}

router.get("/support/accounts", (req, res) => {
  const who = requireStoreUser(req, res);
  if (!who) return;
  res.json({ accounts: listReportableAccounts(who.phone) });
});

router.post("/support/reports", (req, res) => {
  const who = requireStoreUser(req, res);
  if (!who) return;
  const platform = String(req.body?.platform ?? "").trim().slice(0, 60);
  const email    = String(req.body?.email ?? "").trim().slice(0, 200);
  if (!platform || !email) return res.status(400).json({ message: "Falta elegir la cuenta." });
  const result = reportNoSubscription(who.phone, platform, email);
  if (!result.ok) return res.status(result.status).json({ message: result.message });
  emitDashboardEvent({ type: "support_report", id: result.ticket.id, platform: result.ticket.platform });
  res.status(201).json({ ok: true, platformTag: result.ticket.platformTag, email: result.ticket.accountEmail });
});

// El chat ya no existe. Si alguien igual intenta escribir con enlaces o
// código (scripts del atacante), se trata como ataque.
router.use("/chat", (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const customer   = customerId ? findCustomerById(customerId) : null;
  const raw = String(req.body?.text ?? "").slice(0, 5000);
  const suspicious = raw ? suspiciousReason(raw) : null;
  if (customer && suspicious) {
    autoBlockCustomer(customer.phone, clientIp(req), suspicious, raw);
    res.clearCookie(CUSTOMER_SESSION_COOKIE);
    return res.status(403).json({ message: "Por seguridad cerramos tu sesión. Escríbenos por WhatsApp al +51 963 081 436.", blocked: true });
  }
  res.status(410).json({ message: "El chat ya no está disponible. Usa «Soporte» o escríbenos por WhatsApp al +51 963 081 436." });
});

export default router;
