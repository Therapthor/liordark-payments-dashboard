// ─────────────────────────────────────────────────────────────
// PLANTILLA DE CORREO «MANGO PRO» — la misma para todos los correos al
// cliente (compra, bienvenida, restablecer PIN, cambios de cuenta,
// soporte). Tablas + estilos inline a propósito: Gmail, Outlook y Apple
// Mail no cargan CSS externo ni todo el CSS moderno. Sin imágenes
// obligatorias: si el logo no carga, igual se ve bien.
// ─────────────────────────────────────────────────────────────

export const MANGO = {
  page: "#FFF8EC", band: "#FFC93C", bandDeep: "#FFB21A", card: "#FFFFFF", ink: "#2B1B0E",
  muted: "#8A6E4B", soft: "#F6EFE4", line: "#F1E4D3", leaf: "#1F6B44", leafSoft: "#E3F3E9",
  coral: "#E2552B", coralSoft: "#FFE4D6", chip: "#6B4A10",
};

const LOGO_URL = "https://liordark.com/assets/logo.webp";
export const STORE_URL = "https://liordark.com/";
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Filas «etiqueta → valor» (datos de acceso, PIN, vencimiento…). */
export function infoRows(rows: { label: string; value: string; strong?: boolean; mono?: boolean }[]): string {
  return rows.filter(r => r.value).map((r, i) => `
    <tr>
      <td style="padding: 10px 0; ${i ? `border-top: 1px solid ${MANGO.line};` : ""} font-family: ${FONT}; font-size: 13px; color: ${MANGO.muted}; white-space: nowrap; vertical-align: top;">${esc(r.label)}</td>
      <td align="right" style="padding: 10px 0 10px 14px; ${i ? `border-top: 1px solid ${MANGO.line};` : ""} font-family: ${r.mono ? "'SFMono-Regular', Menlo, Consolas, monospace" : FONT}; font-size: ${r.mono ? "16px" : "14px"}; font-weight: bold; color: ${MANGO.ink}; word-break: break-all; ${r.mono ? "letter-spacing: 3px;" : ""}">${esc(r.value)}</td>
    </tr>`).join("");
}

/** Caja suave con un título opcional (ej. «NETFLIX») y filas adentro. */
export function infoBox(rowsHtml: string, head?: { title: string; tag?: string }): string {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: ${MANGO.soft}; border-radius: 18px; margin: 0 0 12px;">
    ${head ? `<tr><td style="padding: 14px 18px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-family: ${FONT}; font-size: 15px; font-weight: bold; color: ${MANGO.ink};">${esc(head.title)}</td>
        ${head.tag ? `<td align="right"><span style="display: inline-block; background: ${MANGO.leafSoft}; color: ${MANGO.leaf}; font-family: ${FONT}; font-size: 11.5px; font-weight: bold; padding: 4px 10px; border-radius: 999px; white-space: nowrap;">${esc(head.tag)}</span></td>` : ""}
      </tr></table>
    </td></tr>` : ""}
    <tr><td style="padding: ${head ? "6px" : "8px"} 18px 8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table>
    </td></tr>
  </table>`;
}

/** Párrafo de texto normal dentro del correo. */
export function para(html: string, opts?: { muted?: boolean; small?: boolean; center?: boolean }): string {
  return `<p style="margin: 0 0 12px; font-family: ${FONT}; font-size: ${opts?.small ? "12.5px" : "14.5px"}; line-height: 1.55; color: ${opts?.muted ? MANGO.muted : MANGO.ink}; ${opts?.center ? "text-align: center;" : ""}">${html}</p>`;
}

/** Aviso destacado (consejo, advertencia). */
export function note(html: string, tone: "tip" | "warn" = "tip"): string {
  const bg = tone === "warn" ? MANGO.coralSoft : "#FFF3D1";
  const color = tone === "warn" ? "#7A3518" : MANGO.chip;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 4px 0 12px;"><tr>
    <td style="background: ${bg}; border-radius: 14px; padding: 12px 16px; font-family: ${FONT}; font-size: 13px; line-height: 1.5; color: ${color};">${html}</td>
  </tr></table>`;
}

