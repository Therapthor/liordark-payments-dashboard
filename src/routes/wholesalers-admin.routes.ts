import { Router } from "express";
import {
  createWholesaler,
  findWholesalerById,
  listAllWholesalers,
  setWholesalerStatus,
  setWholesalerPassword,
} from "../db/wholesaler.repository";
import { applyWholesalerCreditChange, creditWasAlreadyApplied, listLedgerForWholesaler } from "../db/wholesaler-credit.repository";
import { db } from "../db/db";
import { getCatalogProductByPlatform } from "../db/catalog.repository";
import { wholesalePlansFor } from "../services/plans.service";
import {
  assignProfilesToWholesaler,
  sellProfileForWholesaler,
  createManualActivationForWholesaler,
  listWholesalerClients,
  getProfileById,
  getAccountById,
  setAccountExpiry,
  setClientDate,
  releaseProfile,
  deleteAccount,
} from "../db/access.repository";
import {
  listPendingFullAccountQueue,
  markFullAccountPrepared,
  markFullAccountDelivered,
} from "../db/wholesale-full-account.repository";
import { generatePassword, hashPassword } from "../services/customer-auth.service";
import { touchWholesalerActivity } from "../db/wholesaler.repository";
import { grantMembership, membershipDateLabel } from "../db/wholesaler-membership.repository";
import { createWholesalerNotification } from "../db/wholesaler-notifications.repository";
import { unlockWholesalerLogin } from "../services/login-unlock.service";
import { renewAccount } from "../services/access.service";
import type { Wholesaler } from "../db/wholesaler.repository";
import { plansFor, planFor, planExpiresAt } from "../services/plans.service";
import { isBrainPlatform, extendClientDate } from "../db/brain-platforms";

