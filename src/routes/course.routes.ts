import { Router, type Request, type Response, type NextFunction } from "express";
import axios from "axios";
import fs from "fs";
import { env } from "../config/env";
import {
  CUSTOMER_SESSION_COOKIE, verifyCustomerSessionToken, generatePassword, hashPassword,
  type RequestWithCustomer,
} from "../services/customer-auth.service";
import { findCustomerById } from "../db/customer.repository";
import { normalizePeruPhone } from "../utils/phone.util";
import { createWholesaler, findWholesalerByPhone, touchWholesalerActivity } from "../db/wholesaler.repository";
import { applyWholesalerCreditChange } from "../db/wholesaler-credit.repository";
import { db } from "../db/db";
import { emitDashboardEvent } from "../utils/live-events.util";
import {
  COURSE_ID, COURSE_TITLE, COURSE_GIFT_CENTS, EPISODES, STEPS,
  getCoursePrice, getCues, findPaidPurchase, hasCourseAccess, createPendingPurchase, findPurchaseByOrder,
  getProgress, saveProgress, getUnlocks, unlockCue, hasUnlockedType, recordDownload, downloadCount,
  getCoupon, getOrCreateCoupon, findClaimForPurchase, insertClaim, maskPhone,
  streamUrl, verifyStream, mediaPath, mediaStatus, isCoursePublished, isPreviewPhone,
} from "../services/course.service";

// ─────────────────────────────────────────────────────────────
// CURSO — API del alumno (liordark.com/curso y /curso/aprender).
// Misma sesión de cliente que la tienda (celular + PIN).
// ─────────────────────────────────────────────────────────────

const router = Router();
const SUPPORT_PHONE = "963 081 436";

function sessionCustomerId(req: Request): number | null {
  return verifyCustomerSessionToken(req.cookies?.[CUSTOMER_SESSION_COOKIE]);
}

/** Borrador: solo el celular de prueba y quien ya tenga acceso. */
function canSeeCourse(customerId: number | null): boolean {
  if (isCoursePublished()) return true;
  if (!customerId) return false;
  const customer = findCustomerById(customerId);
  return !!customer && (isPreviewPhone(customer.phone) || hasCourseAccess(customer.id));
}

const NOT_AVAILABLE = { message: "El curso todavía no está disponible.", unavailable: true };

function requireStudent(req: Request, res: Response, next: NextFunction): void {
  const customerId = sessionCustomerId(req);
  const customer = customerId ? findCustomerById(customerId) : null;
  if (!customer) { res.status(401).json({ message: "Inicia sesión para continuar." }); return; }
  if (!canSeeCourse(customer.id)) { res.status(404).json(NOT_AVAILABLE); return; }
  (req as RequestWithCustomer).customerId = customer.id;
  next();
}

function requireOwner(req: Request, res: Response, next: NextFunction): void {
  requireStudent(req, res, () => {
    if (!hasCourseAccess((req as RequestWithCustomer).customerId)) {
      res.status(403).json({ message: "Todavía no tienes este curso." });
      return;
    }
    next();
  });
}

function episodesPublic() {
  const media = mediaStatus();
  const cues = getCues();
  return EPISODES.map(e => ({
    ...e,
    available: media[("ep" + e.n) as "ep1"].exists,
    cues: cues[e.n] ?? [],
  }));
}

// GET /api/course/info — PÚBLICO (página de venta).
router.get("/info", (req, res) => {
  const customerId = sessionCustomerId(req);
  if (!canSeeCourse(customerId)) {
    return res.json({ visible: false, loggedIn: !!customerId });
  }
  const media = mediaStatus();
  res.json({
    courseId: COURSE_ID,
    title: COURSE_TITLE,
    price: getCoursePrice(),
    steps: STEPS,
    episodes: EPISODES.map(e => ({ n: e.n, step: e.step, title: e.title, summary: e.summary })),
    previewAvailable: media.ep1.exists,
    visible: true,
    published: isCoursePublished(),
    loggedIn: !!customerId,
    owned: customerId ? hasCourseAccess(customerId) : false,
  });
});

// GET /api/course/preview — Episodio 1 gratis (página de venta).
router.get("/preview", (req, res) => {
  if (!canSeeCourse(sessionCustomerId(req))) { res.status(404).json(NOT_AVAILABLE); return; }
  sendVideo(res, mediaPath("ep1"));
});

function sendVideo(res: Response, file: string): void {
  if (!fs.existsSync(file)) { res.status(404).json({ message: "Video todavía no disponible." }); return; }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.type("video/mp4");
  // sendFile maneja Range (el reproductor pide el video por partes).
  res.sendFile(file, { acceptRanges: true, cacheControl: false, lastModified: false }, (err: any) => {
    if (err && !res.headersSent) res.status(500).end();
  });
}

