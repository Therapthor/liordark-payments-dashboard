import { Router } from "express";
import axios from "axios";
import { env } from "../config/env";
import { getRecentApprovedOrders } from "../db/orders.repository";

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
  res.json({ orders: getRecentApprovedOrders(limit) });
});

export default router;
