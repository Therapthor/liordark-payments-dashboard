import { Router } from "express";
import { publicStoreInfo } from "../services/manguito.service";
import { shareView, unlockShare, SHARE_TOKEN_RE } from "../services/manguito-share.service";

// ─────────────────────────────────────────────────────────────
// /api/store/ai-public — Manguito Pro SIN sesión: planes a la venta (para
// la tienda y la página de planes) y los links compartidos
// (liordark.com/manguito/s/<token>): cualquiera puede leerlos; los que
// tienen contraseña piden la contraseña primero.
// ─────────────────────────────────────────────────────────────

const router = Router();

router.get("/info", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(publicStoreInfo());
});

router.get("/share/:token", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  const v = shareView(String(req.params.token), true);
  if (!v) { res.status(404).json({ message: "Este link ya no existe o lo borraron." }); return; }
  res.json(v);
});

// Contraseña: máximo 8 intentos por link y por conexión cada 15 minutos.
const attempts = new Map<string, number[]>();
router.post("/share/:token/unlock", (req, res) => {
  const token = String(req.params.token);
  res.setHeader("Cache-Control", "no-store");
  if (!SHARE_TOKEN_RE.test(token)) { res.status(404).json({ message: "Este link ya no existe." }); return; }
  const key = token + "|" + (req.ip || "");
  const now = Date.now();
  const list = (attempts.get(key) || []).filter(t => now - t < 15 * 60e3);
  if (list.length >= 8) { res.status(429).json({ message: "Demasiados intentos. Espera unos minutos." }); return; }
  const r = unlockShare(token, String(req.body?.password ?? ""));
  if (!r) { res.status(404).json({ message: "Este link ya no existe o lo borraron." }); return; }
  if (!r.ok) {
    list.push(now); attempts.set(key, list);
    if (attempts.size > 5000) attempts.clear();
    res.status(403).json({ message: "Contraseña incorrecta." });
    return;
  }
  attempts.delete(key);
  res.json(r);
});

export default router;
