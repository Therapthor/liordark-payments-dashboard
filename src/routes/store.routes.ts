import { Router } from "express";
import axios from "axios";
import multer from "multer";
import { env } from "../config/env";
import { requireCustomerSession, type RequestWithCustomer } from "../services/customer-auth.service";
import { findCustomerById, setCustomerEmail } from "../db/customer.repository";
import { listCatalogProducts } from "../db/catalog.repository";
import { listCombos } from "../db/combo.repository";
import { listPaymentMethods } from "../db/payment-method.repository";
import {
  listAccountsByClientPhone, listPlatforms, listRenewalAccountsByPhone, getActiveAccountForClient,
  listUnnotifiedExpiringClientsForCustomer, listAllUnnotifiedExpiringRetailClients, markExpiryNotified,
} from "../db/access.repository";
import { listArchivedAccountsByPhone } from "../db/access-history.repository";
import { daysLeft } from "../services/access.service";
import { normalizePeruPhone } from "../utils/phone.util";
import {
  listClientCodesAccounts,
  clientOwnsCodesAccount,
  getCodeRequestState,
  registerCodeRequest,
  getLatestCodeForAccount,
  MAX_CODE_REQUESTS_PER_ACCOUNT,
} from "../db/codes.repository";
import {
  createCustomerNotification,
  listCustomerNotifications,
  countUnreadCustomerNotifications,
  markAllCustomerNotificationsRead,
  deleteAllCustomerNotifications,
} from "../db/customer-notifications.repository";
import { verifyRenewalToken } from "../utils/renewal-token.util";
import {
  getOrCreateOpenChatForPhone, findChatByPhone, listMessages, addMessage, setTyping, markSeen,
  countUnreadForCustomer, isValidStickerId,
} from "../db/support-chat.repository";
import { uploadChatMedia } from "../services/cloudinary.service";
import { onChatEvent, emitChatEvent } from "../utils/chat-events.util";

// Códigos — en pruebas, solo para este celular (a pedido explícito). Se
// quita esta restricción cuando se dé por probado.
const CODES_TEST_PHONE = "977430941";
function isCodesTestUser(phone: string): boolean {
  return phone.replace(/\D/g, "").slice(-9) === CODES_TEST_PHONE;
}

// Botón "Soporte" (Mis cuentas) — mismo celular de prueba que Códigos,
// a pedido explícito. Se quita esta restricción cuando se dé por probado.
const SUPPORT_TEST_PHONE = "977430941";
function isSupportTestUser(phone: string): boolean {
  return phone.replace(/\D/g, "").slice(-9) === SUPPORT_TEST_PHONE;
}

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

const router = Router();

// ─────────────────────────────────────────────────────────────
// RENOVACIONES — PÚBLICO, sin sesión de cliente a propósito. Muchos
// clientes compraron por WhatsApp y nunca se registraron en la web, así
// que exigir login los dejaría afuera. El celular ya es la identidad que
// se usa en todo el negocio (WhatsApp, Accesos) — acá se reutiliza igual,
// nunca se expone contraseña, solo correo (para reconocer la cuenta) y
// precio (para saber cuánto pagar).
// ─────────────────────────────────────────────────────────────

router.get("/renewals", (req, res) => {
  const phone = String(req.query.phone ?? "").replace(/\D/g, "");
  if (phone.length < 9) {
    return res.status(400).json({ message: "Ingresa un celular válido." });
  }

  const accounts = listRenewalAccountsByPhone(phone).map(a => ({
    ...a,
    daysLeft: daysLeft(a.expiresAt),
  }));

  res.json({ accounts });
});