// CANVA, GEMINI AI PRO y YOUTUBE PREMIUM no tienen stock de perfiles — se
// activan a mano (mismo criterio que wholesaler.routes.ts, duplicado acá
// por ser un router aparte). CANVA se vende anual, el resto mensual.
function isManualActivationPlatform(platform: string): boolean {
  return /canva|gemini|youtube/i.test(platform);
}
function requiresPasswordPlatform(platform: string): boolean {
  return /youtube/i.test(platform);
}
// YOUTUBE PREMIUM no es renovable — cada ciclo es una compra nueva (mismo
// criterio que wholesaler.routes.ts).
function isNonRenewablePlatform(platform: string): boolean {
  return /youtube/i.test(platform);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─────────────────────────────────────────────────────────────
// GESTIÓN DE MAYORISTAS — desde panel.liordark.com (admin). Crear/editar
// cuentas, ajustar saldo a mano, asignar stock ya existente, y la cola de
// cuentas completas a pedido. El envío del WhatsApp de bienvenida se hace
// del lado del navegador (igual que "Enviar cuenta" en Accesos: se abre
// un wa.me con el texto ya armado y lo manda el admin) — esta ruta solo
// devuelve la contraseña generada para que el frontend arme ese link.
// ─────────────────────────────────────────────────────────────

const router = Router();

// El admin puede ver/resetear la contraseña por sus propios endpoints
// dedicados (reset-password, y el "password" que devuelve el alta) —
// las respuestas con el resto de datos del mayorista nunca necesitan
// cargar password_hash NI password_plain.
function toPublic(w: Wholesaler) {
  const { passwordHash, passwordPlain, ...rest } = w;
  return rest;
}

router.get("/", (_req, res) => {
  res.json({ wholesalers: listAllWholesalers().map(toPublic) });
});

router.post("/", async (req, res) => {
  const phone       = String(req.body?.phone ?? "").replace(/\D/g, "");
  const displayName = String(req.body?.displayName ?? "").trim();
  if (phone.length < 9) return res.status(400).json({ message: "Celular inválido." });

  const password     = generatePassword();
  const passwordHash = await hashPassword(password);
  const wholesaler    = createWholesaler(phone, passwordHash, password, displayName);

  res.status(201).json({ wholesaler: toPublic(wholesaler), password });
});

router.patch("/:id/status", (req, res) => {
  const status = req.body?.status === "disabled" ? "disabled" : "active";
  setWholesalerStatus(Number(req.params.id), status);
  const wholesaler = findWholesalerById(Number(req.params.id));
  if (!wholesaler) return res.status(404).json({ message: "Mayorista no encontrado." });
  res.json({ wholesaler: toPublic(wholesaler) });
});

// Membresía a mano (pago en efectivo, regalo…): suma 1, 3 o 12 meses.
router.post("/:id/membership", (req, res) => {
  const id = Number(req.params.id);
  const months = Number(req.body?.months);
  if (![1, 3, 12].includes(months)) return res.status(400).json({ message: "Elige 1, 3 o 12 meses." });
  if (!findWholesalerById(id)) return res.status(404).json({ message: "Mayorista no encontrado." });
  const status = grantMembership(id, months, "admin");
  const w = findWholesalerById(id)!;
  createWholesalerNotification(id, "membership", "", "", `✅ Tu membresía mayorista está activa. Vence el ${membershipDateLabel(w.membershipUntil)}.`);
  res.json({ wholesaler: toPublic(w), membership: status });
});

/** Resetea la contraseña (olvidada, o revocar acceso de inmediato) — devuelve la nueva en texto plano para reenviar. */
router.post("/:id/reset-password", async (req, res) => {
  const password     = generatePassword();
  const passwordHash = await hashPassword(password);
  const wholesaler    = setWholesalerPassword(Number(req.params.id), passwordHash, password);
  if (!wholesaler) return res.status(404).json({ message: "Mayorista no encontrado." });
  unlockWholesalerLogin(wholesaler); // con la contraseña nueva entra sin esperar
  res.json({ password });
});

// Ajuste manual de saldo (+/-) — queda en el ledger con created_by del admin.
router.post("/:id/adjust-balance", (req, res) => {
  const id = Number(req.params.id);
  const amountCents = Math.round(Number(req.body?.amountCents));
  const note = String(req.body?.note ?? "").trim();
  if (!Number.isFinite(amountCents) || amountCents === 0) {
    return res.status(400).json({ message: "Monto inválido." });
  }

  const result = applyWholesalerCreditChange(
    id, amountCents, amountCents > 0 ? "topup_manual_admin" : "debit_manual_admin", note, "admin"
  );
  if (!result.ok) return res.status(402).json({ message: result.error });
  res.json({ ok: true, newBalanceCents: result.newBalanceCents });
});

router.get("/:id/ledger", (req, res) => {
  res.json({ entries: listLedgerForWholesaler(Number(req.params.id)) });
});

// Asignar perfiles YA EXISTENTES (libres, sin dueño) a este mayorista —
// bulk, por ids. Nunca crea stock nuevo, solo reasigna lo que ya está en
// Accesos (fuera de alcance por ahora cambiar cómo se da de alta stock).
router.post("/:id/assign-profiles", (req, res) => {
  const wholesalerId = Number(req.params.id);
  const profileIds: number[] = Array.isArray(req.body?.profileIds)
    ? req.body.profileIds.map((n: unknown) => Number(n)).filter(Number.isFinite)
    : [];
  if (profileIds.length === 0) return res.status(400).json({ message: "Faltan profileIds." });

  const assigned = assignProfilesToWholesaler(profileIds, wholesalerId);
  res.json({ assigned });
});

// Asigna una cuenta a un cliente de este mayorista SIN tocar su saldo —
// para ventas ya cobradas aparte (ej. por WhatsApp, antes de tener panel).
// "stock" saca del pool normal (o activa a mano si la plataforma no tiene
// stock, igual que la compra real desde el panel mayorista); "manual" es
// una cuenta completa que el admin escribe a mano (cualquier plataforma).
router.post("/:id/assign-account", (req, res) => {
  const wholesalerId = Number(req.params.id);
  const wholesaler = findWholesalerById(wholesalerId);
  if (!wholesaler) {
    return res.status(404).json({ message: "Mayorista no encontrado." });
  }

  const mode    = req.body?.mode === "manual" ? "manual" : "stock";
  const platform = String(req.body?.platform ?? "").trim().toUpperCase();
  if (!platform) return res.status(400).json({ message: "Falta la plataforma." });

  // "Para el propio mayorista" — usa su mismo celular como clientPhone,
  // así queda igual de rastreable que una cuenta de cliente (aparece en
  // "Mis cuentas"/"Ver cuentas" con su número) pero no es un sub-cliente real.
  const forSelf = !!req.body?.forSelf;
  const clientPhone = forSelf
    ? wholesaler.phone.replace(/\D/g, "")
    : String(req.body?.clientPhone ?? "").replace(/\D/g, "");
  if (!forSelf && clientPhone.length < 9) {
    return res.status(400).json({ message: "Celular del cliente inválido." });
  }

  // «Cuenta completa (a mano)» se marca como tal; desde stock es una venta
  // normal (perfil, o la cuenta de una plataforma sin perfiles): con el mismo
  // prefijo que una compra del panel mayorista para que no figure como
  // «Cuenta completa» ni se cobre su precio al renovar.
  const orderRef = (mode === "manual" ? "admin-assign:" : "wholesale:admin-assign:") + wholesalerId + ":" + Date.now();

  // Planes por meses (CANVA, GEMINI): el admin elige 1, 3, 6 o 12 meses —
  // queda guardado en la cuenta (sale en «Pendientes» como «Plan 3 meses»)
  // y, si no mandó fecha, el vencimiento sale del plan.
  let plan: ReturnType<typeof planFor> = null;
  const rawMonths = req.body?.months;
  if (plansFor(platform) && rawMonths !== undefined && rawMonths !== null && rawMonths !== "") {
    plan = planFor(platform, rawMonths);
    if (!plan) return res.status(400).json({ message: `Elige un plan válido para "${platform}" (1, 3, 6 o 12 meses).` });
  }
  const planMonths = plan?.months;
  const bodyExpiresAt = () => String(req.body?.expiresAt ?? "").trim() || (plan ? planExpiresAt(plan) : "");

  if (mode === "manual") {
    const email      = String(req.body?.email ?? "").trim();
    const password   = String(req.body?.password ?? "").trim();
    const expiresAt  = bodyExpiresAt();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Falta un correo válido." });
    }
    if (!password) return res.status(400).json({ message: "Falta la contraseña." });
    if (!DATE_RE.test(expiresAt)) return res.status(400).json({ message: "Falta la fecha de vencimiento." });

    const created = createManualActivationForWholesaler({
      platform, email, password, expiresAt, wholesalerId, clientPhone, orderRef, planMonths,
      // Una cuenta completa ya lista (Netflix, Disney…) no tiene nada que
      // activar: antes caía igual en "Activación pendiente".
      activationPending: isManualActivationPlatform(platform),
    });
    touchWholesalerActivity(wholesalerId);
    return res.status(201).json({ ok: true, account: { platform, email: created.email } });
  }

  // mode === "stock"
  if (isManualActivationPlatform(platform)) {
    const email     = String(req.body?.email ?? "").trim();
    const expiresAt = bodyExpiresAt();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Falta un correo válido para activar esta plataforma." });
    }
    const password = requiresPasswordPlatform(platform) ? String(req.body?.password ?? "").trim() : "";
    if (requiresPasswordPlatform(platform) && !password) {
      return res.status(400).json({ message: "Falta la contraseña." });
    }
    if (!DATE_RE.test(expiresAt)) return res.status(400).json({ message: "Falta la fecha de vencimiento." });

    const created = createManualActivationForWholesaler({
      platform, email, password, expiresAt, wholesalerId, clientPhone, orderRef, planMonths,
    });
    touchWholesalerActivity(wholesalerId);
    return res.status(201).json({ ok: true, account: { platform, email: created.email } });
  }

  const expiresAt = String(req.body?.expiresAt ?? "").trim();
  if (!DATE_RE.test(expiresAt)) return res.status(400).json({ message: "Falta la fecha de vencimiento." });

  const result = sellProfileForWholesaler(platform, wholesalerId, clientPhone, orderRef);
  if (!result) return res.status(409).json({ message: `Sin stock disponible para "${platform}".` });
  // La cuenta de stock ya trae su propio vencimiento (el de Accesos) —
  // acá se pisa con la fecha real que puso el admin (compra de hace unos
  // días), igual que en los otros 2 modos de este mismo endpoint.
  // Cerebro: esa fecha es la del CLIENTE (la cuenta guarda la del proveedor).
  if (isBrainPlatform(result.platform)) setClientDate(result.profileId, expiresAt);
  else setAccountExpiry(result.accountId, expiresAt);
  touchWholesalerActivity(wholesalerId);
  res.status(201).json({ ok: true, account: { platform: result.platform, email: result.email } });
});

