import { Router } from "express";
import axios from "axios";
import { env } from "../config/env";
import { getRecentApprovedOrders, searchApprovedOrders } from "../db/orders.repository";

const router = Router();

// ─────────────────────────────────────────────────────────────
// GET /api/orders/pending
//
// Proxy en vivo a GET /api/dashboard/orders del bot — es estado
// actual (qué está pendiente ahora mismo), no se guarda acá, se pide
// fresco cada vez que el panel lo necesita.
// ─────────────────────────────────────────────────────────────

router.get("/pending", async (_req, res) => {
  try {
    const response = await axios.get(env.BOT_BASE_URL + "/api/dashboard/orders", {
      headers: { "x-dashboard-key": env.DASHBOARD_API_KEY },
      timeout: 10_000,
    });
    res.json({ orders: response.data?.orders ?? [] });
  } catch (err: any) {
    console.error("❌ No se pudo obtener pendientes del bot:", err?.response?.status || err?.message);
    res.status(502).json({ message: "No se pudo conectar con el bot." });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/orders/approved
//
// Historial propio (permanente) de órdenes aprobadas.
// ─────────────────────────────────────────────────────────────

router.get("/approved", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 200);
  const phone = String(req.query.phone ?? "").replace(/\D/g, "");

  if (phone) {
    res.json({ orders: searchApprovedOrders(phone, limit) });
    return;
  }
  res.json({ orders: getRecentApprovedOrders(limit) });
});

// ─────────────────────────────────────────────────────────────
// POST /api/orders/:orderName/approve
// POST /api/orders/:orderName/reject
//
// Proxy directo a los endpoints equivalentes del bot — la lógica de
// aprobar/rechazar vive ahí (reusa lo mismo que los botones de
// Telegram). Acá solo se reenvía la acción con la clave compartida.
// ─────────────────────────────────────────────────────────────

async function proxyOrderAction(orderName: string, action: "approve" | "reject" | "clear") {
  return axios.post(
    env.BOT_BASE_URL + "/api/dashboard/orders/" + encodeURIComponent(orderName) + "/" + action,
    {},
    { headers: { "x-dashboard-key": env.DASHBOARD_API_KEY }, timeout: 30_000 }
  );
}

router.post("/:orderName/approve", async (req, res) => {
  try {
    const response = await proxyOrderAction(req.params.orderName, "approve");
    res.status(response.status).json(response.data);
  } catch (err: any) {
    const status = err?.response?.status ?? 502;
    res.status(status).json(err?.response?.data ?? { success: false, message: "No se pudo conectar con el bot." });
  }
});

router.post("/:orderName/reject", async (req, res) => {
  try {
    const response = await proxyOrderAction(req.params.orderName, "reject");
    res.status(response.status).json(response.data);
  } catch (err: any) {
    const status = err?.response?.status ?? 502;
    res.status(status).json(err?.response?.data ?? { success: false, message: "No se pudo conectar con el bot." });
  }
});

router.post("/:orderName/clear", async (req, res) => {
  try {
    const response = await proxyOrderAction(req.params.orderName, "clear");
    res.status(response.status).json(response.data);
  } catch (err: any) {
    const status = err?.response?.status ?? 502;
    res.status(status).json(err?.response?.data ?? { success: false, message: "No se pudo conectar con el bot." });
  }
});

export default router;
