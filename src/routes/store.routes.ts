import { Router } from "express";
import axios from "axios";
import { env } from "../config/env";
import { requireCustomerSession, type RequestWithCustomer } from "../services/customer-auth.service";
import { findCustomerById } from "../db/customer.repository";
import { listCatalogProducts } from "../db/catalog.repository";
import { listCombos } from "../db/combo.repository";
import { listPaymentMethods } from "../db/payment-method.repository";
import { listAccountsByClientPhone } from "../db/access.repository";
import { daysLeft } from "../services/access.service";

// ─────────────────────────────────────────────────────────────
// TIENDA WEB (liordark.com) — todo detrás de sesión de cliente, como
// pidió el negocio: nada se ve sin loguearse primero.
// ─────────────────────────────────────────────────────────────

const router = Router();

router.use(requireCustomerSession);

// GET /api/store/catalog — productos + combos activos
router.get("/catalog", (_req, res) => {
  res.json({
    products: listCatalogProducts(true),
    combos:   listCombos(true),
  });
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

  res.json({ accounts });
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
  if (!platform && !comboId) {
    return res.status(400).json({ message: "Falta 'platform' o 'comboId'." });
  }

  // CANVA se activa a mano en Canva.com con el correo del cliente — sin
  // eso el pedido llega sin forma de completarse.
  if (platform && /canva/i.test(platform) && !clientEmail) {
    return res.status(400).json({ message: "Falta el correo para activar Canva." });
  }

  try {
    const response = await axios.post(
      env.BOT_BASE_URL + "/api/web-orders",
      { phone: customer.phone, platform, comboId, clientEmail },
      { headers: { "x-dashboard-key": env.DASHBOARD_API_KEY }, timeout: 15_000 }
    );
    res.json({ orderName: response.data.orderName, amount: response.data.amount });
  } catch (err: any) {
    const message = err?.response?.data?.message || "No se pudo crear la orden. Intenta de nuevo.";
    res.status(err?.response?.status || 502).json({ message });
  }
});

export default router;
