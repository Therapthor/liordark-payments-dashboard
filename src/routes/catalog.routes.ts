import { Router } from "express";
import {
  listCatalogProducts,
  createCatalogProduct,
  updateCatalogProduct,
  deleteCatalogProduct,
  setCatalogProductActive,
  type CatalogProductInput,
} from "../db/catalog.repository";
import {
  listCombos,
  createCombo,
  updateCombo,
  deleteCombo,
  setComboActive,
  type ComboInput,
  type ComboItem,
} from "../db/combo.repository";
import multer from "multer";
import { generateCatalogPdf } from "../services/catalog-pdf.service";
import { saveProductImageSet, migrateExternalProductImages, isLocalMedia, mediaFilePath, MEDIA_PREFIX } from "../services/product-media.service";
import { emitDashboardEvent } from "../utils/live-events.util";

const router = Router();

// GET /api/catalog/pdf — catálogo actual en PDF, con el número de
// soporte en cada página y Yape al final. Para mandarle al cliente que
// escribe al WhatsApp de soporte mientras la web no está lista.
router.get("/pdf", async (_req, res) => {
  try {
    const pdf = await generateCatalogPdf();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="catalogo-manguitope.pdf"');
    res.send(pdf);
  } catch (err: any) {
    console.error("❌ Error generando PDF del catálogo:", err?.message);
    res.status(500).json({ message: "No se pudo generar el PDF." });
  }
});

// ── PRODUCTOS ──

function parseProductBody(body: any): CatalogProductInput {
  return {
    platform:    String(body?.platform ?? "").trim(),
    title:       String(body?.title ?? "").trim(),
    price:       String(body?.price ?? "0").trim(),
    wholesalePrice:     String(body?.wholesalePrice ?? "0").trim(),
    wholesaleFullPrice: String(body?.wholesaleFullPrice ?? "0").trim(),
    hasProfiles: !!body?.hasProfiles,
    description: String(body?.description ?? "").trim(),
    imageUrl:    String(body?.imageUrl ?? "").trim(),
    keywords:    String(body?.keywords ?? "").trim(),
  };
}

// Imagen de producto/combo: vacía, una nuestra (/media/products/…) o un
// enlace https (se pasa al servidor solo, en segundo plano).
function imageUrlError(url: string): string | null {
  if (!url) return null;
  if (isLocalMedia(url)) return mediaFilePath(url.slice(MEDIA_PREFIX.length)) ? null : "La imagen no es válida.";
  return /^https?:\/\/[^\s"'<>]+$/i.test(url) ? null : "La imagen tiene que ser un enlace https:// o subirse con «📷 Subir imagen».";
}
function localizeSoon(url: string): void {
  if (/^https?:\/\//i.test(url)) setImmediate(() => { migrateExternalProductImages().catch(() => {}); });
}

// POST /api/catalog/image — «📷 Subir imagen» del panel. El navegador ya la
// manda comprimida (el servidor no puede comprimir): main (720 px, WEBP o
// JPG), small (360 px) y jpg (para WhatsApp y el PDF).
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 3 } });
router.post("/image", (req, res) => {
  imageUpload.fields([{ name: "main", maxCount: 1 }, { name: "small", maxCount: 1 }, { name: "jpg", maxCount: 1 }])(req, res, (err: any) => {
    if (err) { res.status(400).json({ message: err.code === "LIMIT_FILE_SIZE" ? "La imagen pesa demasiado (máx. 4 MB)." : "No se pudo leer la imagen." }); return; }
    const files = (req as any).files as Record<string, { buffer: Buffer }[]> | undefined;
    const main = files?.main?.[0]?.buffer;
    if (!main) { res.status(400).json({ message: "Falta la imagen." }); return; }
    try {
      const url = saveProductImageSet(String(req.body?.label ?? "producto"), {
        main, small: files?.small?.[0]?.buffer ?? null, jpg: files?.jpg?.[0]?.buffer ?? null,
      });
      res.status(201).json({ url });
    } catch (e: any) {
      res.status(400).json({ message: e?.message || "No se pudo guardar la imagen." });
    }
  });
});

