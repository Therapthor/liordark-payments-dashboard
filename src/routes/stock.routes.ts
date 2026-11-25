import { sameSecret } from "../utils/safe-compare.util";
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
  listAllClientPhones,
  getProfileById,
  getAccountById,
  createManualActivationForClient,
  updateAccount,
  markActivationPending,
  setAccountExpiry,
  setAccountPlanMonths,
  findClientProfileForRenewal,
} from "../db/access.repository";
import { findPlanOrder, planFor, plansFor } from "../services/plans.service";
import { isBrainPlatform, extendClientDate } from "../db/brain-platforms";
import { db } from "../db/db";
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
import { findWholesalerById, touchWholesalerActivity } from "../db/wholesaler.repository";
import { applyWholesalerCreditChange, creditWasAlreadyApplied } from "../db/wholesaler-credit.repository";
import { applyMembershipPayment, isMembershipReference, membershipDateLabel } from "../db/wholesaler-membership.repository";
import { createWholesalerNotification } from "../db/wholesaler-notifications.repository";
import { markCoursePurchasePaid, createPendingPurchase } from "../services/course.service";
import { onAiPurchasePaid } from "../services/manguito.service";
import { findCustomerByPhone } from "../db/customer.repository";
import { emitDashboardEvent } from "../utils/live-events.util";
import { botImageUrl } from "../services/product-media.service";

// ─────────────────────────────────────────────────────────────
// API DE STOCK — consumida por el bot de WhatsApp, NO por el navegador.
// Autenticada con x-bot-key (llave compartida), no con la sesión de
// login del panel.
// ─────────────────────────────────────────────────────────────

const router = Router();

router.use((req, res, next) => {
  const key = req.header("x-bot-key");
  if (!sameSecret(key, env.DASHBOARD_API_KEY)) {
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
      imageUrl:    botImageUrl(p.imageUrl), // WhatsApp: JPG con dirección completa
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
      imageUrl:    botImageUrl(c.imageUrl),
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

  const ref = typeof orderRef === "string" ? orderRef : "";

  // Cerebro: una RENOVACIÓN no le vende un perfil nuevo — ya se le sumaron
  // sus días al confirmarse el pago (confirmRenewalLog); se le devuelve su
  // mismo perfil con la fecha nueva. Si ya no tenía (venció y se liberó),
  // sigue como una venta normal de 1 mes.
  if (ref && isBrainPlatform(platform) && isRenewalOrder(ref)) {
    const own = findClientProfileForRenewal(platform, clientPhone);
    if (own) {
      res.status(201).json({ success: true, renewed: true, account: {
        profileId: own.profileId, platform: own.platform, email: own.email, password: own.password,
        profileName: withPin(own.profileName, own.pin), pin: own.pin || "", expiresAt: own.clientExpiresAt,
      } });
      return;
    }
  }

  // Plan por meses elegido en la tienda (Crunchyroll, Netflix, ChatGPT, CapCut).
  const planOrder = ref ? findPlanOrder(ref) : null;
  const plan = planOrder ? planFor(platform, planOrder.months) : null;

  const sold = sellProfile(platform, clientPhone, ref, null, plan ? { days: plan.days, months: plan.months } : undefined);
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
      profileName: withPin(sold.profileName, sold.pin),
      pin:         sold.pin || "",
      expiresAt:   sold.expiresAt,
    },
  });
});

/** El bot muestra el perfil tal cual: con PIN va incluido («Perfil 2 (PIN 1234)»). */
function withPin(profileName: string, pin: string | undefined): string {
  return pin ? `${profileName || "Perfil"} (PIN ${pin})` : profileName;
}

