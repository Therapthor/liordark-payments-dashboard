import fs from "fs";
import { Router } from "express";
import multer from "multer";
import { type RequestWithCustomer } from "../services/customer-auth.service";
import { findCustomerById } from "../db/customer.repository";
import {
  addMessage, createConversation, deleteConversation, deleteUploadRows, getConversation, getUpload,
  listConversations, listMessages, saveUpload, touchConversation, deleteAllConversations, deleteAllShares,
} from "../db/manguito.repository";
import {
  TIERS, UPLOAD_DIR, chatGate, isAiConfigured, newUploadId, runChat, uploadPath,
  getMemory, clearMemory, customerMeter, hasAiAccess, publicStoreInfo, startAiPurchase, aiPurchaseStatus,
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
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });
const MAX_TEXT = 20_000;
const MAX_IMAGES = 4;

function customerOf(req: unknown) {
  return findCustomerById((req as RequestWithCustomer).customerId);
}

router.get("/access", (req, res) => {
  const c = customerOf(req);
  res.setHeader("Cache-Control", "no-store");
  const allowed = !!c && hasAiAccess(c);
  res.json({ allowed, configured: isAiConfigured(), store: publicStoreInfo(), meter: allowed ? customerMeter(c!.id) : null });
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

router.post("/upload", (req, res) => {
  upload.single("image")(req, res, (err: unknown) => {
    if (err) { res.status(413).json({ message: "La imagen pesa demasiado (máx. 4 MB)." }); return; }
    const file = (req as any).file as { buffer: Buffer } | undefined;
    if (!file) { res.status(400).json({ message: "Falta la imagen." }); return; }
    const mediaType = sniffImage(file.buffer);
    if (!mediaType) { res.status(400).json({ message: "Solo imágenes JPG, PNG, WEBP o GIF." }); return; }
    const id = newUploadId();
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(uploadPath(id, mediaType), file.buffer);
    saveUpload(id, customerOf(req)!.id, mediaType, file.buffer.length);
    res.status(201).json({ id, url: imageUrl(id) });
  });
});

router.get("/uploads/:id", (req, res) => {
  const id = String(req.params.id);
  const up = /^[a-f0-9]{24}$/.test(id) ? getUpload(id) : null;
  if (!up || up.customerId !== customerOf(req)!.id) { res.status(404).end(); return; }
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(uploadPath(id, up.mediaType), (e: any) => { if (e && !res.headersSent) res.status(404).end(); });
});

// POST /api/store/ai/chat — { conversationId?, text, images: [ids] }.
// Responde en líneas JSON (una por evento) a medida que escribe.
router.post("/chat", async (req, res) => {
  const customer = customerOf(req)!;
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const images: string[] = Array.isArray(req.body?.images) ? req.body.images.map(String).slice(0, MAX_IMAGES + 1) : [];
  if (text.length > MAX_TEXT) { res.status(400).json({ message: "El mensaje es muy largo (máx. 20 000 caracteres)." }); return; }
  if (images.length > MAX_IMAGES) { res.status(400).json({ message: `Máximo ${MAX_IMAGES} imágenes por mensaje.` }); return; }
  if (!text && !images.length) { res.status(400).json({ message: "Escribe un mensaje." }); return; }
  for (const id of images) {
    const up = /^[a-f0-9]{24}$/.test(id) ? getUpload(id) : null;
    if (!up || up.customerId !== customer.id) { res.status(400).json({ message: "Una de las imágenes ya no está disponible." }); return; }
  }
  const gate = chatGate(customer.id);
  if (!gate.ok) { res.status(gate.status).json({ message: gate.message, code: gate.code || "" }); return; }

  let conv = req.body?.conversationId ? getConversation(customer.id, Number(req.body.conversationId)) : null;
  if (req.body?.conversationId && !conv) { res.status(404).json({ message: "Conversación no encontrada." }); return; }
  if (!conv) conv = createConversation(customer.id, (text || "Imagen").replace(/\s+/g, " ").slice(0, 60));
  const prev = listMessages(conv.id).filter(m => m.role === "assistant" && m.tier).pop();
  addMessage({ conversationId: conv.id, role: "user", text, images });
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
    customerId: customer.id, conversationId: conv.id, text, imageCount: images.length, source: gate.source,
    prevTier: (prev?.tier as Tier) || null, signal: controller.signal, emit,
  });
  touchConversation(conv.id);
  if (!res.writableEnded) res.end();
});

export default router;
