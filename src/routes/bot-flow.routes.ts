import { Router } from "express";
import multer from "multer";
import {
  getBotFlowConfig,
  updateBotFlowConfig,
  type BotFlowConfig,
} from "../db/bot-flow.repository";
import { replacePrincipalImage, getPrincipalImageUrl, isCloudinaryConfigured } from "../services/cloudinary.service";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

function parseBody(body: any): Omit<BotFlowConfig, "updatedAt"> {
  return {
    welcomeGreeting:       String(body?.welcomeGreeting ?? "").trim(),
    menuPrompt:            String(body?.menuPrompt ?? "").trim(),
    btnTermsTitle:         String(body?.btnTermsTitle ?? "").trim(),
    btnProductsTitle:      String(body?.btnProductsTitle ?? "").trim(),
    btnSupportTitle:       String(body?.btnSupportTitle ?? "").trim(),
    termsText:             String(body?.termsText ?? "").trim(),
    supportMessage:        String(body?.supportMessage ?? "").trim(),
    contactPhone:          String(body?.contactPhone ?? "").trim(),
    contactWaLink:         String(body?.contactWaLink ?? "").trim(),
    fallbackUnknownOption: String(body?.fallbackUnknownOption ?? "").trim(),
    fallbackUnknownType:   String(body?.fallbackUnknownType ?? "").trim(),
    backMainResponse:      String(body?.backMainResponse ?? "").trim(),
  };
}

router.get("/", (_req, res) => {
  res.json({ config: getBotFlowConfig() });
});

// WhatsApp rechaza el mensaje ENTERO del menú si un título de botón
// supera este largo — no es solo estético, un título muy largo aquí
// rompe el menú principal para todo el mundo (ya pasó una vez).
const BUTTON_TITLE_MAX = 20;
const BUTTON_TITLE_FIELDS: (keyof Omit<BotFlowConfig, "updatedAt">)[] = ["btnTermsTitle", "btnProductsTitle", "btnSupportTitle"];
const BUTTON_TITLE_LABELS: Record<string, string> = {
  btnTermsTitle:    "Título — Términos y Condiciones",
  btnProductsTitle: "Título — Productos",
  btnSupportTitle:  "Título — Soporte",
};

router.put("/", (req, res) => {
  const data = parseBody(req.body);
  const missing = Object.entries(data).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    res.status(400).json({ message: "Faltan campos: " + missing.join(", ") });
    return;
  }

  const tooLong = BUTTON_TITLE_FIELDS.filter(f => data[f].length > BUTTON_TITLE_MAX);
  if (tooLong.length > 0) {
    res.status(400).json({
      message: "WhatsApp no acepta títulos de botón de más de " + BUTTON_TITLE_MAX + " caracteres: " +
        tooLong.map(f => `"${BUTTON_TITLE_LABELS[f]}" (${data[f].length})`).join(", "),
    });
    return;
  }

  res.json({ config: updateBotFlowConfig(data) });
});

// ── Imagen principal del menú de WhatsApp ──
// El bot la toma directo de Cloudinary (no de esta tabla) — acá solo se
// sube/reemplaza, y se lee para mostrarla en el panel.

router.get("/principal-image", async (_req, res) => {
  try {
    const url = await getPrincipalImageUrl();
    res.json({ url, configured: isCloudinaryConfigured() });
  } catch (err: any) {
    res.status(502).json({ message: err?.message || "No se pudo consultar Cloudinary." });
  }
});

router.post("/principal-image", upload.single("image"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ message: "Falta la imagen." });
    return;
  }
  if (!req.file.mimetype.startsWith("image/")) {
    res.status(400).json({ message: "El archivo debe ser una imagen." });
    return;
  }
  try {
    const url = await replacePrincipalImage(req.file.buffer);
    res.json({ url });
  } catch (err: any) {
    res.status(502).json({ message: err?.message || "No se pudo subir la imagen." });
  }
});

export default router;