function isRenewalOrder(orderName: string): boolean {
  return !!db.prepare(`SELECT 1 FROM renewals_log WHERE order_name = ?`).get(orderName);
}

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
    pin:         profile.pin || "",
    clientPhone: profile.clientPhone,
    expiresAt:   profile.clientExpiresAt ?? account.expiresAt,
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

  if (isBrainPlatform(platform)) {
    const own = findClientProfileForRenewal(platform, clientPhone);
    const date = own ? extendClientDate(own.profileId, 30) : null;
    res.json({ success: !!date, expiresAt: date });
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

// GET /all-client-phones — toda la base (activos + historial), sin
// repetidos. Para campañas puntuales (ej. aviso de cambio de número).
router.get("/all-client-phones", (_req, res) => {
  res.json({ phones: listAllClientPhones() });
});

// ── BITÁCORA DE PEDIDOS ──

const VALID_ORDER_TYPES: OrderType[] = ["Compra", "Renovación", "Compra sin stock", "Recarga mayorista"];

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

// ── BITÁCORA DE RENOVACIONES ──

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

// ── ACTIVACIÓN MANUAL (CANVA, GEMINI AI PRO, YOUTUBE PREMIUM, ...) —
// registro de la aprobación + alta en Accesos con el vencimiento del
// plan, para tener control total de estas cuentas (antes solo quedaba
// en una bitácora aparte que no se veía en Accesos). El endpoint sigue
// llamándose "canva-orders" por compatibilidad con el bot, pero ya es
// genérico para cualquier plataforma de activación manual. ──

// Sin plan elegido (pedido por WhatsApp o renovación al precio del
// catálogo, que es el del plan mensual): 1 mes.
function manualActivationPlanDays(platform: string): number {
  return plansFor(platform)?.[0]?.days ?? 30;
}

router.post("/canva-orders", (req, res) => {
  const { orderName, phone, clientEmail, clientPassword, platform } = req.body ?? {};
  if (!orderName?.trim() || !phone?.trim()) {
    res.status(400).json({ message: "Faltan orderName o phone." });
    return;
  }
  const email       = typeof clientEmail === "string" ? clientEmail : "";
  const password    = typeof clientPassword === "string" ? clientPassword : "";
  const platformTag = typeof platform === "string" && platform.trim() ? platform : "CANVA ANUAL";
  logCanvaOrder({ orderName, phone, clientEmail: email, platform: platformTag });

  // Plan por meses (GEMINI, CANVA): lo eligió el cliente al crear el pedido web.
  const planOrder = findPlanOrder(String(orderName));
  const plan = planOrder ? planFor(platformTag, planOrder.months) : null;
  const planDays = plan ? plan.days : manualActivationPlanDays(platformTag);

  if (email) {
    // Si el cliente ya tiene una cuenta de esta plataforma (renovación), se
    // extiende la misma en vez de crear otra — crear una cuenta nueva cada
    // vez dejaría duplicados dando vueltas en Accesos y en "Mis cuentas".
    const existing = findAccountByClientPhone(platformTag, phone);
    if (existing) {
      updateAccount(existing.id, password ? { email, password } : { email });
      const renewed = renewAccount(existing.id);
      // renewAccount suma 30 días; un plan de 3/6/12 meses suma lo que corresponde.
      if (plan && renewed?.expiresAt && plan.days !== 30) {
        setAccountExpiry(existing.id, addDaysISO(renewed.expiresAt, plan.days - 30));
      }
      if (plan) setAccountPlanMonths(existing.id, plan.months);
      markActivationPending(existing.id);
    } else {
      createManualActivationForClient({
        platform:    platformTag,
        email, password,
        expiresAt:   addDaysISO(limaTodayISO(), planDays),
        clientPhone: phone,
        orderRef:    orderName,
        planMonths:  plan?.months,
      });
    }
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
      imageUrl:    botImageUrl(m.imageUrl), // WhatsApp: JPG con dirección completa
    }));
  res.json({ methods });
});

// GET /flow-config — textos/títulos editables del flujo de WhatsApp
// (Configuración > Flujo). El bot lo refresca cada pocos minutos.
router.get("/flow-config", (_req, res) => {
  res.json({ config: getBotFlowConfig() });
});