// Cuentas/clientes asignados a este mayorista — para verlas y renovarlas
// desde el admin sin pasar por el panel mayorista (ni tocar su saldo).
router.get("/:id/clients", (req, res) => {
  res.json({ clients: listWholesalerClients(Number(req.params.id)) });
});

// Renueva la cuenta completa de un cliente de este mayorista — GRATIS,
// a diferencia de POST /api/wholesaler/clients/:profileId/renew (esa sí
// descuenta saldo). Pensada para cuentas asignadas a mano por WhatsApp.
router.post("/:id/clients/:profileId/renew", (req, res) => {
  const wholesalerId = Number(req.params.id);
  const profile = getProfileById(Number(req.params.profileId));
  if (!profile || profile.wholesalerId !== wholesalerId) {
    return res.status(404).json({ message: "Perfil no encontrado." });
  }

  const account = getAccountById(profile.accountId);
  if (!account) return res.status(404).json({ message: "Cuenta no encontrada." });
  if (isNonRenewablePlatform(account.platform)) {
    return res.status(400).json({ message: account.platform + " no es renovable — se asigna de nuevo." });
  }

  // Cerebro: se renueva al cliente (+30 días a su fecha); la cuenta con el
  // proveedor la pide renovar el cerebro si hace falta.
  if (isBrainPlatform(account.platform)) {
    const expiresAt = extendClientDate(profile.id, 30);
    return res.json({ ok: true, expiresAt, account: getAccountById(account.id) });
  }
  renewAccount(account.id);
  res.json({ ok: true, account: getAccountById(account.id) });
});

