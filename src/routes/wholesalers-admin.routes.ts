import { Router } from "express";
import {
  createWholesaler,
  findWholesalerById,
  listAllWholesalers,
  setWholesalerStatus,
  setWholesalerPassword,
} from "../db/wholesaler.repository";
import { applyWholesalerCreditChange, listLedgerForWholesaler } from "../db/wholesaler-credit.repository";
import {
  assignProfilesToWholesaler,
  sellProfileForWholesaler,
  createManualActivationForWholesaler,
  listWholesalerClients,
  getProfileById,
  getAccountById,
} from "../db/access.repository";
import {
  listPendingFullAccountQueue,
  markFullAccountPrepared,
  markFullAccountDelivered,
} from "../db/wholesale-full-account.repository";
import { generatePassword, hashPassword } from "../services/customer-auth.service";
import { touchWholesalerActivity } from "../db/wholesaler.repository";
import { renewAccount } from "../services/access.service";
import type { Wholesaler } from "../db/wholesaler.repository";

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

/** Resetea la contraseña (olvidada, o revocar acceso de inmediato) — devuelve la nueva en texto plano para reenviar. */
router.post("/:id/reset-password", async (req, res) => {
  const password     = generatePassword();
  const passwordHash = await hashPassword(password);
  const wholesaler    = setWholesalerPassword(Number(req.params.id), passwordHash, password);
  if (!wholesaler) return res.status(404).json({ message: "Mayorista no encontrado." });
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

  const orderRef = "admin-assign:" + wholesalerId + ":" + Date.now();

  if (mode === "manual") {
    const email      = String(req.body?.email ?? "").trim();
    const password   = String(req.body?.password ?? "").trim();
    const expiresAt  = String(req.body?.expiresAt ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Falta un correo válido." });
    }
    if (!password) return res.status(400).json({ message: "Falta la contraseña." });
    if (!DATE_RE.test(expiresAt)) return res.status(400).json({ message: "Falta la fecha de vencimiento." });

    const created = createManualActivationForWholesaler({
      platform, email, password, expiresAt, wholesalerId, clientPhone, orderRef,
    });
    touchWholesalerActivity(wholesalerId);
    return res.status(201).json({ ok: true, account: { platform, email: created.email } });
  }

  // mode === "stock"
  if (isManualActivationPlatform(platform)) {
    const email     = String(req.body?.email ?? "").trim();
    const expiresAt = String(req.body?.expiresAt ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Falta un correo válido para activar esta plataforma." });
    }
    const password = requiresPasswordPlatform(platform) ? String(req.body?.password ?? "").trim() : "";
    if (requiresPasswordPlatform(platform) && !password) {
      return res.status(400).json({ message: "Falta la contraseña." });
    }
    if (!DATE_RE.test(expiresAt)) return res.status(400).json({ message: "Falta la fecha de vencimiento." });

    const created = createManualActivationForWholesaler({
      platform, email, password, expiresAt, wholesalerId, clientPhone, orderRef,
    });
    touchWholesalerActivity(wholesalerId);
    return res.status(201).json({ ok: true, account: { platform, email: created.email } });
  }

  const result = sellProfileForWholesaler(platform, wholesalerId, clientPhone, orderRef);
  if (!result) return res.status(409).json({ message: `Sin stock disponible para "${platform}".` });
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

  renewAccount(account.id);
  res.json({ ok: true, account: getAccountById(account.id) });
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