// ── CRÉDITO MAYORISTA (recarga Yape auto-detectada) ──
//
// El bot llama acá cuando una reserva Yape de recarga mayorista hace
// match — ver handleYapeAutoMatch (payment.handler.ts) en el repo del
// bot. `reference` es el orderName de esa reserva: se chequea ANTES de
// acreditar que no exista ya un movimiento con ese mismo (type,
// reference), para que un reintento de red del bot nunca duplique el
// crédito (idempotencia).
router.post("/wholesale-credit", (req, res) => {
  const wholesalerId  = Number(req.body?.wholesalerId);
  const creditAmount  = Number(req.body?.creditAmount);
  const reference     = String(req.body?.reference ?? "");

  if (!wholesalerId || !Number.isFinite(creditAmount) || creditAmount <= 0 || !reference) {
    res.status(400).json({ message: "Faltan datos (wholesalerId, creditAmount, reference)." });
    return;
  }
  if (!findWholesalerById(wholesalerId)) {
    res.status(404).json({ message: "Mayorista no encontrado." });
    return;
  }

  // Pago de la membresía: activa (o alarga) la membresía, no suma saldo.
  if (req.body?.purpose === "membership" || isMembershipReference(reference)) {
    const paid = applyMembershipPayment(wholesalerId, reference, creditAmount);
    if (!paid.ok) {
      res.status(422).json({ message: paid.error });
      return;
    }
    if (!paid.alreadyApplied) {
      touchWholesalerActivity(wholesalerId);
      createWholesalerNotification(wholesalerId, "membership", "", "",
        `✅ ¡Tu membresía mayorista está activa! Vence el ${membershipDateLabel(paid.until)}.`);
      emitDashboardEvent({ type: "wholesaler_membership", wholesalerId });
    }
    res.json({ ok: true, membership: true, alreadyApplied: paid.alreadyApplied });
    return;
  }

  if (creditWasAlreadyApplied("topup_yape", reference)) {
    res.json({ ok: true, alreadyApplied: true });
    return;
  }

  const result = applyWholesalerCreditChange(
    wholesalerId, Math.round(creditAmount * 100), "topup_yape", reference, "system"
  );
  if (!result.ok) {
    res.status(500).json({ message: result.error });
    return;
  }
  touchWholesalerActivity(wholesalerId);
  res.json({ ok: true, newBalanceCents: result.newBalanceCents });
});

// POST /course-paid — { orderName, amount } — el bot confirmó el Yape de
// una compra del curso. Idempotente. Si la fila no existe (raro: el
// panel no llegó a guardarla), se arma desde el celular del orderName
// ("web-<celular>-…") para no dejar a un alumno que pagó sin acceso.
router.post("/course-paid", (req, res) => {
  const orderName = String(req.body?.orderName ?? "");
  const amount    = req.body?.amount !== undefined ? String(req.body.amount) : undefined;
  if (!orderName) {
    res.status(400).json({ message: "Falta orderName." });
    return;
  }

  // Manguito Pro (plan mensual o créditos) usa el mismo pedido web del bot.
  const ai = onAiPurchasePaid(orderName, amount);
  if (ai || String(req.body?.courseId ?? "").startsWith("manguito")) {
    if (!ai) { res.status(404).json({ message: "Compra de Manguito Pro no encontrada." }); return; }
    if (ai.ok && !ai.alreadyPaid) {
      try {
        emitDashboardEvent({ type: "order_approved", message: "Manguito Pro vendido (" + ai.label + ") — S/ " + (amount ?? ""), createdAt: new Date().toISOString() });
      } catch { /* no crítico */ }
    }
    res.json({ ok: ai.ok, alreadyPaid: !!ai.alreadyPaid });
    return;
  }

  let result = markCoursePurchasePaid(orderName, amount);
  if (!result.ok) {
    const phone = /^web-(\d+)-/.exec(orderName)?.[1] ?? "";
    const customer = phone ? findCustomerByPhone(phone) : null;
    if (!customer) {
      res.status(404).json({ message: "Compra del curso no encontrada." });
      return;
    }
    createPendingPurchase(customer.id, customer.phone, orderName, amount ?? "0");
    result = markCoursePurchasePaid(orderName, amount);
  }

  if (!result.alreadyPaid) {
    try {
      emitDashboardEvent({ type: "order_approved", message: "Curso vendido — S/ " + (amount ?? ""), createdAt: new Date().toISOString() });
    } catch { /* no crítico */ }
  }
  res.json({ ok: true, alreadyPaid: !!result.alreadyPaid });
});

export default router;
