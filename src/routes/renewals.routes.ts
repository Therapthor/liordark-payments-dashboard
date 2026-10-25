import { Router } from "express";
import axios from "axios";
import { env } from "../config/env";
import {
  listExpiringClients, markReminderSent, listProfilesRemindedOn, limaTodayISOLocal, addDaysISOLocal,
  listUnSmsRemindedExpiringClientsForDate, markSmsReminderSent,
} from "../db/access.repository";
import { recordReminderSent, setReminderRunStatus, listReminderRuns } from "../db/reminder-runs.repository";
import {
  startSmsReminderRun, recordSmsReminderCounts, finishSmsReminderRun,
  listSmsReminderRuns, logSmsReminderResult, listSmsReminderLogOn,
} from "../db/sms-reminder-runs.repository";
import { sendSms } from "../services/sms.service";
import { buildSmsReminderText } from "../services/sms-reminder-message.service";
import { createCustomerNotification } from "../db/customer-notifications.repository";

const router = Router();

// Ventana de la tanda manual de recordatorios — exactamente 1 día de
// anticipación (vence mañana), ni más ni menos. Mismo valor que
// REMINDERS_WINDOW_DAYS en public/js/app.js.
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
  const clients = listExpiringClients(Number.isFinite(days) ? days : REMINDERS_WINDOW_DAYS, { exact: true });
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
  const remaining = listExpiringClients(REMINDERS_WINDOW_DAYS, { exact: true }).length;
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

// ─────────────────────────────────────────────────────────────
// SMS DE VENCIMIENTO (ClickLab/Infobip) — panel > Renovaciones > SMS.
// A diferencia de WhatsApp (tandas manuales por el bloqueador de
// pop-ups), acá es un solo POST: agrupa por celular, manda un SMS por
// cliente (todas sus cuentas por vencer en un solo mensaje) y deja
// registro de quién recibió qué para el historial.
// ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Solo números de Perú — 9 dígitos locales, o 11 con el prefijo 51. Un
// número de otro país (ej. Venezuela "58...") queda afuera del filtro acá
// mismo, antes de intentar mandarlo, para que nunca llegue a sendSms() y la
// tanda siga de corrido con el resto de clientes.
function isValidSmsPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 9 || (digits.length === 11 && digits.startsWith("51"));
}

function groupExpiringByPhone(clients: { profileId: number; clientPhone: string; platform: string; platformTag: string }[]) {
  const map = new Map<string, typeof clients>();
  for (const c of clients) {
    if (!map.has(c.clientPhone)) map.set(c.clientPhone, []);
    map.get(c.clientPhone)!.push(c);
  }
  return [...map.entries()].map(([clientPhone, accounts]) => ({ clientPhone, accounts }));
}

// GET /sms/days — "Hoy" y "Mañana" con cuántos clientes están listos
// para cada uno (sin mandar nada) — corridas pendientes/hechas, para que
// el admin elija qué día mandar en vez de un solo botón para ambos.
router.get("/sms/days", (_req, res) => {
  const today = limaTodayISOLocal();
  const tomorrow = addDaysISOLocal(today, 1);
  const days = [
    { date: today, label: "Hoy" },
    { date: tomorrow, label: "Mañana" },
  ].map(d => {
    const clients = listUnSmsRemindedExpiringClientsForDate(d.date);
    const pendingCount = groupExpiringByPhone(clients).filter(g => isValidSmsPhone(g.clientPhone)).length;
    return { ...d, pendingCount };
  });
  res.json({ days });
});

router.post("/sms/send", async (req, res) => {
  const date = String(req.body?.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ message: "Falta la fecha a mandar." });
  }

  const clients = listUnSmsRemindedExpiringClientsForDate(date);
  const groups = groupExpiringByPhone(clients).filter(g => isValidSmsPhone(g.clientPhone));

  if (groups.length === 0) {
    return res.json({ ok: true, sent: 0, failed: 0, message: "No hay clientes pendientes de SMS para ese día." });
  }

  const runDate = date;
  startSmsReminderRun(runDate);

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const text = buildSmsReminderText(group.accounts);
    const result = await sendSms(group.clientPhone, text);

    if (result.ok) {
      sent++;
      for (const account of group.accounts) {
        markSmsReminderSent(account.profileId);
        createCustomerNotification(group.clientPhone, "expiring", account.platform);
      }
      logSmsReminderResult({
        runDate, clientPhone: group.clientPhone,
        platforms: group.accounts.map(a => a.platform).join(", "),
        status: "sent", messageId: result.messageId,
      });
    } else {
      failed++;
      logSmsReminderResult({
        runDate, clientPhone: group.clientPhone,
        platforms: group.accounts.map(a => a.platform).join(", "),
        status: "failed", error: result.error,
      });
    }
    recordSmsReminderCounts(runDate, result.ok ? 1 : 0, result.ok ? 0 : 1);
    if (i < groups.length - 1) await sleep(300);
  }

  finishSmsReminderRun(runDate, failed > 0 ? "incomplete" : "complete");
  res.json({ ok: true, sent, failed });
});

router.get("/sms/runs", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 14, 60);
  const runs = listSmsReminderRuns(limit);
  const today = limaTodayISOLocal();
  if (!runs.some(r => r.runDate === today)) {
    runs.unshift({ runDate: today, sentCount: 0, failedCount: 0, status: "pending", startedAt: null, completedAt: null });
  }
  res.json({ runs });
});

router.get("/sms/runs/:date/detail", (req, res) => {
  const date = String(req.params.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ message: "Fecha inválida." });
  }
  res.json({ entries: listSmsReminderLogOn(date) });
});

export default router;