/**
 * Correo completo. `preheader` es el texto que se ve junto al asunto en la
 * bandeja (no se muestra adentro). `body` es HTML ya armado con las
 * funciones de arriba.
 */
export function mangoEmail(opts: {
  preheader: string;
  kicker: string;
  title: string;
  intro?: string;
  body: string;
  cta?: { label: string; url: string };
  footnote?: string;
}): string {
  const { preheader, kicker, title, intro, body, cta, footnote } = opts;
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(title)}</title></head>
<body style="margin: 0; padding: 0; background: ${MANGO.page};">
<div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent;">${esc(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: ${MANGO.page};">
  <tr><td align="center" style="background: ${MANGO.band}; background-image: linear-gradient(135deg, ${MANGO.band} 0%, ${MANGO.bandDeep} 100%); padding: 30px 16px 76px;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="padding-right: 12px; vertical-align: middle;">
        <img src="${LOGO_URL}" width="46" height="46" alt="" style="display: block; width: 46px; height: 46px; border-radius: 999px; border: 3px solid #ffffff; background: #ffffff;">
      </td>
      <td style="vertical-align: middle; text-align: left;">
        <div style="font-family: ${FONT}; font-size: 20px; font-weight: bold; color: ${MANGO.ink}; letter-spacing: -.2px;">Manguitope</div>
        <div style="font-family: ${FONT}; font-size: 12px; font-weight: bold; color: ${MANGO.chip};">Tu streaming favorito, al toque 🥭</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td align="center" style="padding: 0 14px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 480px; margin: -52px auto 0; background: ${MANGO.card}; border-radius: 26px; box-shadow: 0 18px 40px -24px rgba(43,27,14,.55);">
      <tr><td style="padding: 28px 26px 6px;">
        <span style="display: inline-block; background: ${MANGO.soft}; color: ${MANGO.chip}; font-family: ${FONT}; font-size: 11.5px; font-weight: bold; letter-spacing: .6px; text-transform: uppercase; padding: 6px 12px; border-radius: 999px;">${esc(kicker)}</span>
        <h1 style="margin: 16px 0 8px; font-family: ${FONT}; font-size: 24px; line-height: 1.25; color: ${MANGO.ink}; letter-spacing: -.3px;">${esc(title)}</h1>
        ${intro ? `<p style="margin: 0 0 18px; font-family: ${FONT}; font-size: 15px; line-height: 1.55; color: ${MANGO.muted};">${esc(intro)}</p>` : `<div style="height: 10px;"></div>`}
      </td></tr>
      <tr><td style="padding: 0 26px;">${body}</td></tr>
      ${cta ? `<tr><td style="padding: 8px 26px 4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td align="center" style="background: ${MANGO.leaf}; border-radius: 16px;">
            <a href="${esc(cta.url)}" style="display: block; padding: 16px 18px; font-family: ${FONT}; font-size: 16px; font-weight: bold; color: #ffffff; text-decoration: none;">${esc(cta.label)}</a>
          </td>
        </tr></table>
      </td></tr>` : ""}
      <tr><td style="padding: 16px 26px 26px;">
        ${footnote ? `<p style="margin: 0 0 10px; font-family: ${FONT}; font-size: 12.5px; line-height: 1.5; color: ${MANGO.muted}; text-align: center;">${footnote}</p>` : ""}
      </td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 480px; margin: 0 auto;">
      <tr><td style="padding: 20px 10px 34px; text-align: center; font-family: ${FONT}; font-size: 12px; line-height: 1.6; color: ${MANGO.muted};">
        <b style="color: ${MANGO.ink};">Manguitope</b> · <a href="${STORE_URL}" style="color: ${MANGO.leaf}; text-decoration: none;">liordark.com</a><br>
        ¿Algún problema con tu cuenta? Repórtalo en <b>Soporte</b>, dentro de la tienda.<br>
        Recibes este correo porque tienes una cuenta en Manguitope.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}
