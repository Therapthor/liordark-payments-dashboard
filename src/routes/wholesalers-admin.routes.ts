import { Router } from "express";
import {
  createWholesaler,
  findWholesalerById,
  listAllWholesalers,
  setWholesalerStatus,
  setWholesalerPassword,
} from "../db/wholesaler.repository";
import { applyWholesalerCreditChange, listLedgerForWholesaler } from "../db/wholesaler-credit.repository";
import { assignProfilesToWholesaler } from "../db/access.repository";
import {
  listPendingFullAccountQueue,
  markFullAccountPrepared,
  markFullAccountDelivered,
} from "../db/wholesale-full-account.repository";
import { generatePassword, hashPassword } from "../services/customer-auth.service";

// ─────────────────────────────────────────────────────────────
// GESTIÓN DE MAYORISTAS — desde panel.liordark.com (admin). Crear/editar
// cuentas, ajustar saldo a mano, asignar stock ya existente, y la cola de
// cuentas completas a pedido. El envío del WhatsApp de bienvenida se hace
// del lado del navegador (igual que "Enviar cuenta" en Accesos: se abre
// un wa.me con el texto ya armado y lo manda el admin) — esta ruta solo
// devuelve la contraseña generada para que el frontend arme ese link.
// ─────────────────────────────────────────────────────────────

const router = Router();

router.get("/", (_req, res) => {
  res.json({ wholesalers: listAllWholesalers().map(w => ({ ...w, passwordHash: undefined })) });
});

router.post("/", async (req, res) => {
  const phone       = String(req.body?.phone ?? "").replace(/\D/g, "");
  const displayName = String(req.body?.displayName ?? "").trim();
  if (phone.length < 9) return res.status(400).json({ message: "Celular inválido." });

  const password     = generatePassword();
  const passwordHash = await hashPassword(password);
  const wholesaler    = createWholesaler(phone, passwordHash, password, displayName);

  res.status(201).json({ wholesaler: { ...wholesaler, passwordHash: undefined }, password });
});

router.patch("/:id/status", (req, res) => {
  const status = req.body?.status === "disabled" ? "disabled" : "active";
  setWholesalerStatus(Number(req.params.id), status);
  const wholesaler = findWholesalerById(Number(req.params.id));
  if (!wholesaler) return res.status(404).json({ message: "Mayorista no encontrado." });
  res.json({ wholesaler: { ...wholesaler, passwordHash: undefined } });
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