router.get("/products", (_req, res) => {
  res.json({ products: listCatalogProducts() });
});

router.post("/products", (req, res) => {
  const data = parseProductBody(req.body);
  if (!data.platform) { res.status(400).json({ message: "Falta el nombre de la plataforma." }); return; }
  const imgErr = imageUrlError(data.imageUrl);
  if (imgErr) { res.status(400).json({ message: imgErr }); return; }
  res.status(201).json({ product: createCatalogProduct(data) });
  localizeSoon(data.imageUrl);
});

router.put("/products/:id", (req, res) => {
  const id = Number(req.params.id);
  const data = parseProductBody(req.body);
  if (!data.platform) { res.status(400).json({ message: "Falta el nombre de la plataforma." }); return; }
  const imgErr = imageUrlError(data.imageUrl);
  if (imgErr) { res.status(400).json({ message: imgErr }); return; }

  const product = updateCatalogProduct(id, data);
  if (!product) { res.status(404).json({ message: "Producto no encontrado." }); return; }
  res.json({ product });
  localizeSoon(data.imageUrl);
});

router.patch("/products/:id/active", (req, res) => {
  const product = setCatalogProductActive(Number(req.params.id), !!req.body?.active);
  if (!product) { res.status(404).json({ message: "Producto no encontrado." }); return; }
  // Prender/apagar cambia la lista «Sin stock» del panel: que se refresque ya.
  emitDashboardEvent({ type: "stock_changed" });
  res.json({ product });
});

router.delete("/products/:id", (req, res) => {
  deleteCatalogProduct(Number(req.params.id));
  res.status(204).end();
});

// ── COMBOS ──

function parseComboItems(rawItems: any): ComboItem[] {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .map((it: any) => {
      const quantity = Number(it?.quantity);
      return {
        platform: String(it?.platform ?? "").trim(),
        quantity: Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity) : 1,
      };
    })
    .filter((it: ComboItem) => it.platform);
}

function parseComboBody(body: any): ComboInput {
  return {
    name:        String(body?.name ?? "").trim(),
    price:       String(body?.price ?? "0").trim(),
    description: String(body?.description ?? "").trim(),
    imageUrl:    String(body?.imageUrl ?? "").trim(),
    items:       parseComboItems(body?.items),
  };
}

router.get("/combos", (_req, res) => {
  res.json({ combos: listCombos() });
});

router.post("/combos", (req, res) => {
  const data = parseComboBody(req.body);
  if (!data.name)          { res.status(400).json({ message: "Falta el nombre del combo." }); return; }
  if (data.items.length < 2) { res.status(400).json({ message: "Un combo necesita al menos 2 plataformas." }); return; }
  const imgErr = imageUrlError(data.imageUrl);
  if (imgErr) { res.status(400).json({ message: imgErr }); return; }
  res.status(201).json({ combo: createCombo(data) });
  localizeSoon(data.imageUrl);
});

router.put("/combos/:id", (req, res) => {
  const id = Number(req.params.id);
  const data = parseComboBody(req.body);
  if (!data.name)          { res.status(400).json({ message: "Falta el nombre del combo." }); return; }
  if (data.items.length < 2) { res.status(400).json({ message: "Un combo necesita al menos 2 plataformas." }); return; }
  const imgErr = imageUrlError(data.imageUrl);
  if (imgErr) { res.status(400).json({ message: imgErr }); return; }

  const combo = updateCombo(id, data);
  if (!combo) { res.status(404).json({ message: "Combo no encontrado." }); return; }
  res.json({ combo });
  localizeSoon(data.imageUrl);
});

router.patch("/combos/:id/active", (req, res) => {
  const combo = setComboActive(Number(req.params.id), !!req.body?.active);
  if (!combo) { res.status(404).json({ message: "Combo no encontrado." }); return; }
  res.json({ combo });
});

router.delete("/combos/:id", (req, res) => {
  deleteCombo(Number(req.params.id));
  res.status(204).end();
});

export default router;
