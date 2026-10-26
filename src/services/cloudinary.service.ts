import { v2 as cloudinary } from "cloudinary";
import { env } from "../config/env";

// Misma cuenta de Cloudinary que ya usa el bot — acá solo se sube la
// imagen principal del menú de WhatsApp (bot.getPrincipalImageUrl()
// busca la más reciente en esta carpeta).

export function isCloudinaryConfigured(): boolean {
  return !!(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}

/** Ping real a la cuenta de Cloudinary — para el panel de "Estado de conectores". */
export async function checkCloudinaryStatus(): Promise<"ok" | "error" | "not_configured"> {
  if (!isCloudinaryConfigured()) return "not_configured";
  ensureConfigured();
  try {
    await cloudinary.api.ping();
    return "ok";
  } catch {
    return "error";
  }
}

function principalFolder(): string {
  return `${env.CLOUDINARY_FOLDER_UTILS || "utilitarios"}/principal`;
}

let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key:    env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
  });
  configured = true;
}

/**
 * Reemplaza la imagen principal — borra lo que había en la carpeta antes
 * de subir la nueva, para que siempre quede una sola (el bot toma "la que
 * encuentre" en esa carpeta, sin ordenar, así que dos imágenes ahí sería
 * ambiguo).
 */
export async function replacePrincipalImage(fileBuffer: Buffer): Promise<string> {
  if (!isCloudinaryConfigured()) {
    throw new Error("Cloudinary no está configurado en el panel (faltan variables de entorno).");
  }
  ensureConfigured();

  const folder = principalFolder();

  try {
    await cloudinary.api.delete_resources_by_prefix(folder);
  } catch {
    // Carpeta vacía o no existía todavía — no es un error real.
  }

  const uploaded = await new Promise<{ secure_url: string }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image" },
      (err, result) => {
        if (err || !result) reject(err ?? new Error("Cloudinary no devolvió resultado"));
        else resolve(result);
      }
    );
    stream.end(fileBuffer);
  });

  return uploaded.secure_url;
}

export async function getPrincipalImageUrl(): Promise<string | null> {
  if (!isCloudinaryConfigured()) return null;
  ensureConfigured();
  const result = await cloudinary.search.expression(`folder:${principalFolder()}`).max_results(1).execute();
  return result?.resources?.[0]?.secure_url ?? null;
}

// ─────────────────────────────────────────────────────────────
// CHAT DE SOPORTE — fotos/videos que el cliente o el admin mandan en la
// conversación. A diferencia de la imagen principal (una sola, se
// reemplaza), acá cada archivo es su propio recurso — se borra solo
// (expiry-chat-media.job.ts, 1 día) o todos juntos al cerrar el chat
// (support-chat.repository.ts closeChat).
// ─────────────────────────────────────────────────────────────

function chatMediaFolder(): string {
  return `${env.CLOUDINARY_FOLDER_UTILS || "utilitarios"}/soporte-chat`;
}

export async function uploadChatMedia(
  fileBuffer: Buffer, resourceType: "image" | "video"
): Promise<{ url: string; publicId: string }> {
  if (!isCloudinaryConfigured()) {
    throw new Error("Cloudinary no está configurado en el panel (faltan variables de entorno).");
  }
  ensureConfigured();

  const uploaded = await new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: chatMediaFolder(), resource_type: resourceType },
      (err, result) => {
        if (err || !result) reject(err ?? new Error("Cloudinary no devolvió resultado"));
        else resolve(result);
      }
    );
    stream.end(fileBuffer);
  });

  return { url: uploaded.secure_url, publicId: uploaded.public_id };
}

export async function deleteChatMedia(publicId: string, resourceType: string): Promise<void> {
  if (!publicId || !isCloudinaryConfigured()) return;
  ensureConfigured();
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType || "image" });
  } catch (err: any) {
    console.error("⚠️ No se pudo borrar media del chat en Cloudinary:", publicId, err?.message);
  }
}
