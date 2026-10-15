import { Router } from "express";
import axios from "axios";
import { env } from "../config/env";
import { listExpiringClients, markReminderSent, listProfilesRemindedOn, limaTodayISOLocal } from "../db/access.repository";
import { recordReminderSent, setReminderRunStatus, listReminderRuns } from "../db/reminder-runs.repository";

const router = Router();

// Ventana de la tanda manual de recordatorios — hoy y mañana (1 día de
// anticipación, para que el cliente alcance a renovar antes de quedarse
// sin servicio). Mismo valor que REMINDERS_WINDOW_DAYS en public/js/app.js.
const REMINDERS_WINDOW_DAYS = 1;

// ─────────────────────────────────────────────────────────────
// GET /api/renewals/expiring — clientes por vencer, para armar tandas de
// recordatorio MANUAL por WhatsApp (panel > Renovaciones). Reemplaza el
// aviso automático por WhatsApp Business API (dado de baja por Meta) —
// acá el admin arma tandas de 5 y las manda él mismo, espaciadas, para no
// repetir el patrón que causó el bloqueo.
// ─────────────────────────────────────────────────────────────

router.get("/expiring", (req, res) => {
  const days = Number(req.query.days ?? REMINDERS_WINDOW_DAYS);
  const clients = listExpiringClients(Number.isFinite(days) ? days : REMINDERS_WINDOW_DAYS, { excludeAlreadyExpired: true });
  res.json({ clients });
});

router.post("/:profileId/mark-reminded", (req, res) => {
  const profileId = Number(req.params.profileId);
  if (!Number.isFinite(profileId)) {
    return res.status(400).json({ message: "profileId inválido." });
  }
  markReminderSent(profileId);

  // Corrida del día — se registra el envío y se recalcula si ya no queda
  // nadie pendiente (completa) o todavía falta gente (incompleta).
  const runDate = limaTodayISOLocal();
  recordReminderSent(runDate);
  const remaining = listExpiringClients(REMINDERS_WINDOW_DAYS, { excludeAlreadyExpired: true }).length;
  setReminderRunStatus(runDate, remaining === 0 ? "complete" : "incomplete");

  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// GET /api/renewals/runs — historial de corridas (panel > Renovaciones),
// una fila por día. Si hoy todavía no tiene ninguna tanda mandada, se
// agrega igual como "pending" para que siempre se vea el día de hoy.
// ─────────────────────────────────────────────────────────────

router.get("/runs", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 14, 60);
  const runs = listReminderRuns(limit);
  const today = limaTodayISOLocal();
  if (!runs.some(r => r.runDate === today)) {
    runs.unshift({ runDate: today, sentCount: 0, status: "pending", lastSentAt: null, completedAt: null });
  }
  res.json({ runs });
});

router.get("/runs/:date/detail", (req, res) => {
  const date = String(req.params.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ message: "Fecha inválida." });
  }
  res.json({ clients: listProfilesRemindedOn(date) });
});

// ─────────────────────────────────────────────────────────────
// GET /api/renewals/notifications
//
// Proxy en vivo a GET /api/dashboard/renewal-notifications del bot —
// solo para los contadores "Hoy: N enviados / M fallidos" (el detalle
// por día de "Corridas anteriores" ya no sale de acá, ver /runs arriba).
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
    });
  } catch (err: any) {
    console.error("❌ No se pudo obtener notificaciones de renovación del bot:", err?.response?.status || err?.message);
    res.status(502).json({ message: "No se pudo conectar con el bot." });
  }
});

export default router;
