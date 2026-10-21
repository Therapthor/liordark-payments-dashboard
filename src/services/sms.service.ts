import axios from "axios";
import { env } from "../config/env";

// ─────────────────────────────────────────────────────────────
// SMS vía ClickLab (revende la plataforma de Infobip) — usado por los
// recordatorios de vencimiento (panel > Renovaciones > SMS). Probado en
// producción: el remitente alfanumérico ("LIORDARK") no está registrado
// ante el operador peruano, así que el SMS igual llega pero el remitente
// que ve el cliente es un shortcode genérico (ej. "76555"), no el nombre.
// ─────────────────────────────────────────────────────────────

const SMS_API_BASE = "https://api.infobip.com";

export type SendSmsResult = { ok: true; messageId: string } | { ok: false; error: string };

export async function sendSms(to: string, text: string): Promise<SendSmsResult> {
  if (!env.SMS_API_KEY) return { ok: false, error: "SMS_API_KEY no configurada." };

  try {
    const response = await axios.post(
      SMS_API_BASE + "/sms/1/text/single",
      { from: env.SMS_SENDER, to, text },
      {
        headers: {
          Authorization: "App " + env.SMS_API_KEY,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 15_000,
      }
    );
    const message = response.data?.messages?.[0];
    // groupId: 1=PENDING (recién aceptado), 3=DELIVERED — ambos cuentan
    // como "se mandó bien" acá (no se espera el reporte de entrega, que
    // es una consulta aparte); 2/4/5 son rechazo/expirado/no entregado.
    const groupId = message?.status?.groupId;
    if (groupId === 2 || groupId === 4 || groupId === 5) {
      return { ok: false, error: message?.status?.description || "Mensaje rechazado." };
    }
    return { ok: true, messageId: message?.messageId || "" };
  } catch (err: any) {
    const apiMsg = err?.response?.data?.requestError?.serviceException?.text;
    return { ok: false, error: apiMsg || err?.message || "Error desconocido al enviar el SMS." };
  }
}
