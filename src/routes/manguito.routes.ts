import fs from "fs";
import path from "path";
import { Router } from "express";
import multer from "multer";
import { type RequestWithCustomer } from "../services/customer-auth.service";
import { findCustomerById } from "../db/customer.repository";
import {
  addMessage, createConversation, deleteConversation, deleteUploadRows, getConversation, getUpload,
  listConversations, listMessages, saveUpload, touchConversation, deleteAllConversations, deleteAllShares,
  recentUploadBytes, type AiFile, type UploadKind,
} from "../db/manguito.repository";
import {
  TIERS, UPLOAD_DIR, chatGate, isAiConfigured, newUploadId, runChat, uploadPath,
  getMemory, clearMemory, customerMeter, hasAiAccess, publicStoreInfo, startAiPurchase, aiPurchaseStatus, lapsedInfo,
  type ChatEvent, type Tier,
} from "../services/manguito.service";
import { createShareFor, mySharesView, removeShare, continueShare, SHARE_TOKEN_RE } from "../services/manguito-share.service";

// ─────────────────────────────────────────────────────────────
// /api/store/ai — Manguito Pro para el cliente (va DESPUÉS de
// requireCustomerSession en store.routes). Entran los celulares de la lista
// del panel (gratis) y quien compró un plan o créditos; el resto ve los
// planes y puede comprar.
// ─────────────────────────────────────────────────────────────

const router = Router();
const MB = 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * MB, files: 1, fields: 8 } });
const MAX_TEXT = 20_000;
const MAX_IMAGES = 4;
const MAX_DOCS = 3;
const MAX_FRAMES = 8;
const MAX_PDF_BYTES_PER_MESSAGE = 15 * MB;
const VIDEO_MAX_BYTES = 15 * MB;       // el video nunca se sube: el navegador saca cuadros
const MAX_TEXT_DOC_CHARS = 200_000;   // ~50 mil tokens
// Tope por kind (el navegador ya comprime imágenes y cuadros).
const UPLOAD_LIMIT: Record<UploadKind, number> = { image: 4 * MB, frame: 1.5 * MB, pdf: 10 * MB, text: 900 * 1024 };
// Nadie llena el disco: como mucho 80 archivos o 120 MB por hora.
const HOURLY_UPLOADS = 80;
const HOURLY_BYTES = 120 * MB;

/** Nombre de archivo seguro para mostrar (sin rutas ni caracteres raros). */
function cleanName(v: unknown): string {
  return String(v ?? "").replace(/[\u0000-\u001f\u007f<>"\\/:*?|]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function customerOf(req: unknown) {
  return findCustomerById((req as RequestWithCustomer).customerId);
}

router.get("/access", (req, res) => {
  const c = customerOf(req);
  res.setHeader("Cache-Control", "no-store");
  const allowed = !!c && hasAiAccess(c);
  res.json({
    allowed, configured: isAiConfigured(), store: publicStoreInfo(c?.phone), meter: allowed ? customerMeter(c!.id) : null,
    lapsed: !allowed && c ? lapsedInfo(c.id) : null,
  });
});

// Comprar plan mensual o créditos (cualquier cliente con sesión).
router.post("/buy", async (req, res) => {
  const c = customerOf(req);
  if (!c) { res.status(401).json({ message: "Inicia sesión." }); return; }
  const kind = req.body?.kind === "plan" ? "plan" : "credits";
  const r = await startAiPurchase(c, kind, Number(req.body?.pack) || 0);
  if (!r.ok) { res.status(r.status).json({ message: r.message }); return; }
  res.json({ orderName: r.orderName, amount: r.amount });
});

router.get("/buy/:orderName", (req, res) => {
  const c = customerOf(req);
  const st = c ? aiPurchaseStatus(c.id, String(req.params.orderName)) : { found: false, paid: false };
  res.setHeader("Cache-Control", "no-store");
  if (!st.found) { res.status(404).json({ message: "Pedido no encontrado." }); return; }
  res.json({ paid: st.paid });
});

// Todo lo demás: solo quien tiene acceso.
router.use((req, res, next) => {
  const c = customerOf(req);
  if (!c || !hasAiAccess(c)) { res.status(403).json({ code: "no_access", message: "Elige un plan para usar Manguito Pro 🥭" }); return; }
  next();
});

router.get("/meter", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(customerMeter(customerOf(req)!.id));
});

const imageUrl = (id: string) => "/api/store/ai/uploads/" + id;

router.get("/conversations", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ conversations: listConversations(customerOf(req)!.id) });
});

// Memoria («cerebro»): el cliente puede ver qué recuerda Manguito y borrarlo.
router.get("/memory", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ memory: getMemory(customerOf(req)!.id) });
});
router.delete("/memory", (req, res) => {
  clearMemory(customerOf(req)!.id);
  res.json({ ok: true });
});

