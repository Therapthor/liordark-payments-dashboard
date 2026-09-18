import { Router } from "express";
import axios from "axios";
import { env } from "../config/env";

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

export default router;