router.post("/renewals/checkout", async (req, res) => {
  // Normalizado ACÁ (con el "51" si hace falta) antes de mandarlo al bot —
  // si no, un cliente que tipeó su celular sin el prefijo terminaría con
  // una orden/perfil sin el prefijo, y WhatsApp nunca le llegaría el
  // mensaje de confirmación (la API de Meta exige el número completo).
  const phone          = normalizePeruPhone(String(req.body?.phone ?? ""));
  const platform       = req.body?.platform ? String(req.body.platform).trim() : undefined;
  const clientEmail    = req.body?.clientEmail ? String(req.body.clientEmail).trim() : undefined;
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
  const owns = listRenewalAccountsByPhone(phone).some(a => a.platform.trim().toUpperCase() === platform.trim().toUpperCase());
  if (!owns) {
    return res.status(404).json({ message: "No encontramos esa cuenta para este celular." });
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

router.get("/renew/:token", (req, res) => {
  const payload = verifyRenewalToken(req.params.token);
  if (!payload) {
    return res.status(410).json({ message: "Este link ya venció. Entra a liordark.com para renovar." });
  }

  const account = listRenewalAccountsByPhone(payload.phone)
    .find(a => a.platform.trim().toUpperCase() === payload.platform.trim().toUpperCase());
  if (!account) {
    return res.status(404).json({ message: "Esa cuenta ya no está pendiente de renovar." });
  }

  res.json({
    platform:    account.platform,
    platformTag: account.platformTag,
    price:       account.price,
    daysLeft:    daysLeft(account.expiresAt),
    needsEmail:    isManualActivationPlatform(account.platform),
    needsPassword: requiresPasswordPlatform(account.platform),
  });
});

router.post("/renew/:token/checkout", async (req, res) => {
  const payload = verifyRenewalToken(req.params.token);
  if (!payload) {
    return res.status(410).json({ message: "Este link ya venció. Entra a liordark.com para renovar." });
  }

  const { phone, platform } = payload;
  const clientEmail    = req.body?.clientEmail ? String(req.body.clientEmail).trim() : undefined;
  const clientPassword = req.body?.clientPassword ? String(req.body.clientPassword) : undefined;

  if (isNonRenewablePlatform(platform)) {
    return res.status(400).json({ message: platform + " no es renovable — se compra nuevamente." });
  }
  if (isManualActivationPlatform(platform) && !clientEmail) {
    return res.status(400).json({ message: "Falta el correo para activar " + platform + "." });
  }
  if (requiresPasswordPlatform(platform) && !clientPassword) {
    return res.status(400).json({ message: "Falta la contraseña para activar " + platform + "." });
  }

  const owns = listRenewalAccountsByPhone(phone).some(a => a.platform.trim().toUpperCase() === platform.trim().toUpperCase());
  if (!owns) {
    return res.status(404).json({ message: "Esa cuenta ya no está pendiente de renovar." });
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

// GET /api/store/catalog — productos + combos activos, con disponibilidad
// real (mismo dato que ya usa el bot) para que la web no venda algo que
// no se puede entregar. PÚBLICO a propósito — liordark.com ahora abre
// directo en el catálogo, sin pedir sesión; recién se exige login al
// intentar comprar (ver /checkout, /checkout de combo, etc. abajo).
router.get("/catalog", (_req, res) => {
  const available = availabilityByPlatform();

  const products = listCatalogProducts(true).map(p => ({
    ...p,
    available: availableFor(p.platform, available),
  }));

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

router.use(requireCustomerSession);

// ─────────────────────────────────────────────────────────────
// CÓDIGOS — en pruebas, solo para CODES_TEST_PHONE. El cliente ve sus
// cuentas con "🔑 Código" habilitado (Accesos) mientras sigan activas, y
// puede pedir el código hasta MAX_CODE_REQUESTS_PER_ACCOUNT veces por
// cuenta (para siempre, sin reset automático — solo el admin resetea).
// ─────────────────────────────────────────────────────────────

router.get("/codes", (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const customer   = findCustomerById(customerId);
  if (!customer) return res.status(401).json({ message: "Sesión inválida." });

  if (!isCodesTestUser(customer.phone)) {
    return res.status(403).json({ message: "Códigos todavía está en pruebas." });
  }

  const accounts = listClientCodesAccounts(customer.phone).map(a => {
    const state = getCodeRequestState(customer.phone, a.accountId);
    return { ...a, requestsUsed: state.requestCount, requestsMax: MAX_CODE_REQUESTS_PER_ACCOUNT };
  });

  res.json({ accounts });
});

router.post("/codes/:accountId/request", (req, res) => {
  const customerId = (req as unknown as RequestWithCustomer).customerId;
  const customer   = findCustomerById(customerId);
  if (!customer) return res.status(401).json({ message: "Sesión inválida." });

  if (!isCodesTestUser(customer.phone)) {
    return res.status(403).json({ message: "Códigos todavía está en pruebas." });
  }

  const accountId = Number(req.params.accountId);
  if (!clientOwnsCodesAccount(customer.phone, accountId)) {
    return res.status(404).json({ message: "No encontramos esa cuenta activa para tu celular." });
  }

  const allowed = registerCodeRequest(customer.phone, accountId);
  if (!allowed) {
    return res.status(429).json({
      message: `Ya usaste tus ${MAX_CODE_REQUESTS_PER_ACCOUNT} pedidos de código para esta cuenta. Escríbenos por soporte si necesitas otro.`,
    });
  }

  const latest = getLatestCodeForAccount(accountId);
  res.json({
    code:       latest?.code ?? null,
    receivedAt: latest?.receivedAt ?? null,
  });
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
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
  const clientEmail    = req.body?.clientEmail ? String(req.body.clientEmail).trim() : undefined;
  const clientPassword = req.body?.clientPassword ? String(req.body.clientPassword) : undefined;

  // "¿Avisarme antes de vencer?" en el checkout — solo si todavía no tiene
  // correo guardado (no pisa uno ya confirmado desde "Mis cuentas").
  const notifyEmail = req.body?.notifyEmail ? String(req.body.notifyEmail).trim() : undefined;
  if (notifyEmail && !customer.email) {
    setCustomerEmail(customer.id, notifyEmail);
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
    res.json({ orderName: response.data.orderName, amount: response.data.amount });
  } catch (err: any) {
    const message = err?.response?.data?.message || "No se pudo crear la orden. Intenta de nuevo.";
    res.status(err?.response?.status || 502).json({ message });
  }
});

// ─────────────────────────────────────────────────────────────
// CHAT DE SOPORTE EN VIVO — de prueba, solo SUPPORT_TEST_PHONE (mismo
// gate que los reportes de arriba). El botón "💬 Soporte" de la barra
// abre esto en vez de WhatsApp SOLO para ese celular (ver app.js).
// ─────────────────────────────────────────────────────────────

const chatUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function requireChatTestUser(req: any, res: any): { phone: string } | null {
  const customerId = (req as RequestWithCustomer).customerId;
  const customer   = findCustomerById(customerId);
  if (!customer) { res.status(401).json({ message: "Sesión inválida." }); return null; }
  if (!isSupportTestUser(customer.phone)) {
    res.status(403).json({ message: "El chat todavía no está disponible para tu cuenta." });
    return null;
  }
  return { phone: customer.phone };
}

function mediaExpiresAtISO(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

router.get("/chat", (req, res) => {
  const who = requireChatTestUser(req, res);
  if (!who) return;

  const isNew = !findChatByPhone(who.phone);
  const chat = getOrCreateOpenChatForPhone(who.phone);
  markSeen(chat.id, "customer");
  if (isNew) emitChatEvent({ type: "chat_created", chatId: chat.id, clientPhone: who.phone });
  res.json({ chatId: chat.id, adminTyping: chat.adminTyping, messages: listMessages(chat.id) });
});

// GET /api/store/chat/unread — numerito en el botón "💬 Soporte" de la
// barra, sin necesidad de abrir el chat (ver polling en app.js).
router.get("/chat/unread", (req, res) => {
  const who = requireChatTestUser(req, res);
  if (!who) return;
  res.json({ count: countUnreadForCustomer(who.phone) });
});

router.post("/chat/messages", (req, res) => {
  const who = requireChatTestUser(req, res);
  if (!who) return;

  const type = req.body?.type === "account_reply" ? "account_reply" : "text";
  const chat = getOrCreateOpenChatForPhone(who.phone);

  if (req.body?.type === "sticker") {
    const stickerId = String(req.body?.stickerId ?? "");
    if (!isValidStickerId(stickerId)) return res.status(400).json({ message: "Sticker no válido." });
    const message = addMessage(chat.id, "customer", { type: "sticker", text: stickerId });
    emitChatEvent({ type: "message", chatId: chat.id, message });
    return res.status(201).json({ message });
  }

  if (type === "account_reply") {
    // Nunca confía en lo que mande el navegador para correo/contraseña —
    // se reconfirma la cuenta real del cliente, mismo criterio que los
    // reportes de soporte de arriba (getActiveAccountForClient).
    const platform     = String(req.body?.platform ?? "").trim();
    const accountEmail = String(req.body?.accountEmail ?? "").trim();
    if (!platform || !accountEmail) return res.status(400).json({ message: "Falta elegir la cuenta." });

    const account = getActiveAccountForClient(who.phone, platform, accountEmail);
    if (!account) return res.status(404).json({ message: "Esa cuenta no está activa en tu perfil." });

    const payload = JSON.stringify({
      platform: account.platform, email: account.email, password: account.password,
      expiresAt: account.expiresAt,
    });
    const message = addMessage(chat.id, "customer", { type: "account_reply", text: payload });
    emitChatEvent({ type: "message", chatId: chat.id, message });
    return res.status(201).json({ message });
  }

  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ message: "Escribe un mensaje." });

  const message = addMessage(chat.id, "customer", { type: "text", text });
  emitChatEvent({ type: "message", chatId: chat.id, message });
  res.status(201).json({ message });
});

router.post("/chat/messages/media", chatUpload.single("file"), async (req, res) => {
  const who = requireChatTestUser(req, res);
  if (!who) return;

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) return res.status(400).json({ message: "Falta el archivo." });

  const isImage = file.mimetype.startsWith("image/");
  const isVideo = file.mimetype.startsWith("video/");
  if (!isImage && !isVideo) return res.status(400).json({ message: "Solo se pueden enviar fotos o videos." });

  try {
    const chat = getOrCreateOpenChatForPhone(who.phone);
    const { url, publicId } = await uploadChatMedia(file.buffer, isImage ? "image" : "video");
    const message = addMessage(chat.id, "customer", {
      type: isImage ? "image" : "video", mediaUrl: url, mediaPublicId: publicId,
      mediaResourceType: isImage ? "image" : "video", mediaExpiresAt: mediaExpiresAtISO(),
    });
    emitChatEvent({ type: "message", chatId: chat.id, message });
    res.status(201).json({ message });
  } catch (err: any) {
    res.status(502).json({ message: err?.message || "No se pudo subir el archivo." });
  }
});

router.post("/chat/typing", (req, res) => {
  const who = requireChatTestUser(req, res);
  if (!who) return;

  const chat = getOrCreateOpenChatForPhone(who.phone);
  const typing = !!req.body?.typing;
  setTyping(chat.id, "customer", typing);
  emitChatEvent({ type: "typing", chatId: chat.id, sender: "customer", typing });
  res.json({ ok: true });
});

// SSE — mensajes y "escribiendo" del admin, en vivo. Filtra por el chat de
// ESTE celular; si todavía no tiene chat creado, no hay nada que seguir.
router.get("/chat/stream", (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const customer   = findCustomerById(customerId);
  if (!customer || !isSupportTestUser(customer.phone)) {
    return res.status(403).end();
  }

  const chat = getOrCreateOpenChatForPhone(customer.phone);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  const unsubscribe = onChatEvent((evt) => {
    if (evt.chatId !== chat.id) return;
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  });

  const ping = setInterval(() => res.write(":ping\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});

export default router;
