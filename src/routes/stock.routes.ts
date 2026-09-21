import { Router } from "express";
import { env } from "../config/env";
import { listCatalogProducts } from "../db/catalog.repository";
import {
  listPlatforms,
  sellProfile,
  releaseProfilesByPhone,
  releaseProfilesByOrderRef,
  findAccountByClientPhone,
  listExpiringClients,
  getProfileById,
  getAccountById,
  createAccountsBulk,
} from "../db/access.repository";
import { renewAccount, accountStatus, daysLeft, limaTodayISO, addDaysISO } from "../services/access.service";
import {
  createPendingOrder,
  confirmPendingOrderPayment,
  markPendingOrderAssigned,
  type OrderType,
} from "../db/pending-order.repository";
import { createRenewalLog, confirmRenewalLog } from "../db/renewal-log.repository";
import { logCanvaOrder } from "../db/canva-order.repository";
import { listPaymentMethods } from "../db/payment-method.repository";
import { getBotFlowConfig } from "../db/bot-flow.repository";
import { listCombos } from "../db/combo.repository";

// ─────────────────────────────────────────────────────────────
// API DE STOCK — consumida por el bot de WhatsApp/Telegram, NO por el
// navegador. Autenticada con x-bot-key (misma llave compartida que ya
// usa /api/integrations), no con la sesión de login del panel.
//
// Reemplaza, endpoint por endpoint, lo que el bot hoy hace contra Google
// Sheets (LISTA_PRODUCTOS + hojas de plataforma). Mientras el bot no
// llame a esto, no cambia nada de lo que ya funciona.
// ─────────────────────────────────────────────────────────────

const router = Router();

router.use((req, res, next) => {
  const key = req.header("x-bot-key");
  if (!key || key !== env.DASHBOARD_API_KEY) {
    res.status(401).json({ message: "No autorizado" });
    return;
  }
  next();
});

// GET /catalog — plataformas activas con precio/imagen/descr. y disponibilidad real.
router.get("/catalog", (_req, res) => {
  const products = listCatalogProducts(true);
  const summaries = listPlatforms();

  const catalog = products.map(p => {
    const summary = summaries.find(s => s.platform === p.platform.trim().toUpperCase());
    const available = summary ? summary.sellableCount : 0;
    return {
      platform:    p.platform,
      price:       p.price,
      title:       p.title,
      description: p.description,
      imageUrl:    p.imageUrl,
      hasProfiles: p.hasProfiles,
      keywords:    p.keywords.split(",").map(k => k.trim().toLowerCase()).filter(Boolean),
      available,
    };
  });

  res.json({ catalog });
});

// GET /combos — combos activos, con disponibilidad real de CADA plataforma
// que lo compone (inStock = false si a alguna le falta stock vendible).
router.get("/combos", (_req, res) => {
  const combos = listCombos(true);
  const summaries = listPlatforms();

  const result = combos.map(c => {
    const items = c.items.map(item => {
      const summary = summaries.find(s => s.platform === item.platform.trim().toUpperCase());
      const available = summary ? summary.sellableCount : 0;
      return { platform: item.platform, available, inStock: available >= item.quantity };
    });
    return {
      id:          c.id,
      name:        c.name,
      price:       c.price,
      description: c.description,
      imageUrl:    c.imageUrl,
      items,
      inStock: items.every(i => i.inStock),
    };
  });

  res.json({ combos: result });
});

// POST /sell — { platform, clientPhone, orderRef? } → vende el perfil libre más próximo a vencer.
router.post("/sell", (req, res) => {
  const { platform, clientPhone, orderRef } = req.body ?? {};
  if (!platform?.trim() || !clientPhone?.trim()) {
    res.status(400).json({ message: "Faltan platform o clientPhone." });
    return;
  }

  const sold = sellProfile(platform, clientPhone, typeof orderRef === "string" ? orderRef : "");
  if (!sold) {
    res.status(409).json({ success: false, message: "Sin stock disponible en esa plataforma." });
    return;
  }

  res.status(201).json({
    success: true,
    account: {
      profileId:   sold.profileId,
      platform:    sold.platform,
      email:       sold.email,
      password:    sold.password,
      profileName: sold.profileName,
      expiresAt:   sold.expiresAt,
    },
  });
});

// GET /profile/:id — reconsulta un perfil ya vendido (para reenviar credenciales
// si algo falló entre la venta y que el cliente las recibiera por WhatsApp).
router.get("/profile/:id", (req, res) => {
  const profile = getProfileById(Number(req.params.id));
  if (!profile) { res.status(404).json({ message: "Perfil no encontrado." }); return; }

  const account = getAccountById(profile.accountId);
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }

  res.json({
    profileId:   profile.id,
    platform:    account.platform,
    email:       account.email,
    password:    account.password,
    profileName: profile.profileName,
    clientPhone: profile.clientPhone,
    expiresAt:   account.expiresAt,
  });
});

// POST /release — { platform, clientPhone } → libera perfil(es) (orden cancelada).
router.post("/release", (req, res) => {
  const { platform, clientPhone } = req.body ?? {};
  if (!platform?.trim() || !clientPhone?.trim()) {
    res.status(400).json({ message: "Faltan platform o clientPhone." });
    return;
  }
  const released = releaseProfilesByPhone(platform, clientPhone);
  res.json({ released });
});

