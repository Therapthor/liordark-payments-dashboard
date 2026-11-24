import { v2 as cloudinary } from "cloudinary";
import { env } from "../config/env";

// ─────────────────────────────────────────────────────────────
// CLOUDINARY — RETIRADO (nov-2026). Todas las imágenes viven en el
// servidor (product-media.service). Esto solo queda para leer UNA vez
// dónde estaba la imagen del saludo del bot y pasarla al servidor; si las
// variables no están, no hace nada.
// ─────────────────────────────────────────────────────────────

export function isCloudinaryConfigured(): boolean {
  return !!(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}

/** Dirección de la imagen del saludo del bot que había en Cloudinary (o null). */
export async function getPrincipalImageUrl(): Promise<string | null> {
  if (!isCloudinaryConfigured()) return null;
  cloudinary.config({ cloud_name: env.CLOUDINARY_CLOUD_NAME, api_key: env.CLOUDINARY_API_KEY, api_secret: env.CLOUDINARY_API_SECRET });
  const folder = `${env.CLOUDINARY_FOLDER_UTILS || "utilitarios"}/principal`;
  const result = await cloudinary.search.expression(`folder:${folder}`).max_results(1).execute();
  return result?.resources?.[0]?.secure_url ?? null;
}

/** Fotos viejas del chat de soporte: ya no se suben a Cloudinary; las que
 *  quedaron allá se dejan (el panel solo limpia su registro). */
export async function deleteChatMedia(_publicId: string, _resourceType: string): Promise<void> {
  /* nada: Cloudinary retirado */
}
