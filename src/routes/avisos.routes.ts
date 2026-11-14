import { Router, type Request, type Response } from "express";
import multer from "multer";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getAviso, saveAviso, type Aviso, type AvisoButtonType, type AvisoTarget } from "../db/avisos.repository";
import { listCatalogProducts } from "../db/catalog.repository";
import { isCloudinaryConfigured, uploadAvisoImage, deleteAvisoImage } from "../services/cloudinary.service";

// ─────────────────────────────────────────────────────────────
// AVISOS — ventana con imagen al entrar a la tienda o al panel de
// mayoristas. El admin la arma en Configuración › Avisos.
//   · /api/avisos            (panel, con sesión de admin)
//   · /api/store/aviso       (tienda, público)
//   · /api/wholesaler/aviso  (mayorista, con su sesión)
//   · /api/aviso-img/<file>  (imagen guardada en data/ si no hay Cloudinary)
// ─────────────────────────────────────────────────────────────

const MAX_MB = 5;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 } });
const MEDIA_DIR = path.resolve(process.cwd(), "data/avisos-media");
const LOCAL_PREFIX = "/api/aviso-img/";
const LOCAL_FILE_RE = /^(store|wholesale)-[a-f0-9]{16}\.(jpg|png|webp)$/;
const BUTTON_TYPES: AvisoButtonType[] = ["none", "product", "combo", "link"];
export const DEFAULT_BUTTON_TEXT = "Ver promoción";

function parseTarget(v: unknown): AvisoTarget | null {
  return v === "store" || v === "wholesale" ? v : null;
}

/** Hoy en Lima (YYYY-MM-DD) — la fecha de fin se cuenta con la hora de Perú. */
function todayLima(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
}

function isEnded(a: Aviso): boolean {
  return !!a.endsOn && a.endsOn < todayLima();
}