// ─── Compra ──────────────────────────────────────────────────

router.post("/checkout", requireStudent, async (req, res) => {
  const customer = findCustomerById((req as RequestWithCustomer).customerId);
  if (!customer) return res.status(401).json({ message: "Sesión inválida." });
  if (hasCourseAccess(customer.id)) {
    return res.status(409).json({ message: "Ya tienes este curso.", owned: true });
  }
  const price = getCoursePrice();
  try {
    const response = await axios.post(
      env.BOT_BASE_URL + "/api/web-orders",
      { phone: normalizePeruPhone(customer.phone), course: { courseId: COURSE_ID, price, label: COURSE_TITLE } },
      { headers: { "x-dashboard-key": env.DASHBOARD_API_KEY }, timeout: 15_000 }
    );
    const { orderName, amount } = response.data as { orderName: string; amount: string };
    createPendingPurchase(customer.id, customer.phone, orderName, amount);
    res.json({ orderName, amount });
  } catch (err: any) {
    const message = err?.response?.data?.message || "No se pudo crear el pedido. Intenta de nuevo.";
    res.status(err?.response?.status || 502).json({ message });
  }
});

router.get("/checkout/:orderName", requireStudent, (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const p = findPurchaseByOrder(String(req.params.orderName));
  if (!p || p.customerId !== customerId) return res.status(404).json({ message: "Pedido no encontrado." });
  res.json({ paid: p.status === "paid" || hasCourseAccess(customerId) });
});

// ─── Aula ────────────────────────────────────────────────────

router.get("/me", requireStudent, (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const customer = findCustomerById(customerId);
  const purchase = findPaidPurchase(customerId);
  if (!customer || !purchase) return res.json({ owned: false });

  const claim = findClaimForPurchase(purchase.id);
  const progress = getProgress(customerId);
  res.json({
    owned: true,
    title: COURSE_TITLE,
    steps: STEPS,
    phone: customer.phone,
    episodes: episodesPublic(),
    progress,
    unlocks: getUnlocks(customerId),
    coupon: getCoupon(customerId),
    gestorDownloaded: downloadCount(customerId, "gestor") > 0,
    gestorAvailable: mediaStatus().gestor.exists,
    claim: claim ? { maskedPhone: maskPhone(claim.phone), createdNew: claim.createdNew } : null,
    completedAll: EPISODES.every(e => progress.some(p => p.episode === e.n && p.completed)),
  });
});

router.post("/video/:ep", requireOwner, (req, res) => {
  const ep = Number(req.params.ep);
  if (!EPISODES.some(e => e.n === ep)) return res.status(404).json({ message: "Episodio no encontrado." });
  if (!fs.existsSync(mediaPath(("ep" + ep) as "ep1"))) {
    return res.status(404).json({ message: "Este episodio se está subiendo. Vuelve en un rato 🙌" });
  }
  res.json({ url: streamUrl((req as RequestWithCustomer).customerId, ep) });
});

// Link firmado (vence en 4 h) + la sesión del alumno — los dos tienen que calzar.
router.get("/stream/:ep", requireOwner, (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const ep = Number(req.params.ep);
  if (!EPISODES.some(e => e.n === ep)) return res.status(404).end();
  if (!verifyStream(customerId, ep, Number(req.query.exp), String(req.query.sig ?? ""))) {
    return res.status(403).json({ message: "El link del video venció. Recarga la página." });
  }
  sendVideo(res, mediaPath(("ep" + ep) as "ep1"));
});

router.post("/progress", requireOwner, (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const ep = Number(req.body?.episode);
  const second = Number(req.body?.second);
  const duration = Number(req.body?.duration);
  if (!EPISODES.some(e => e.n === ep) || !Number.isFinite(second) || !Number.isFinite(duration)) {
    return res.status(400).json({ message: "Datos inválidos." });
  }
  const progress = saveProgress(customerId, ep, second, duration);
  const all = getProgress(customerId);
  res.json({
    progress,
    unlocks: getUnlocks(customerId),
    completedAll: EPISODES.every(e => all.some(p => p.episode === e.n && p.completed)),
  });
});

router.post("/unlock", requireOwner, (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  if (!unlockCue(customerId, String(req.body?.cueId ?? ""))) {
    return res.status(400).json({ message: "Recurso no encontrado." });
  }
  res.json({ unlocks: getUnlocks(customerId) });
});

// ─── Recursos ────────────────────────────────────────────────

router.get("/resource/gestor", requireOwner, (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const file = mediaPath("gestor");
  if (!fs.existsSync(file)) return res.status(404).json({ message: "La plantilla se está subiendo. Vuelve en un rato 🙌" });
  recordDownload(customerId, "gestor");
  res.setHeader("Cache-Control", "private, no-store");
  res.download(file, "Gestor-de-cuentas-Manguitope.xlsx");
});

