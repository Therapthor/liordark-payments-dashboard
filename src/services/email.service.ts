import { Resend } from "resend";
import { env } from "../config/env";

// ─────────────────────────────────────────────────────────────
// CORREOS (Resend) — recordatorio de vencimiento a clientes retail que
// registraron su correo. Sin RESEND_API_KEY configurado, sendEmail() no
// hace nada (no rompe el job diario, solo no manda nada — mismo criterio
// que sms.service.ts con SMS_API_KEY).
// ─────────────────────────────────────────────────────────────

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!resend) {
    console.warn("⚠️ RESEND_API_KEY no configurado — correo no enviado:", to, subject);
    return false;
  }
  try {
    const { error } = await resend.emails.send({
      from:    env.RESEND_FROM_EMAIL,
      to,
      subject,
      html,
    });
    if (error) {
      console.error("⚠️ Resend rechazó el correo:", to, error.message);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error("⚠️ Error enviando correo:", to, err?.message);
    return false;
  }
}