/** Tipo y tamaño reales de la imagen, leídos de sus primeros bytes (no del nombre). */
function sniffImage(buf: Buffer): { ext: "jpg" | "png" | "webp"; w: number; h: number } | null {
  try {
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { ext: "png", w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1]!;
        if (m === 0xff) { i++; continue; }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { ext: "jpg", h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return null;
    }
    if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      const chunk = buf.toString("ascii", 12, 16);
      if (chunk === "VP8 ") return { ext: "webp", w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L") {
        const b0 = buf[21]!, b1 = buf[22]!, b2 = buf[23]!, b3 = buf[24]!;
        return { ext: "webp", w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
      }
      if (chunk === "VP8X") return { ext: "webp", w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    }
  } catch { /* archivo cortado o raro */ }
  return null;
}

async function storeImage(target: AvisoTarget, buf: Buffer, ext: string): Promise<{ url: string; publicId: string }> {
  if (isCloudinaryConfigured()) {
    try {
      return await uploadAvisoImage(buf);
    } catch (err: any) {
      console.error("⚠️ Aviso: no se pudo subir a Cloudinary, se guarda en el servidor:", err?.message);
    }
  }
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const name = `${target}-${crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16)}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
  return { url: LOCAL_PREFIX + name, publicId: "" };
}

function removeOldImage(prev: Aviso, next: Aviso): void {
  if (!prev.imageUrl || prev.imageUrl === next.imageUrl) return;
  if (prev.imagePublicId) { void deleteAvisoImage(prev.imagePublicId); return; }
  if (prev.imageUrl.startsWith(LOCAL_PREFIX)) {
    const name = prev.imageUrl.slice(LOCAL_PREFIX.length);
    if (LOCAL_FILE_RE.test(name)) fs.promises.unlink(path.join(MEDIA_DIR, name)).catch(() => {});
  }
}

function validHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch { return false; }
}

function validDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T12:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function adminView(a: Aviso) {
  const { imagePublicId: _omit, ...rest } = a;
  return { ...rest, ended: isEnded(a) };
}

// ─── Lo que ven los clientes / mayoristas (solo lo necesario) ───

export type PublicAviso = {
  rev: string;
  imageUrl: string;
  imageW: number;
  imageH: number;
  title: string;
  frequency: "once" | "daily";
  button: null | { type: "product"; text: string; platform: string; title: string }
               | { type: "combo"; text: string }
               | { type: "link"; text: string; url: string };
};

export function publicAviso(target: AvisoTarget): PublicAviso | null {
  const a = getAviso(target);
  if (!a.active || !a.imageUrl || !a.rev || isEnded(a)) return null;
  const text = a.buttonText || DEFAULT_BUTTON_TEXT;
  let button: PublicAviso["button"] = null;
  if (a.buttonType === "product" && a.productId) {
    // Si el producto se apagó o se borró, el aviso sale igual pero sin botón.
    const p = listCatalogProducts(true).find(x => x.id === a.productId);
    if (p) button = { type: "product", text, platform: p.platform, title: p.title || p.platform };
  } else if (a.buttonType === "combo" && target === "store") {
    button = { type: "combo", text };
  } else if (a.buttonType === "link" && validHttpUrl(a.linkUrl)) {
    button = { type: "link", text, url: a.linkUrl };
  }
  return { rev: a.rev, imageUrl: a.imageUrl, imageW: a.imageW, imageH: a.imageH, title: a.title, frequency: a.frequency, button };
}

export function storeAvisoHandler(_req: Request, res: Response): void {
  res.json({ aviso: publicAviso("store") });
}

export function wholesaleAvisoHandler(_req: Request, res: Response): void {
  res.json({ aviso: publicAviso("wholesale") });
}

/** Imagen guardada en data/avisos-media (cuando no hay Cloudinary). El nombre lleva su huella: se cachea 1 año. */
export function avisoImageHandler(req: Request, res: Response): void {
  const name = String(req.params.file ?? "");
  const file = path.join(MEDIA_DIR, name);
  if (!LOCAL_FILE_RE.test(name) || !fs.existsSync(file)) {
    res.status(404).json({ message: "No encontrado" });
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(file);
}

// ─── Panel admin ───

const router = Router();

router.get("/", (_req, res) => {
  const products = listCatalogProducts(true).map(p => ({ id: p.id, platform: p.platform, title: p.title || p.platform }));
  res.json({
    avisos: { store: adminView(getAviso("store")), wholesale: adminView(getAviso("wholesale")) },
    products,
    today: todayLima(),
    maxMb: MAX_MB,
    defaultButtonText: DEFAULT_BUTTON_TEXT,
  });
});

router.put("/:target", (req, res) => {
  const target = parseTarget(req.params.target);
  if (!target) { res.status(404).json({ message: "No encontrado" }); return; }

  upload.single("image")(req, res, async (upErr: any) => {
    if (upErr) {
      const msg = upErr?.code === "LIMIT_FILE_SIZE"
        ? `La imagen pesa más de ${MAX_MB} MB. Guárdala más liviana (por ejemplo en JPG) y vuelve a subirla.`
        : "No se pudo leer la imagen. Prueba con otra.";
      res.status(400).json({ message: msg });
      return;
    }
    const b = req.body ?? {};
    const fail = (message: string) => { res.status(400).json({ message }); };

    const prev = getAviso(target);
    const title = String(b.title ?? "").replace(/\s+/g, " ").trim();
    if (title.length > 140) return fail("El texto es muy largo (máximo 140 letras).");

    const buttonType = String(b.buttonType ?? "none") as AvisoButtonType;
    if (!BUTTON_TYPES.includes(buttonType)) return fail("Elige qué hace el botón.");
    if (buttonType === "combo" && target !== "store") return fail("«Abrir Arma tu combo» solo existe en la tienda.");

    let productId: number | null = null;
    if (buttonType === "product") {
      productId = Number(b.productId);
      if (!listCatalogProducts(true).some(p => p.id === productId)) return fail("Elige el producto al que lleva el botón.");
    }
    let linkUrl = "";
    if (buttonType === "link") {
      linkUrl = String(b.linkUrl ?? "").trim();
      if (!validHttpUrl(linkUrl) || linkUrl.length > 500) return fail("El link debe empezar con https:// (o http://).");
    }
    const buttonText = buttonType === "none" ? "" : String(b.buttonText ?? "").replace(/\s+/g, " ").trim();
    if (buttonText.length > 30) return fail("El texto del botón es muy largo (máximo 30 letras).");

    const frequency = b.frequency === "daily" ? "daily" : "once";
    const endsOn = String(b.endsOn ?? "").trim();
    if (endsOn && !validDate(endsOn)) return fail("La fecha de fin no es válida.");
    const active = b.active === "1" || b.active === "true";
    if (active && !req.file && !prev.imageUrl) return fail("Sube una imagen antes de activar el aviso.");
    if (active && endsOn && endsOn < todayLima()) return fail("La fecha de fin ya pasó: elige otra o déjala vacía.");

    let image: { url: string; publicId: string; w: number; h: number } | null = null;
    if (req.file) {
      const info = sniffImage(req.file.buffer);
      if (!info || !info.w || !info.h) return fail("La imagen debe ser JPG, PNG o WEBP.");
      if (info.w < 200 || info.h < 200) return fail("La imagen es muy chica (mínimo 200 × 200 píxeles).");
      try {
        const saved = await storeImage(target, req.file.buffer, info.ext);
        image = { ...saved, w: info.w, h: info.h };
      } catch (err: any) {
        console.error("❌ Aviso: no se pudo guardar la imagen:", err?.message);
        res.status(500).json({ message: "No se pudo guardar la imagen. Intenta de nuevo." });
        return;
      }
    }

    const next: Aviso = {
      ...prev,
      active, title, buttonType, productId, linkUrl, buttonText, frequency, endsOn,
      ...(image ? { imageUrl: image.url, imagePublicId: image.publicId, imageW: image.w, imageH: image.h } : {}),
    };

    // Cambió lo que se ve → cuenta como aviso nuevo (se vuelve a mostrar a todos).
    const contentChanged = !prev.rev || next.imageUrl !== prev.imageUrl || next.title !== prev.title
      || next.buttonType !== prev.buttonType || next.productId !== prev.productId
      || next.linkUrl !== prev.linkUrl || next.buttonText !== prev.buttonText;
    if (contentChanged) next.rev = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");

    const saved = saveAviso(next);
    removeOldImage(prev, saved);
    res.json({ aviso: adminView(saved), isNew: contentChanged });
  });
});

export default router;
