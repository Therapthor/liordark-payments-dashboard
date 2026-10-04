import { Router } from "express";
import axios from "axios";
import { env } from "../config/env";
import type { RequestWithWholesaler } from "../services/wholesaler-auth.service";
import { findWholesalerById, touchWholesalerActivity } from "../db/wholesaler.repository";
import { listLedgerForWholesaler, applyWholesalerCreditChange } from "../db/wholesaler-credit.repository";
import {
  listWholesalerStockSummary,
  listWholesalerClients,
  sellProfileForWholesaler,
  getProfileById,
  getAccountById,
  releaseProfile,
  releaseProfilesByOrderRef,
  setProfileRenewal,
  markReminderSent,
  listExpiringClientsForWholesaler,
  type RenewalStatus,
} from "../db/access.repository";
import { getCatalogProductByPlatform, listCatalogProducts } from "../db/catalog.repository";
import { listPaymentMethods } from "../db/payment-method.repository";
import { renewAccount } from "../services/access.service";
import {
  createFullAccountOrder,
  listFullAccountOrdersForWholesaler,
  markFullAccountSeenByWholesaler,
  countUnseenFullAccountsForWholesaler,
} from "../db/wholesale-full-account.repository";

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

// ── CATÁLOGO (precio mayorista, solo plataformas con stock asignado) ──

router.get("/catalog", (req, res) => {
  const stock = listWholesalerStockSummary(wid(req)).filter(s => s.free > 0);
  const products = listCatalogProducts(true);

  const catalog = stock.map(s => {
    const product = products.find(p => p.platform.trim().toUpperCase() === s.platform);
    return {
      platform:          s.platform,
      title:             product?.title || s.platform,
      wholesalePrice:    product?.wholesalePrice ?? "0",
      wholesaleFullPrice: product?.wholesaleFullPrice ?? "0",
      imageUrl:          product?.imageUrl ?? "",
      freeStock:         s.free,
    };
  });
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

  if (platforms.length === 0) return res.status(400).json({ message: "El carrito está vacío." });
  if (clientPhone.length < 9) return res.status(400).json({ message: "Celular del cliente inválido." });

  let totalCents = 0;
  for (const platform of platforms) {
    const product = getCatalogProductByPlatform(platform);
    const price = Number(product?.wholesalePrice ?? 0);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(422).json({ message: `"${platform}" no tiene precio mayorista configurado.` });
    }
    totalCents += Math.round(price * 100);
  }

  const orderRef = "wholesale:" + wholesalerId + ":" + Date.now();
  const deduction = applyWholesalerCreditChange(wholesalerId, -totalCents, "purchase_profile", orderRef, "system");
  if (!deduction.ok) {
    return res.status(402).json({ message: deduction.error });
  }

  const sold: { platform: string; email: string; password: string }[] = [];
  const failedPlatforms: string[] = [];
  for (const platform of platforms) {
    const result = sellProfileForWholesaler(platform, wholesalerId, clientPhone, orderRef);
    if (result) {
      const account = getAccountById(result.accountId);
      sold.push({ platform, email: account?.email ?? "", password: account?.password ?? "" });
    } else {
      failedPlatforms.push(platform);
    }
  }

  if (failedPlatforms.length > 0) {
    // Sin stock real para alguna plataforma (se agotó justo ahora) —
    // se revierte TODO: libera lo que sí se vendió (mismo orderRef) y
    // devuelve el crédito, para no dejar una compra parcial cobrada a medias.
    releaseProfilesByOrderRef(orderRef);
    applyWholesalerCreditChange(wholesalerId, totalCents, "purchase_profile", orderRef + ":revert", "system");
    return res.status(409).json({
      message: `Sin stock disponible para: ${failedPlatforms.join(", ")}. No se cobró nada.`,
    });
  }

  touchWholesalerActivity(wholesalerId);
  res.json({ ok: true, accounts: sold, totalCents });
});

// ── CUENTAS COMPLETAS A PEDIDO ──

router.post("/full-account-orders", (req, res) => {
  const wholesalerId = wid(req);
  const platform      = String(req.body?.platform ?? "").trim().toUpperCase();
  const quantity       = Math.max(1, Number(req.body?.quantity) || 1);
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

  const orderRef = "wholesale-full:" + wholesalerId + ":" + Date.now();
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

router.get("/clients", (req, res) => {
  res.json({ clients: listWholesalerClients(wid(req)) });
});

// Renovar = consume créditos a precio mayorista y extiende la cuenta 30
// días (comparte vencimiento con el resto de clientes de esa cuenta,
// igual que en Accesos). Bloquea sin tocar nada si no alcanza el saldo.
router.post("/clients/:profileId/renew", (req, res) => {
  const wholesalerId = wid(req);
  const profileId = Number(req.params.profileId);
  const profile = getProfileById(profileId);
  // 404 (no 403) a propósito — no confirma ni niega que el perfil exista
  // si no es de este mayorista, igual que el resto de este archivo.
  if (!profile || profile.wholesalerId !== wholesalerId) {
    return res.status(404).json({ message: "Perfil no encontrado." });
  }

  const account = getAccountById(profile.accountId);
  if (!account) return res.status(404).json({ message: "Cuenta no encontrada." });

  const product = getCatalogProductByPlatform(account.platform);
  const price = Number(product?.wholesalePrice ?? 0);
  if (!Number.isFinite(price) || price <= 0) {
    return res.status(422).json({ message: `"${account.platform}" no tiene precio mayorista configurado.` });
  }
  const priceCents = Math.round(price * 100);

  const orderRef = "wholesale-renew:" + wholesalerId + ":" + profileId + ":" + Date.now();
  const deduction = applyWholesalerCreditChange(wholesalerId, -priceCents, "renewal", orderRef, "system");
  if (!deduction.ok) return res.status(402).json({ message: deduction.error });

  renewAccount(account.id);
  touchWholesalerActivity(wholesalerId);
  res.json({ ok: true, account: getAccountById(account.id) });
});

router.delete("/clients/:profileId", (req, res) => {
  const profile = getProfileById(Number(req.params.profileId));
  if (!profile || profile.wholesalerId !== wid(req)) {
    return res.status(404).json({ message: "Perfil no encontrado." });
  }
  releaseProfile(profile.id);
  res.json({ ok: true });
});

router.post("/clients/:profileId/renewal-marker", (req, res) => {
  const status = String(req.body?.status ?? "") as RenewalStatus;
  if (!["", "yes", "no"].includes(status)) return res.status(400).json({ message: "Status inválido." });

  const existing = getProfileById(Number(req.params.profileId));
  if (!existing || existing.wholesalerId !== wid(req)) {
    return res.status(404).json({ message: "Perfil no encontrado." });
  }

  const profile = setProfileRenewal(existing.id, status);
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
  const days = Number(req.query.days ?? 0);
  const clients = listExpiringClientsForWholesaler(wid(req), Number.isFinite(days) ? days : 0, { excludeAlreadyExpired: true });
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

export default router;
