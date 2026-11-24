// ─────────────────────────────────────────────────────────────
// CLOUDINARY — RETIRADO (nov-2026). Todas las imágenes viven en el
// servidor (product-media.service). Solo queda esta función vacía porque
// el chat de soporte la llama al limpiar fotos viejas: las que quedaron
// en Cloudinary se dejan allá y el panel solo borra su registro.
// ─────────────────────────────────────────────────────────────

export async function deleteChatMedia(_publicId: string, _resourceType: string): Promise<void> {
  /* nada: Cloudinary retirado */
}
