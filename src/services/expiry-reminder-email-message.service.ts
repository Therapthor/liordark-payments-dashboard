// ─────────────────────────────────────────────────────────────
// HTML del correo de recordatorio de vencimiento — estilo "ticket"
// (propuesta visual 4C, aprobada). Tablas + estilos inline a propósito,
// no las clases de style.css: los clientes de correo (Gmail, Outlook...)
// no cargan hojas de estilo externas ni todo el CSS moderno.
// ─────────────────────────────────────────────────────────────

const COLOR = {
  bg: "#e9e4da", card: "#ffffff", text: "#241a10", muted: "#8a7660",
  accent: "#ff7a1a", accent2: "#ffb020", btn: "#e35d00",
  border: "#f1e4d3", danger: "#d1373d",
};

export function buildExpiryReminderSubject(platformTag: string, daysLeft: 1 | 3): string {
  return daysLeft === 1
    ? `Tu cuenta de ${platformTag} vence mañana`
    : `Tu cuenta de ${platformTag} vence en 3 días`;
}

export function buildExpiryReminderHtml(params: {
  platformTag: string;
  price: string;
  daysLeft: 1 | 3;
  renewUrl: string;
}): string {
  const { platformTag, price, daysLeft, renewUrl } = params;
  const whenLabel = daysLeft === 1 ? "Vence mañana" : `Vence en ${daysLeft} días`;

  return `
<div style="background: ${COLOR.bg}; padding: 24px 16px; font-family: Arial, Helvetica, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 420px; margin: 0 auto; background: ${COLOR.card}; border-radius: 18px; overflow: hidden; box-shadow: 0 12px 30px rgba(36,26,16,.12);">
    <tr>
      <td style="padding: 26px 26px 20px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="width: 40px; height: 40px; border-radius: 10px; background: ${COLOR.accent2}; font-size: 0; line-height: 0;">&nbsp;</td>
          <td style="padding-left: 12px;">
            <div style="font-family: Arial, sans-serif; font-weight: bold; font-size: 14px; color: ${COLOR.text};">${platformTag}</div>
            <div style="font-size: 11.5px; color: ${COLOR.danger}; font-weight: bold;">${whenLabel}</div>
          </td>
        </tr></table>
        <h1 style="margin: 16px 0 0; font-family: Arial, sans-serif; font-size: 17px; color: ${COLOR.text}; line-height: 1.35;">Tu orden de renovación ya está lista</h1>
      </td>
    </tr>
    <tr><td style="padding: 0 24px;"><div style="border-top: 2px dashed ${COLOR.border};"></div></td></tr>
    <tr>
      <td style="padding: 20px 26px 26px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size: 12.5px; color: ${COLOR.muted};">Total a pagar</td>
          <td align="right" style="font-family: Arial, sans-serif; font-weight: bold; font-size: 22px; color: ${COLOR.text};">S/ ${price}</td>
        </tr></table>
        <div style="height: 14px; line-height: 14px; font-size: 0;">&nbsp;</div>
        <a href="${renewUrl}" style="display: block; text-align: center; background: ${COLOR.btn}; color: #ffffff; font-family: Arial, sans-serif; font-weight: bold; font-size: 14.5px; text-decoration: none; padding: 14px; border-radius: 10px;">
          Renovar ahora
        </a>
        <p style="margin: 16px 0 0; text-align: center; font-size: 11px; color: ${COLOR.muted};">
          Liordark — si no reconoces esta cuenta, ignora este correo.
        </p>
      </td>
    </tr>
  </table>
</div>
  `;
}