router.post("/coupon", requireOwner, (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  if (!hasUnlockedType(customerId, "cupon")) {
    return res.status(403).json({ message: "Tu cupón se desbloquea en el episodio 5." });
  }
  res.json({ code: getOrCreateCoupon(customerId) });
});

// POST /api/course/wholesale — { phone, panelName } — 1 vez por compra.
router.post("/wholesale", requireOwner, async (req, res) => {
  const customerId = (req as RequestWithCustomer).customerId;
  const purchase = findPaidPurchase(customerId);
  if (!purchase) return res.status(403).json({ message: "Todavía no tienes este curso." });

  const existingClaim = findClaimForPurchase(purchase.id);
  if (existingClaim) {
    return res.status(409).json({
      message: "Ya creaste tu acceso mayorista con el celular " + maskPhone(existingClaim.phone) + ".",
      maskedPhone: maskPhone(existingClaim.phone),
    });
  }
  if (!hasUnlockedType(customerId, "mayorista")) {
    return res.status(403).json({ message: "Este acceso se desbloquea en el episodio 3." });
  }

  let digits = String(req.body?.phone ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("51")) digits = digits.slice(2);
  if (!/^9\d{8}$/.test(digits)) {
    return res.status(400).json({ message: "El celular debe tener 9 dígitos y empezar con 9." });
  }
  const panelName = String(req.body?.panelName ?? "").trim().replace(/\s+/g, " ");
  if (panelName.length < 3 || panelName.length > 30) {
    return res.status(400).json({ message: "El nombre de tu panel debe tener entre 3 y 30 caracteres." });
  }
  const phone = "51" + digits;

  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  type ClaimResult = { createdNew: boolean; disabled: boolean; wholesalerId: number; balanceCents: number };
  const run = db.transaction((): ClaimResult => {
    // Re-chequeo dentro de la transacción (doble clic / dos pestañas).
    if (findClaimForPurchase(purchase.id)) throw Object.assign(new Error("claimed"), { code: "CLAIMED" });

    const existing = findWholesalerByPhone(phone);
    let wholesalerId: number;
    let createdNew: boolean;
    let disabled = false;
    if (existing) {
      // Ya era mayorista → NUNCA se crea otro panel: solo se le suman los
      // S/ 10 a su saldo. Si está deshabilitado (1 mes sin actividad) no se
      // reactiva acá: el saldo queda guardado y lo reactiva soporte.
      wholesalerId = existing.id;
      createdNew = false;
      disabled = existing.status !== "active";
    } else {
      wholesalerId = createWholesaler(phone, passwordHash, password, panelName).id;
      createdNew = true;
    }
    const credit = applyWholesalerCreditChange(
      wholesalerId, COURSE_GIFT_CENTS, "gift_course", "curso:" + purchase.id, "system"
    );
    if (!credit.ok) throw new Error(credit.error);
    if (!disabled) touchWholesalerActivity(wholesalerId);
    insertClaim({
      purchaseId: purchase.id, customerId, phone, panelName, wholesalerId, createdNew, giftCents: COURSE_GIFT_CENTS,
    });
    return { createdNew, disabled, wholesalerId, balanceCents: credit.newBalanceCents };
  });

  let result: ClaimResult;
  try {
    result = run();
  } catch (err: any) {
    if (err?.code === "CLAIMED") {
      const c = findClaimForPurchase(purchase.id);
      return res.status(409).json({
        message: "Ya creaste tu acceso mayorista con el celular " + maskPhone(c?.phone ?? phone) + ".",
        maskedPhone: maskPhone(c?.phone ?? phone),
      });
    }
    console.error("❌ curso → acceso mayorista:", err?.message);
    return res.status(500).json({
      message: "No pudimos crear tu acceso. Escríbenos al WhatsApp " + SUPPORT_PHONE + " y lo resolvemos al toque.",
    });
  }

  try {
    emitDashboardEvent({
      type: "order_approved",
      message: "Curso → acceso mayorista " + (result.createdNew ? "creado" : result.disabled ? "(ya existía, deshabilitado, +S/10 guardados)" : "(ya existía, +S/10)") + " · " + panelName + " · " + digits,
      createdAt: new Date().toISOString(),
    });
  } catch { /* no crítico */ }

  res.json({
    ok: true,
    createdNew: result.createdNew,
    disabled: result.disabled,
    user: digits,
    password: result.createdNew ? password : null,
    giftCents: COURSE_GIFT_CENTS,
    balanceCents: result.balanceCents,
    panelUrl: "https://mayorista.liordark.com",
  });
});

export default router;