// ── ELIMINAR UNA CUENTA DEL MAYORISTA (con o sin reembolso) ──
// Para cambios o confusiones del mayorista. El reembolso devuelve a su saldo
// el último pago de esa cuenta: la última renovación (si renovó después de
// comprarla) o su parte de la compra. Asignada a mano por el admin = S/ 0.

type RefundQuote = { cents: number; ref: string; what: string };

/** Hora (ms) que va dentro de una referencia «tipo:mayorista:…:<ms>:…». */
function refTime(ref: string): number {
  const m = ref.match(/:(\d{13})(?::|$)/);
  return m ? Number(m[1]) : 0;
}

function refundQuoteFor(wholesalerId: number, profileId: number): RefundQuote {
  const profile = getProfileById(profileId)!;
  const account = getAccountById(profile.accountId);
  const soldAt = refTime(profile.orderRef || "");

  // Última renovación pagada de esta cuenta, posterior a la venta.
  const renewals = db.prepare(`
    SELECT amount_cents AS a, reference AS r FROM wholesaler_credit_ledger
    WHERE wholesaler_id = ? AND type = 'renewal' AND amount_cents < 0 AND reference LIKE ?
    ORDER BY id DESC
  `).all(wholesalerId, `wholesale-renew:${wholesalerId}:${profileId}:%`) as { a: number; r: string }[];
  const ren = renewals.find(x => refTime(x.r) >= soldAt);
  if (ren) {
    const ref = "refund:" + ren.r;
    return creditWasAlreadyApplied("refund_admin", ref) ? { cents: 0, ref, what: "ya reembolsada" } : { cents: -ren.a, ref, what: "la última renovación" };
  }

  const buy = profile.orderRef ? db.prepare(`
    SELECT amount_cents AS a, type FROM wholesaler_credit_ledger
    WHERE wholesaler_id = ? AND reference = ? AND type IN ('purchase_profile', 'purchase_full_account') AND amount_cents < 0
    ORDER BY id DESC LIMIT 1
  `).get(wholesalerId, profile.orderRef) as { a: number; type: string } | undefined : undefined;
  const ref = "refund:" + (profile.orderRef || "") + ":" + profileId;
  if (!buy) return { cents: 0, ref, what: "sin pago registrado" };
  if (creditWasAlreadyApplied("refund_admin", ref)) return { cents: 0, ref, what: "ya reembolsada" };

  // Una compra puede traer varias cuentas (combo): a cada una le toca su
  // precio mayorista, sin pasar de lo que falta devolver de esa compra.
  const refunded = (db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS s FROM wholesaler_credit_ledger
    WHERE wholesaler_id = ? AND type = 'refund_admin' AND reference LIKE ?
  `).get(wholesalerId, "refund:" + profile.orderRef + ":%") as { s: number }).s;
  const remaining = Math.max(0, -buy.a - refunded);
  const others = (db.prepare(`
    SELECT COUNT(*) AS n FROM access_profiles WHERE order_ref = ? AND client_phone != '' AND id != ?
  `).get(profile.orderRef, profileId) as { n: number }).n;
  if (others === 0 || !account) return { cents: remaining, ref, what: "la compra" };

  const product = getCatalogProductByPlatform(account.platform);
  let unit = Number(buy.type === "purchase_full_account" ? product?.wholesaleFullPrice : product?.wholesalePrice) || 0;
  const plan = wholesalePlansFor(account.platform, product?.wholesalePrice)?.find(p => p.months === profile.planMonths);
  if (plan && buy.type !== "purchase_full_account") unit = plan.wholesalePrice;
  return { cents: Math.min(remaining, Math.round(unit * 100)), ref, what: "su parte de la compra" };
}

function ownedClient(req: any) {
  const wholesalerId = Number(req.params.id);
  const profile = getProfileById(Number(req.params.profileId));
  if (!profile || profile.wholesalerId !== wholesalerId || !profile.clientPhone) return null;
  const account = getAccountById(profile.accountId);
  return account ? { wholesalerId, profile, account } : null;
}

router.get("/:id/clients/:profileId/refund-quote", (req, res) => {
  const found = ownedClient(req);
  if (!found) return res.status(404).json({ message: "Cuenta no encontrada." });
  const q = refundQuoteFor(found.wholesalerId, found.profile.id);
  res.json({ cents: q.cents, what: q.what });
});

const removeClient = db.transaction((wholesalerId: number, profileId: number, refund: boolean, expectedCents: number | null) => {
  const profile = getProfileById(profileId)!;
  const account = getAccountById(profile.accountId)!;
  let refundedCents = 0;
  if (refund) {
    const q = refundQuoteFor(wholesalerId, profileId);
    if (expectedCents !== null && expectedCents !== q.cents) {
      return { ok: false as const, status: 409, message: `El monto cambió: ahora es S/ ${(q.cents / 100).toFixed(2)}. Vuelve a intentarlo.` };
    }
    if (q.cents > 0) {
      const r = applyWholesalerCreditChange(wholesalerId, q.cents, "refund_admin", q.ref, "admin");
      if (!r.ok) return { ok: false as const, status: 400, message: r.error };
      refundedCents = q.cents;
    }
  }
  // Cuenta creada solo para esta venta (activación a pedido o cuenta puesta
  // a mano por el admin) y sin otros clientes: se borra de Accesos. Si es
  // un perfil del stock, se libera (igual que cuando el mayorista lo quita).
  const createdForSale = /canva|gemini|youtube/i.test(account.platform) || profile.orderRef.startsWith("admin-assign:");
  const alone = account.profiles.every(p => p.id === profile.id || !p.clientPhone);
  releaseProfile(profile.id, refund ? "admin: eliminada con reembolso" : "admin: eliminada");
  if (createdForSale && alone) deleteAccount(account.id);
  return { ok: true as const, refundedCents, platform: account.platform, email: account.email };
});

router.post("/:id/clients/:profileId/remove", (req, res) => {
  const found = ownedClient(req);
  if (!found) return res.status(404).json({ message: "Cuenta no encontrada (quizá ya se eliminó)." });
  const raw = req.body?.expectedCents;
  const expected = raw === undefined || raw === null ? null : Math.round(Number(raw));
  const out = removeClient(found.wholesalerId, found.profile.id, req.body?.refund === true, expected);
  if (!out.ok) return res.status(out.status).json({ message: out.message });
  createWholesalerNotification(found.wholesalerId, "account_removed", out.platform, out.email,
    out.refundedCents > 0 ? `Se devolvió S/ ${(out.refundedCents / 100).toFixed(2)} a tu saldo.` : "");
  res.json({ ok: true, refundedCents: out.refundedCents });
});

// ── COLA DE CUENTAS COMPLETAS A PEDIDO ──

router.get("/full-account-queue", (_req, res) => {
  res.json({ queue: listPendingFullAccountQueue() });
});

router.post("/full-account-queue/:id/prepare", (req, res) => {
  const email    = String(req.body?.email ?? "").trim();
  const password = String(req.body?.password ?? "").trim();
  if (!email || !password) return res.status(400).json({ message: "Falta email o password." });

  const order = markFullAccountPrepared(Number(req.params.id), email, password);
  if (!order) return res.status(404).json({ message: "Pedido no encontrado o ya no está en cola." });
  res.json({ order });
});

router.post("/full-account-queue/:id/deliver", (req, res) => {
  const order = markFullAccountDelivered(Number(req.params.id));
  if (!order) return res.status(404).json({ message: "Pedido no encontrado o todavía no está preparado." });
  res.json({ order });
});

export default router;
