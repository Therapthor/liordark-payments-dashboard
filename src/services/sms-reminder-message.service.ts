// ─────────────────────────────────────────────────────────────
// Texto del SMS de recordatorio de vencimiento (panel > Renovaciones >
// SMS). Reglas acordadas con el admin:
//   - Sin tildes/ñ/emojis (ClickLab: "160 caracteres sin tildes" — un
//     solo caracter fuera de ASCII cambia la codificación a UCS-2 y el
//     límite baja a 70, duplicando el costo).
//   - Sin precio (ocupa espacio de más).
//   - Hasta 3 plataformas nombradas; de ahí para arriba, mensaje
//     genérico ("Tienes N cuentas...") para no arriesgar el límite.
//   - YOUTUBE PREMIUM (y cualquier plataforma no renovable) no dice
//     "Renueva" — se compra de nuevo, no se extiende la misma cuenta.
// ─────────────────────────────────────────────────────────────

const SMS_MAX_LEN = 160;
const SMS_MAX_NAMED_PLATFORMS = 3;

// YOUTUBE PREMIUM no es renovable — cada ciclo es una compra nueva
// (mismo criterio que wholesaler.routes.ts / wholesalers-admin.routes.ts).
export function isNonRenewablePlatform(platform: string): boolean {
  return /youtube/i.test(platform);
}

// GSM-7 básico no trae tildes ni ñ — se reemplazan por su letra sin
// acento (á→a, ñ→n) en vez de dejarlas (forzarían codificación Unicode).
function toGsmSafe(s: string): string {
  return s
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/ñ/gi, m => (m === "ñ" ? "n" : "N"));
}

// Enlace de renovación directa — solo tiene sentido cuando el SMS habla de
// UNA sola cuenta renovable (con 2+ cuentas el link solo renovaría una,
// así que ahí se manda a liordark.com como antes).
export function buildSmsReminderText(
  accounts: { platform: string; platformTag: string }[],
  renewUrl?: string
): string {
  const names = accounts.map(a => (a.platformTag || a.platform).trim().toUpperCase());
  const allNonRenewable = accounts.every(a => isNonRenewablePlatform(a.platform));
  const someNonRenewable = accounts.some(a => isNonRenewablePlatform(a.platform));
  const mixed = someNonRenewable && !allNonRenewable;

  const actionLine = mixed
    ? "Entra a liordark.com o escribenos: 963081436."
    : allNonRenewable
    ? "Compra de nuevo en liordark.com o escribenos: 963081436."
    : "Renueva en liordark.com o escribenos: 963081436.";

  let text: string;
  if (names.length === 1 && renewUrl && !allNonRenewable) {
    text = `Manguito! Tu cuenta ${names[0]} vence pronto. Renuevala aqui: ${renewUrl} Buen dia!`;
  } else if (names.length === 1) {
    text = `Manguito! Tu cuenta ${names[0]} vence pronto. ${actionLine} Buen dia!`;
  } else if (names.length <= SMS_MAX_NAMED_PLATFORMS) {
    text = `Manguito! Estas cuentas vencen pronto: ${names.join(" y ")}. ${actionLine} Buen dia!`;
  } else {
    text = `Manguito! Tienes ${names.length} cuentas por vencer pronto. Revisalas en liordark.com o escribenos: 963081436. Buen dia!`;
  }

  text = toGsmSafe(text);

  // Red de seguridad: si por nombres de plataforma muy largos igual se
  // pasa de 160, se cae al genérico (siempre cabe, ver pruebas hechas).
  if (text.length > SMS_MAX_LEN) {
    text = toGsmSafe(`Manguito! Tienes ${names.length} cuentas por vencer pronto. Revisalas en liordark.com o escribenos: 963081436. Buen dia!`);
  }
  return text;
}
