import { Router } from "express";
import axios from "axios";
import { env } from "../config/env";
import { listExpiringClients, markReminderSent } from "../db/access.repository";

const router = Router();

// ─────────────────────────────────────────────────────────────
// GET /api/renewals/expiring — clientes por vencer, para armar tandas de
// recordatorio MANUAL por WhatsApp (panel > Renovaciones). Reemplaza el
// aviso automático por WhatsApp Business API (dado de baja por Meta) —
// acá el admin arma tandas de 5 y las manda él mismo, espaciadas, para no
// repetir el patrón que causó el bloqueo.
// ─────────────────────────────────────────────────────────────

router.get("/expiring", (req, res) => {
  const days = Number(req.query.days ?? 5);
  const clients = listExpiringClients(Number.isFinite(days) ? days : 5, { excludeAlreadyExpired: true });
  res.json({ clients });
});

router.post("/:profileId/mark-reminded", (req, res) => {
  const profileId = Number(req.params.profileId);
  if (!Number.isFinite(profileId)) {
    return res.status(400).json({ message: "profileId inválido." });
  }
  markReminderSent(profileId);
  res.json({ ok: true });
});

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
