import dotenv from "dotenv";
import path from "path";

const NODE_ENV = process.env.NODE_ENV || "development";

dotenv.config({
  path: path.resolve(process.cwd(), `.env.${NODE_ENV}`),
});

function getEnv(key: string, required = true): string {
  const value = process.env[key];
  if (!value && required) {
    throw new Error(`❌ Falta la variable de entorno: ${key}`);
  }
  return value as string;
}

export const env = {
  PORT: Number(process.env.PORT) || 4000,
  NODE_ENV,

  BOT_BASE_URL: getEnv("BOT_BASE_URL"),
  DASHBOARD_API_KEY: getEnv("DASHBOARD_API_KEY"),
  DASHBOARD_PASSWORD: getEnv("DASHBOARD_PASSWORD"),
  SESSION_SECRET: getEnv("SESSION_SECRET"),

  // Mismas credenciales que ya usa el bot — el panel sube ahí la imagen
  // principal del menú de WhatsApp (Configuración > Flujo).
  CLOUDINARY_CLOUD_NAME:   getEnv("CLOUDINARY_CLOUD_NAME", false),
  CLOUDINARY_API_KEY:      getEnv("CLOUDINARY_API_KEY", false),
  CLOUDINARY_API_SECRET:   getEnv("CLOUDINARY_API_SECRET", false),
  CLOUDINARY_FOLDER_UTILS: getEnv("CLOUDINARY_FOLDER_UTILS", false),
};
