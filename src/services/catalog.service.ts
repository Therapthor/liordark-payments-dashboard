import axios from "axios";
import { env } from "../config/env";

// ─────────────────────────────────────────────────────────────
// CATÁLOGO DE PLATAFORMAS — proxy cacheado a GET /api/dashboard/platforms
// del bot, para el desplegable de "agregar cuentas" en Accesos.
// Cache corta en memoria: evita pegarle a Sheets (vía el bot) en
// cada apertura del modal.
// ─────────────────────────────────────────────────────────────

export type CatalogPlatform = { platform: string; hasProfiles: boolean };

const CACHE_TTL_MS = 10 * 60 * 1000;

let cached: CatalogPlatform[] | null = null;
let cachedAt = 0;

export async function getPlatformCatalog(): Promise<CatalogPlatform[]> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;

  const res = await axios.get(env.BOT_BASE_URL + "/api/dashboard/platforms", {
    headers: { "x-dashboard-key": env.DASHBOARD_API_KEY },
    timeout: 15_000,
  });

  cached = (res.data?.platforms ?? []) as CatalogPlatform[];
  cachedAt = Date.now();
  return cached;
}

/** hasProfiles de una plataforma del catálogo. true por defecto si no se encuentra. */
export async function hasProfilesFor(platform: string): Promise<boolean> {
  try {
    const list = await getPlatformCatalog();
    const found = list.find(p => p.platform.trim().toUpperCase() === platform.trim().toUpperCase());
    return found ? found.hasProfiles : true;
  } catch (err: any) {
    console.error("⚠️ No se pudo consultar el catálogo del bot, se asume hasProfiles=true:", err?.message);
    return true;
  }
}
