import { findCustomerByPhone } from "../db/customer.repository";
import { getCatalogProductByPlatform } from "../db/catalog.repository";
import { sendEmail } from "./email.service";

// ─────────────────────────────────────────────────────────────
// CORREO DE NOVEDADES AL CLIENTE — cada vez que algo cambia en su cuenta
// (reemplazo, contraseña nueva, PIN nuevo, avances y cierre de su reporte
// de soporte) le llega, además de la campanita, un correo con el diseño
// Mango Pro. Solo a clientes que registraron su correo en liordark.com.
// Tablas + estilos inline: los clientes de correo no cargan CSS externo.
// ─────────────────────────────────────────────────────────────

export type UpdateEmailType = "account_replaced" | "password_changed" | "support_update" | "support_resolved";

const C = {
  bg: "#FFF8EC", band: "#FFC93C", card: "#FFFFFF", ink: "#2B1B0E", muted: "#8A6E4B",
  soft: "#F6EFE4", leaf: "#1F6B44", leafSoft: "#E3F3E9", line: "#F1E4D3",
};
const LOGO_URL = "https://liordark.com/assets/logo.webp";
const STORE_URL = "https://liordark.com/";

function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function platformTitle(platform: string): string {
  return getCatalogProductByPlatform(platform)?.title || platform.trim();
}

function isPinMessage(message: string): boolean {
  return /^🔐/.test(message.trim());
}

export function updateEmailSubject(type: UpdateEmailType, platform: string, message: string): string {
  const name = platformTitle(platform);
  if (type === "account_replaced") return `🔁 Tu nueva cuenta de ${name} ya está lista`;
  if (type === "password_changed") return `🔑 Nueva contraseña para tu cuenta de ${name}`;
  if (type === "support_resolved") return `✅ Tu soporte de ${name} está listo`;
  return isPinMessage(message) ? `🔐 PIN nuevo en tu perfil de ${name}` : `🛠️ Novedades de tu soporte de ${name}`;
}

function heading(type: UpdateEmailType, message: string): { title: string; intro: string } {
  if (type === "account_replaced") return { title: "Te dimos una cuenta nueva", intro: "Estos son tus nuevos datos de acceso. Tu fecha de vencimiento no cambia." };
  if (type === "password_changed") return { title: "Tu cuenta tiene contraseña nueva", intro: "Usa estos datos la próxima vez que ingreses." };
  if (type === "support_resolved") return { title: "Tu reporte quedó atendido", intro: "Esto es lo que hicimos con tu cuenta:" };
  return isPinMessage(message)
    ? { title: "Tu perfil tiene PIN nuevo", intro: "Lo necesitarás para entrar a tu perfil." }
    : { title: "Novedades de tu reporte", intro: "Así va tu soporte:" };
}

/** Cada línea «Correo: x» se muestra como fila (etiqueta + valor); el resto, como texto. */
function messageRows(message: string): string {
  return message.split("\n").map(line => line.trim()).filter(Boolean).map(line => {
    const m = line.match(/^(\S{1,3}\s)?([A-Za-zÁÉÍÓÚáéíóúñÑ ]{3,22}):\s+(.+)$/);
    if (m) {
      return `<tr>
        <td style="padding: 7px 0; font-size: 13px; color: ${C.muted}; white-space: nowrap; vertical-align: top;">${esc((m[1] || "") + m[2])}</td>
        <td style="padding: 7px 0 7px 12px; font-size: 14px; font-weight: bold; color: ${C.ink}; word-break: break-all;">${esc(m[3])}</td>
      </tr>`;
    }
    return `<tr><td colspan="2" style="padding: 6px 0; font-size: 14px; line-height: 1.45; color: ${C.ink};">${esc(line)}</td></tr>`;
  }).join("");
}

export function updateEmailHtml(type: UpdateEmailType, platform: string, message: string): string {
  const name = platformTitle(platform);
  const { title, intro } = heading(type, message);
  return `
<div style="background: ${C.bg}; padding: 0 0 28px; font-family: Arial, Helvetica, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: ${C.band};">
    <tr><td align="center" style="padding: 26px 16px 64px;">
      <img src="${LOGO_URL}" width="44" height="44" alt="Manguitope" style="display: block; width: 44px; height: 44px; border-radius: 999px; border: 3px solid #ffffff;">
      <div style="margin-top: 8px; font-size: 15px; font-weight: bold; color: ${C.ink}; letter-spacing: .3px;">🥭 Manguitope</div>
    </td></tr>
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 440px; margin: -44px auto 0; background: ${C.card}; border-radius: 22px; box-shadow: 0 16px 32px -20px rgba(43,27,14,.55);">
    <tr><td style="padding: 24px 24px 6px;">
      <span style="display: inline-block; background: ${C.soft}; color: ${C.ink}; font-size: 12px; font-weight: bold; padding: 5px 12px; border-radius: 999px;">${esc(name)}</span>
      <h1 style="margin: 14px 0 6px; font-size: 20px; line-height: 1.3; color: ${C.ink};">${esc(title)}</h1>
      <p style="margin: 0; font-size: 14px; color: ${C.muted}; line-height: 1.45;">${esc(intro)}</p>
    </td></tr>
    <tr><td style="padding: 14px 24px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: ${C.soft}; border-radius: 16px;">
        <tr><td style="padding: 12px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${messageRows(message)}</table>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding: 18px 24px 24px;">
      <a href="${STORE_URL}" style="display: block; text-align: center; background: ${C.leaf}; color: #ffffff; font-size: 15px; font-weight: bold; text-decoration: none; padding: 14px; border-radius: 14px;">Ver mis cuentas</a>
      <p style="margin: 14px 0 0; text-align: center; font-size: 12px; color: ${C.muted}; line-height: 1.45;">
        ¿Algún problema? Repórtalo en <b>Soporte</b> dentro de liordark.com.<br>
        Recibes este correo porque registraste tu correo en Manguitope.
      </p>
    </td></tr>
  </table>
</div>`;
}

/** Manda el correo si el cliente tiene uno guardado. Nunca lanza error. */
export async function emailCustomerUpdate(clientPhone: string, type: UpdateEmailType, platform: string, message: string): Promise<void> {
  try {
    const customer = findCustomerByPhone(clientPhone);
    const to = customer?.email?.trim();
    if (!to || !message.trim()) return;
    await sendEmail(to, updateEmailSubject(type, platform, message), updateEmailHtml(type, platform, message));
  } catch (err: any) {
    console.error("⚠️ correo de novedades al cliente:", err?.message);
  }
}
