import { Router } from "express";
import axios from "axios";
import { env } from "../config/env";
import { requireCustomerSession, type RequestWithCustomer } from "../services/customer-auth.service";
import { findCustomerById } from "../db/customer.repository";
import { listCatalogProducts } from "../db/catalog.repository";
import { listCombos } from "../db/combo.repository";
import { listPaymentMethods } from "../db/payment-method.repository";
import { listAccountsByClientPhone, listPlatforms, listRenewalAccountsByPhone } from "../db/access.repository";
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

// Códigos — en pruebas, solo para este celular (a pedido explícito). Se
// quita esta restricción cuando se dé por probado.
const CODES_TEST_PHONE = "977430941";
function isCodesTestUser(phone: string): boolean {
  return phone.replace(/\D/g, "").slice(-9) === CODES_TEST_PHONE;
}

// Mismo criterio de disponibilidad que ya usa el bot de WhatsApp
// (GET /api/stock/catalog y /combos) — sellableCount ya excluye
// perfiles libres pero a punto de vencer, no se vuelve a inventar acá.
function availabilityByPlatform(): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of listPlatforms()) map.set(s.platform.trim().toUpperCase(), s.sellableCount);
  return map;
}

// CANVA y GEMINI AI PRO no tienen perfiles pre-cargados — se activan a
// mano con el correo del cliente tras cada pedido. Mismo chequeo para
// dos cosas: su sellableCount real es siempre 0 (sin este caso especial
// la web las mostraría como "sin stock" permanentemente), y el checkout
// exige el correo (sin eso el pedido no tiene forma de completarse).
function isManualActivationPlatform(platform: string): boolean {
  return /canva|gemini/i.test(platform);
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
// TIENDA WEB (liordark.com) — todo detrás de sesión de cliente, como
// pidió el negocio: nada se ve sin loguearse primero.
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
  const phone       = normalizePeruPhone(String(req.body?.phone ?? ""));
  const platform    = req.body?.platform ? String(req.body.platform).trim() : undefined;
  const clientEmail = req.body?.clientEmail ? String(req.body.clientEmail).trim() : undefined;

  if (phone.length < 9 || !platform) {
    return res.status(400).json({ message: "Falta 'phone' o 'platform'." });
  }

  // CANVA y GEMINI AI PRO se activan a mano con el correo del cliente —
  // igual que en una compra nueva, sin eso el pedido llega sin forma de completarse.
  if (isManualActivationPlatform(platform) && !clientEmail) {
    return res.status(400).json({ message: "Falta el correo para activar " + platform + "." });
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
      { phone, platform, clientEmail, isRenewal: true },
      { headers: { "x-dashboard-key": env.DASHBOARD_API_KEY }, timeout: 15_000 }
    );
    res.json({ orderName: response.data.orderName, amount: response.data.amount });
  } catch (err: any) {
    const message = err?.response?.data?.message || "No se pudo crear la orden. Intenta de nuevo.";
    res.status(err?.response?.status || 502).json({ message });
  }
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

// GET /api/store/catalog — productos + combos activos, con disponibilidad
// real (mismo dato que ya usa el bot) para que la web no venda algo que
// no se puede entregar.
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

// GET /api/store/payment-methods — para mostrar el QR de Yape, etc.
router.get("/payment-methods", (_req, res) => {
  res.json({ methods: listPaymentMethods().filter(m => m.active) });
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

// POST /api/store/checkout — { platform } o { comboId } → reserva el
// monto único en el bot (mismo mecanismo que ya usa WhatsApp) y lo devuelve.
router.post("/checkout", async (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const customer   = findCustomerById(customerId);
  if (!customer) {
    return res.status(401).json({ message: "Sesión inválida." });
  }

  const platform    = req.body?.platform ? String(req.body.platform).trim() : undefined;
  const comboId     = req.body?.comboId ? Number(req.body.comboId) : undefined;
  const clientEmail = req.body?.clientEmail ? String(req.body.clientEmail).trim() : undefined;

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

  // CANVA y GEMINI AI PRO se activan a mano con el correo del cliente —
  // sin eso el pedido llega sin forma de completarse.
  if (platform && isManualActivationPlatform(platform) && !clientEmail) {
    return res.status(400).json({ message: "Falta el correo para activar " + platform + "." });
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
        platform, comboId, clientEmail,
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

export default router;