// POST /release-by-order-ref — { orderRef } → libera solo los perfiles de
// esa orden exacta (usado por combos para revertir una venta parcial sin
// tocar otras cuentas del mismo cliente).
router.post("/release-by-order-ref", (req, res) => {
  const { orderRef } = req.body ?? {};
  if (!orderRef?.trim()) {
    res.status(400).json({ message: "Falta orderRef." });
    return;
  }
  const released = releaseProfilesByOrderRef(orderRef);
  res.json({ released });
});

// POST /renew — { platform, clientPhone } → renueva +30 días la cuenta completa del cliente.
router.post("/renew", (req, res) => {
  const { platform, clientPhone } = req.body ?? {};
  if (!platform?.trim() || !clientPhone?.trim()) {
    res.status(400).json({ message: "Faltan platform o clientPhone." });
    return;
  }

  const account = findAccountByClientPhone(platform, clientPhone);
  if (!account) {
    res.status(404).json({ success: false, message: "No se encontró cuenta de ese cliente en esa plataforma." });
    return;
  }

  const renewed = renewAccount(account.id);
  res.json({ success: true, expiresAt: renewed?.expiresAt ?? null });
});

// GET /expiring?days=3 — clientes cuya cuenta vence en los próximos N días.
router.get("/expiring", (req, res) => {
  const days = Number(req.query.days ?? 3);
  const clients = listExpiringClients(Number.isFinite(days) ? days : 3).map(c => ({
    ...c,
    status:   accountStatus(c.expiresAt),
    daysLeft: daysLeft(c.expiresAt),
  }));
  res.json({ clients });
});

// ── BITÁCORA DE PEDIDOS (reemplaza PEDIDOS_PENDIENTES de Sheets) ──

const VALID_ORDER_TYPES: OrderType[] = ["Compra", "Renovación", "Compra sin stock"];

router.post("/pending-orders", (req, res) => {
  const { orderName, phone, platform, orderType } = req.body ?? {};
  if (!orderName?.trim() || !phone?.trim() || !platform?.trim() || !VALID_ORDER_TYPES.includes(orderType)) {
    res.status(400).json({ message: "Faltan orderName, phone, platform, u orderType inválido." });
    return;
  }
  createPendingOrder({ orderName, phone, platform, orderType });
  res.status(201).json({ success: true });
});

router.post("/pending-orders/:orderName/confirm-payment", (req, res) => {
  const { found } = confirmPendingOrderPayment(req.params.orderName);
  res.json({ success: true, found });
});

router.post("/pending-orders/:orderName/mark-assigned", (req, res) => {
  markPendingOrderAssigned(req.params.orderName);
  res.json({ success: true });
});

// ── BITÁCORA DE RENOVACIONES (reemplaza RENOVACIONES_CLIENTES de Sheets) ──

router.post("/renewals", (req, res) => {
  const { orderName, phone, platform } = req.body ?? {};
  if (!orderName?.trim() || !phone?.trim() || !platform?.trim()) {
    res.status(400).json({ message: "Faltan orderName, phone o platform." });
    return;
  }
  createRenewalLog({ orderName, phone, platform });
  res.status(201).json({ success: true });
});

router.post("/renewals/:orderName/confirm", (req, res) => {
  const { found } = confirmRenewalLog(req.params.orderName);
  res.json({ success: true, found });
});

// ── CANVA — registro de la aprobación + alta en Accesos con vencimiento
// a 365 días, para tener control total de las cuentas anuales (antes solo
// quedaba en una bitácora aparte que no se veía en Accesos). ──

const CANVA_PLAN_DAYS = 365;

router.post("/canva-orders", (req, res) => {
  const { orderName, phone, clientEmail, platform } = req.body ?? {};
  if (!orderName?.trim() || !phone?.trim()) {
    res.status(400).json({ message: "Faltan orderName o phone." });
    return;
  }
  const email = typeof clientEmail === "string" ? clientEmail : "";
  logCanvaOrder({ orderName, phone, clientEmail: email });

  if (email) {
    createAccountsBulk({
      platform:    typeof platform === "string" && platform.trim() ? platform : "CANVA ANUAL",
      provider:    "",
      hasProfiles: false,
      expiresAt:   addDaysISO(limaTodayISO(), CANVA_PLAN_DAYS),
      pairs:       [{ email, password: "" }],
    });
  }

  res.status(201).json({ success: true });
});

// ── MÉTODOS DE PAGO (para el flujo de checkout del bot) ──

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

router.get("/payment-methods", (_req, res) => {
  const methods = listPaymentMethods()
    .filter(m => m.active)
    .map(m => ({
      id:          slugify(m.name),
      buttonLabel: m.name,
      title:       m.name,
      description: m.description,
      imageUrl:    m.imageUrl,
    }));
  res.json({ methods });
});

// GET /flow-config — textos/títulos editables del flujo de WhatsApp
// (Configuración > Flujo). El bot lo refresca cada pocos minutos.
router.get("/flow-config", (_req, res) => {
  res.json({ config: getBotFlowConfig() });
});

export default router;
