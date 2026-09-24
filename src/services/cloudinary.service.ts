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