router.get("/conversations/:id", (req, res) => {
  const conv = getConversation(customerOf(req)!.id, Number(req.params.id));
  if (!conv) { res.status(404).json({ message: "Conversación no encontrada." }); return; }
  res.setHeader("Cache-Control", "no-store");
  res.json({
    conversation: { id: conv.id, title: conv.title, summary: conv.summary, compacted: conv.compacted },
    messages: listMessages(conv.id).map(m => ({
      id: m.id, role: m.role, text: m.text, images: m.images.map(imageUrl), status: m.status,
      files: m.files.map(f => f.kind === "video"
        ? { kind: "video", name: f.name, bytes: f.bytes, duration: f.duration, thumb: f.frames[0] && getUpload(f.frames[0]) ? imageUrl(f.frames[0]) : null }
        : { kind: f.kind, name: f.name, bytes: f.bytes, available: !!getUpload(f.id) }),
      label: (TIERS as Record<string, { label: string }>)[m.tier]?.label || "",
    })),
  });
});

// Borrar todo el historial de golpe (y, si lo pide, la memoria y sus links).
router.delete("/conversations", (req, res) => {
  const customerId = customerOf(req)!.id;
  const images = deleteAllConversations(customerId);
  for (const id of images) {
    const up = getUpload(id);
    if (up) fs.promises.unlink(uploadPath(id, up.mediaType)).catch(() => {});
  }
  deleteUploadRows(images);
  if (req.body?.memory) clearMemory(customerId);
  const shares = req.body?.shares ? deleteAllShares(customerId) : 0;
  res.json({ ok: true, shares });
});

// ── Compartir ──
router.get("/shares", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ shares: mySharesView(customerOf(req)!.id) });
});
router.post("/shares", (req, res) => {
  const r = createShareFor(customerOf(req)!.id, req.body);
  if (!r.ok) { res.status(400).json({ message: r.message }); return; }
  res.status(201).json({ token: r.token, url: "/manguito/s/" + r.token });
});
router.delete("/shares/:token", (req, res) => {
  if (!removeShare(customerOf(req)!.id, String(req.params.token))) { res.status(404).json({ message: "Ese link ya no existe." }); return; }
  res.json({ ok: true });
});
router.post("/shares/:token/continue", (req, res) => {
  const token = String(req.params.token);
  if (!SHARE_TOKEN_RE.test(token)) { res.status(404).json({ message: "Este link ya no existe." }); return; }
  const r = continueShare(customerOf(req)!.id, token, String(req.body?.password ?? ""));
  if (!r.ok) { res.status(r.status).json({ message: r.message }); return; }
  res.json({ conversationId: r.conversationId });
});

router.delete("/conversations/:id", (req, res) => {
  const images = deleteConversation(customerOf(req)!.id, Number(req.params.id));
  if (!images) { res.status(404).json({ message: "Conversación no encontrada." }); return; }
  for (const id of images) {
    const up = getUpload(id);
    if (up) fs.promises.unlink(uploadPath(id, up.mediaType)).catch(() => {});
  }
  deleteUploadRows(images);
  res.json({ ok: true });
});

function sniffImage(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("ascii"))) return "image/gif";
  return null;
}

// POST /api/store/ai/upload — multipart: file (o image, el de antes) + kind:
//   image  foto (JPG/PNG/WEBP/GIF, 4 MB)
//   frame  cuadro de un video (el navegador saca hasta 8; el video no se sube)
//   pdf    documento PDF (10 MB, hasta 100 páginas)
//   text   texto de un documento (txt, csv, código… o lo que el navegador
//          sacó de un Word/Excel/PowerPoint), en UTF-8
// El servidor web deja pasar ~1 MB por pedido: lo más grande llega en
// partes (total, part, id) y aquí se junta; se valida al final.
type PartialUpload = { customerId: number; kind: UploadKind; name: string; total: number; next: number; bytes: number; expires: number; tmp: string };
const partialUploads = new Map<string, PartialUpload>();
const MAX_PARTS = 12;
function dropPartial(id: string): void {
  const p = partialUploads.get(id);
  if (p) fs.promises.unlink(p.tmp).catch(() => {});
  partialUploads.delete(id);
}
setInterval(() => { const now = Date.now(); for (const [id, p] of partialUploads) if (p.expires < now) dropPartial(id); }, 5 * 60e3).unref();

