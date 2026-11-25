import { Router } from "express";
import { getAdminSetting, setAdminSetting } from "../db/security.repository";

// ── PUBLICIDAD (Configuración › 📈 Publicidad) — solo admin ──
// Píxel de TikTok: el admin pega el ID que da TikTok Ads Manager y la
// tienda empieza a avisarle a TikTok qué pasa (visitas, producto visto,
// inicio de pago, compra, registro) para medir y optimizar los anuncios.
// El ID no es secreto (va en la página), pero solo el admin lo cambia.
const router = Router();
const KEY = "tiktok_pixel_id";

export function tiktokPixelId(): string | null {
  const v = (getAdminSetting(KEY) || "").trim();
  return v || null;
}

router.get("/tiktok-pixel", (_req, res) => {
  res.json({ pixelId: tiktokPixelId() });
});

router.post("/tiktok-pixel", (req, res) => {
  const raw = String(req.body?.pixelId ?? "").trim().toUpperCase();
  if (raw && !/^[A-Z0-9]{10,40}$/.test(raw)) {
    res.status(400).json({ message: "Ese ID no parece de TikTok: son solo letras y números (ej. C4ABC123DEF456GHI789)." });
    return;
  }
  setAdminSetting(KEY, raw);
  res.json({ pixelId: raw || null });
});

export default router;
