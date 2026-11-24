import { Router } from "express";
import multer from "multer";
import {
  getBotFlowConfig,
  updateBotFlowConfig,
  type BotFlowConfig,
} from "../db/bot-flow.repository";
import { getBotImages, saveBotImage, BOT_IMAGE_KINDS, type BotImageKind } from "../services/product-media.service";

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

// ── Imágenes del bot de WhatsApp (saludo y aviso de vencimiento) ──
// Guardadas en el servidor (antes en Cloudinary). El panel las manda ya
// comprimidas en JPG; el bot las pide en /api/stock/bot-images.

router.get("/bot-images", (_req, res) => {
  res.json({ images: getBotImages() });
});

// Compatibilidad: la imagen del saludo.
router.get("/principal-image", (_req, res) => {
  res.json({ url: getBotImages().principal, configured: true });
});

function saveBotImageHandler(kind: BotImageKind) {
  return (req: any, res: any) => {
    if (!req.file) { res.status(400).json({ message: "Falta la imagen." }); return; }
    try {
      res.json({ url: saveBotImage(kind, req.file.buffer), images: getBotImages() });
    } catch (err: any) {
      res.status(400).json({ message: err?.message || "No se pudo guardar la imagen." });
    }
  };
}

router.post("/bot-images/:kind", upload.single("image"), (req, res) => {
  const kind = String(req.params.kind) as BotImageKind;
  if (!BOT_IMAGE_KINDS.includes(kind)) { res.status(404).json({ message: "No encontrado." }); return; }
  saveBotImageHandler(kind)(req, res);
});
router.post("/principal-image", upload.single("image"), saveBotImageHandler("principal"));

export default router;