/** Revisa el archivo completo: devuelve su tipo o un error para el cliente. */
function checkUpload(kind: UploadKind, buf: Buffer): { mediaType: string } | { error: string } {
  if (kind === "image" || kind === "frame") {
    const mediaType = sniffImage(buf);
    if (!mediaType || (kind === "frame" && mediaType === "image/gif")) return { error: "Solo imágenes JPG, PNG, WEBP o GIF." };
    return { mediaType };
  }
  if (kind === "pdf") {
    if (buf.subarray(0, 1024).indexOf("%PDF-") < 0) return { error: "Ese archivo no es un PDF válido." };
    const pages = (buf.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;
    if (pages > 100) return { error: "El PDF tiene más de 100 páginas. Envía solo la parte que necesitas." };
    return { mediaType: "application/pdf" };
  }
  if (buf.includes(0)) return { error: "Ese archivo no parece de texto." };
  const text = buf.toString("utf8");
  if (text.length > MAX_TEXT_DOC_CHARS) return { error: "El documento es muy largo (máx. 200 000 letras). Envía solo una parte." };
  if (!text.trim()) return { error: "El documento está vacío." };
  return { mediaType: "text/plain" };
}

router.post("/upload", (req, res) => {
  upload.fields([{ name: "file", maxCount: 1 }, { name: "image", maxCount: 1 }])(req, res, (err: unknown) => {
    if (err) { res.status(413).json({ message: "El archivo pesa demasiado." }); return; }
    const files = (req as any).files as Record<string, { buffer: Buffer; originalname?: string }[]> | undefined;
    const file = files?.file?.[0] || files?.image?.[0];
    if (!file) { res.status(400).json({ message: "Falta el archivo." }); return; }
    const body = (req as any).body || {};
    const customerId = customerOf(req)!.id;
    const part = Math.max(0, Math.floor(Number(body.part) || 0));
    let id: string;
    let p: PartialUpload;
    if (part === 0) {
      const kindRaw = String(body.kind || "image");
      const kind: UploadKind = (["image", "frame", "pdf", "text"] as const).find(k => k === kindRaw) || "image";
      const total = Math.min(MAX_PARTS, Math.max(1, Math.floor(Number(body.total) || 1)));
      const recent = recentUploadBytes(customerId);
      if (recent.count >= HOURLY_UPLOADS || recent.bytes > HOURLY_BYTES) {
        res.status(429).json({ message: "Subiste muchos archivos en poco tiempo. Espera un rato y vuelve a intentar." }); return;
      }
      // Subidas a medias: como mucho 6 a la vez por cliente.
      if ([...partialUploads.values()].filter(x => x.customerId === customerId).length >= 6) {
        res.status(429).json({ message: "Espera a que terminen de subir los archivos anteriores." }); return;
      }
      id = newUploadId();
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      p = { customerId, kind, name: cleanName(body.name || file.originalname || ""), total, next: 0, bytes: 0, expires: Date.now() + 10 * 60e3, tmp: path.join(UPLOAD_DIR, id + ".part") };
      partialUploads.set(id, p);
      fs.writeFileSync(p.tmp, "");
    } else {
      id = String(body.id || "");
      const found = /^[a-f0-9]{24}$/.test(id) ? partialUploads.get(id) : undefined;
      if (!found || found.customerId !== customerId || found.next !== part) { res.status(400).json({ message: "Se cortó la subida. Vuelve a adjuntar el archivo." }); return; }
      p = found;
    }
    p.bytes += file.buffer.length;
    if (p.bytes > UPLOAD_LIMIT[p.kind]) {
      dropPartial(id);
      const max = p.kind === "text" ? "el texto es muy largo" : `máx. ${Math.round(UPLOAD_LIMIT[p.kind] / MB)} MB`;
      res.status(413).json({ message: `El archivo pesa demasiado (${max}).` }); return;
    }
    fs.appendFileSync(p.tmp, file.buffer);
    p.next++;
    p.expires = Date.now() + 10 * 60e3;
    if (p.next < p.total) { res.json({ id, next: p.next }); return; }

    // Completo: se valida y queda guardado.
    const buf = fs.readFileSync(p.tmp);
    const check = checkUpload(p.kind, buf);
    if ("error" in check) { dropPartial(id); res.status(400).json({ message: check.error }); return; }
    fs.renameSync(p.tmp, uploadPath(id, check.mediaType));
    partialUploads.delete(id);
    saveUpload(id, customerId, check.mediaType, buf.length, p.kind, p.name);
    res.status(201).json({ id, kind: p.kind, name: p.name, bytes: buf.length, ...(p.kind === "image" || p.kind === "frame" ? { url: imageUrl(id) } : {}) });
  });
});

// Solo se devuelven imágenes y cuadros (vista previa); los documentos no salen del servidor.
router.get("/uploads/:id", (req, res) => {
  const id = String(req.params.id);
  const up = /^[a-f0-9]{24}$/.test(id) ? getUpload(id) : null;
  if (!up || up.customerId !== customerOf(req)!.id || (up.kind !== "image" && up.kind !== "frame")) { res.status(404).end(); return; }
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(uploadPath(id, up.mediaType), (e: any) => { if (e && !res.headersSent) res.status(404).end(); });
});

// POST /api/store/ai/chat — { conversationId?, text, images: [ids], docs: [ids],
//   video: { name, bytes, duration, frames: [ids] } }.
// Responde en líneas JSON (una por evento) a medida que escribe.
router.post("/chat", async (req, res) => {
  const customer = customerOf(req)!;
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const images: string[] = Array.isArray(req.body?.images) ? req.body.images.map(String).slice(0, MAX_IMAGES + 1) : [];
  if (text.length > MAX_TEXT) { res.status(400).json({ message: "El mensaje es muy largo (máx. 20 000 caracteres)." }); return; }
  if (images.length > MAX_IMAGES) { res.status(400).json({ message: `Máximo ${MAX_IMAGES} imágenes por mensaje.` }); return; }
  const own = (id: string, kinds: UploadKind[]) => {
    const up = /^[a-f0-9]{24}$/.test(id) ? getUpload(id) : null;
    return up && up.customerId === customer.id && kinds.includes(up.kind) ? up : null;
  };
  for (const id of images) {
    if (!own(id, ["image"])) { res.status(400).json({ message: "Una de las imágenes ya no está disponible." }); return; }
  }
  const files: AiFile[] = [];
  const docIds: string[] = Array.isArray(req.body?.docs) ? req.body.docs.map(String).slice(0, MAX_DOCS + 1) : [];
  if (docIds.length > MAX_DOCS) { res.status(400).json({ message: `Máximo ${MAX_DOCS} documentos por mensaje.` }); return; }
  let pdfBytes = 0;
  for (const id of docIds) {
    const up = own(id, ["pdf", "text"]);
    if (!up) { res.status(400).json({ message: "Uno de los documentos ya no está disponible. Vuelve a adjuntarlo." }); return; }
    if (up.kind === "pdf") pdfBytes += up.bytes;
    files.push({ kind: up.kind as "pdf" | "text", id, name: up.name || (up.kind === "pdf" ? "documento.pdf" : "documento.txt"), bytes: up.bytes });
  }
  if (pdfBytes > MAX_PDF_BYTES_PER_MESSAGE) { res.status(400).json({ message: "Los PDF de un mensaje suman más de 15 MB. Envíalos por separado." }); return; }
  const v = req.body?.video;
  if (v && typeof v === "object") {
    const frames: string[] = Array.isArray(v.frames) ? v.frames.map(String).slice(0, MAX_FRAMES + 1) : [];
    const bytes = Number(v.bytes) || 0, duration = Number(v.duration) || 0;
    if (!frames.length || frames.length > MAX_FRAMES || frames.some(id => !own(id, ["frame"]))) { res.status(400).json({ message: "El video ya no está disponible. Vuelve a adjuntarlo." }); return; }
    if (bytes > VIDEO_MAX_BYTES * 1.02) { res.status(400).json({ message: "El video pesa más de 15 MB." }); return; }
    files.push({ kind: "video", name: cleanName(v.name) || "video", bytes, duration: Math.max(0, Math.min(duration, 6 * 3600)), frames });
  }
  if (!text && !images.length && !files.length) { res.status(400).json({ message: "Escribe un mensaje." }); return; }
  const gate = chatGate(customer.id);
  if (!gate.ok) { res.status(gate.status).json({ message: gate.message, code: gate.code || "" }); return; }

  let conv = req.body?.conversationId ? getConversation(customer.id, Number(req.body.conversationId)) : null;
  if (req.body?.conversationId && !conv) { res.status(404).json({ message: "Conversación no encontrada." }); return; }
  if (!conv) conv = createConversation(customer.id, (text || files[0]?.name || "Imagen").replace(/\s+/g, " ").slice(0, 60));
  const prev = listMessages(conv.id).filter(m => m.role === "assistant" && m.tier).pop();
  addMessage({ conversationId: conv.id, role: "user", text, images, files });
  touchConversation(conv.id);

  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no"); // nginx: no juntar, mandar al toque
  res.flushHeaders();

  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  const emit = (e: ChatEvent) => { if (!res.writableEnded) res.write(JSON.stringify(e) + "\n"); };

  await runChat({
    customerId: customer.id, conversationId: conv.id, text, imageCount: images.length + files.length, source: gate.source,
    prevTier: (prev?.tier as Tier) || null, signal: controller.signal, emit,
  });
  touchConversation(conv.id);
  if (!res.writableEnded) res.end();
});

export default router;
