import {
  listEmailReminderCandidates,
  markEmailReminder3dSent,
  markEmailReminder1dSent,
} from "../db/access.repository";
import { daysLeft } from "../services/access.service";
import { createRenewalToken } from "../utils/renewal-token.util";
import { sendEmail } from "../services/email.service";
import { buildExpiryReminderSubject, buildExpiryReminderHtml } from "../services/expiry-reminder-email-message.service";

// ─────────────────────────────────────────────────────────────
// Recordatorio de vencimiento por CORREO — 3 días y 1 día antes. Corre
// desde index.ts (setInterval, igual que los demás jobs periódicos del
// panel). Un mismo cliente puede recibir el de 3 días y, días después
// (otra corrida), el de 1 día — cada marca es independiente
// (email_reminder_3d_sent_at / _1d_sent_at en access_profiles).
// ─────────────────────────────────────────────────────────────

export async function runExpiryReminderEmails(): Promise<void> {
  const candidates = listEmailReminderCandidates(3);

  for (const c of candidates) {
    const left = daysLeft(c.expiresAt);
    if (left === null) continue; // no debería pasar (la consulta ya exige expires_at <= límite), red de seguridad

    const token = createRenewalToken(c.clientPhone, c.platform);
    const renewUrl = `https://liordark.com/renovar.html?token=${token}`;

    if (left <= 1) {
      const ok = await sendEmail(
        c.customerEmail,
        buildExpiryReminderSubject(c.platformTag, 1),
        buildExpiryReminderHtml({ platformTag: c.platformTag, price: c.price, daysLeft: 1, renewUrl })
      );
      if (ok) markEmailReminder1dSent(c.profileId);
    } else if (left <= 3 && !c.d3AlreadySent) {
      const ok = await sendEmail(
        c.customerEmail,
        buildExpiryReminderSubject(c.platformTag, 3),
        buildExpiryReminderHtml({ platformTag: c.platformTag, price: c.price, daysLeft: 3, renewUrl })
      );
      if (ok) markEmailReminder3dSent(c.profileId);
    }
  }
}
