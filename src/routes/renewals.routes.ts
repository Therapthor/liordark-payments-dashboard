import { Router } from "express";
import axios from "axios";
import { env } from "../config/env";
import {
  listProviderSubscriptions,
  createProviderSubscription,
  updateProviderSubscription,
  deleteProviderSubscription,
  markSubscriptionRenewed,
} from "../db/provider-subscriptions.repository";

const router = Router();

// ─────────────────────────────────────────────────────────────
// GET /api/renewals/notifications
//
// Proxy en vivo a GET /api/dashboard/renewal-notifications del bot —
// detalle por cliente de los avisos de vencimiento/renovación enviados
// (o fallidos), para la vista "Pagos > Renovaciones".
// ─────────────────────────────────────────────────────────────

router.get("/notifications", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const response = await axios.get(env.BOT_BASE_URL + "/api/dashboard/renewal-notifications", {
      params:  { limit },
      headers: { "x-dashboard-key": env.DASHBOARD_API_KEY },
      timeout: 10_000,
    });
    res.json({
      entries:     response.data?.entries ?? [],
      todaySent:   response.data?.todaySent ?? 0,
      todayFailed: response.data?.todayFailed ?? 0,
      runHistory:  response.data?.runHistory ?? [],
    });
  } catch (err: any) {
    console.error("❌ No se pudo obtener notificaciones de renovación del bot:", err?.response?.status || err?.message);
    res.status(502).json({ message: "No se pudo conectar con el bot." });
  }
});

// ─────────────────────────────────────────────────────────────
// Suscripciones propias — productos que se venden como plan anual pero
// que Liordark paga/renueva mes a mes con el proveedor. Vive en la misma
// vista "Pagos > Renovaciones" del panel.
// ─────────────────────────────────────────────────────────────

router.get("/subscriptions", (_req, res) => {
  res.json({ subscriptions: listProviderSubscriptions() });
});

function parseSubscriptionBody(body: any) {
  return {
    productName:     String(body?.productName ?? "").trim(),
    costAmount:      String(body?.costAmount ?? "").trim(),
    costCurrency:    String(body?.costCurrency ?? "USDT").trim(),
    nextRenewalDate: String(body?.nextRenewalDate ?? "").trim(),
    notes:           String(body?.notes ?? "").trim(),
  };
}

router.post("/subscriptions", (req, res) => {
  const data = parseSubscriptionBody(req.body);
  if (!data.productName || !data.costAmount || !data.nextRenewalDate) {
    res.status(400).json({ message: "Faltan producto, costo o próxima fecha de renovación." });
    return;
  }
  res.status(201).json({ subscription: createProviderSubscription(data) });
});

router.put("/subscriptions/:id", (req, res) => {
  const data = parseSubscriptionBody(req.body);
  if (!data.productName || !data.costAmount || !data.nextRenewalDate) {
    res.status(400).json({ message: "Faltan producto, costo o próxima fecha de renovación." });
    return;
  }
  const updated = updateProviderSubscription(Number(req.params.id), data);
  if (!updated) {
    res.status(404).json({ message: "No encontrado." });
    return;
  }
  res.json({ subscription: updated });
});

router.post("/subscriptions/:id/mark-renewed", (req, res) => {
  const updated = markSubscriptionRenewed(Number(req.params.id));
  if (!updated) {
    res.status(404).json({ message: "No encontrado." });
    return;
  }
  res.json({ subscription: updated });
});

router.delete("/subscriptions/:id", (req, res) => {
  deleteProviderSubscription(Number(req.params.id));
  res.status(204).end();
});

export default router;
