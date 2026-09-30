// Normaliza un celular a formato completo con código de país (51 + 9
// dígitos) — WhatsApp (wa.me / api.whatsapp.com) necesita el número
// completo para abrir el chat correcto; un celular guardado como
// "921143796" (sin el 51) en vez de "51921143796" genera un link que no
// abre la conversación correcta. Los celulares de Perú son siempre 9
// dígitos, así que un valor de exactamente 9 dígitos es claramente el
// número local sin prefijo.
export function normalizePeruPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 9 ? "51" + digits : digits;
}
