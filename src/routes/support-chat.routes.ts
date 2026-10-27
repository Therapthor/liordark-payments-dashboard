import { Router } from "express";
import multer from "multer";
import {
  listChatsForAdmin, getChatById, listMessages, addMessage, setTyping, markSeen, closeChat, setChatTag,
  isValidStickerId,
} from "../db/support-chat.repository";
import { uploadChatMedia, deleteChatMedia } from "../services/cloudinary.service";
import { onChatEvent, emitChatEvent } from "../utils/chat-events.util";

// ─────────────────────────────────────────────────────────────
// PANEL ADMIN > CHAT DE SOPORTE — requireAuth se aplica al montar en
// index.ts. Abierto a todos los clientes (ver store.routes.ts), así que
// el inbox puede tener varias conversaciones a la vez.
// ─────────────────────────────────────────────────────────────

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function mediaExpiresAtISO(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

router.get("/", (_req, res) => {
  res.json({ chats: listChatsForAdmin() });
});

router.get("/:id/messages", (req, res) => {
  const chatId = Number(req.params.id);
  const chat = getChatById(chatId);
  if (!chat) return res.status(404).json({ message: "Chat no encontrado (puede que ya lo hayan cerrado)." });

  markSeen(chatId, "admin");
  res.json({ chat, messages: listMessages(chatId) });
});

// type: "text" (normal, o el botón rápido "👋 Saludo"), "account_request"
// (botón "📋 Solicitar cuenta" — el cliente ve un selector de sus cuentas
// en esa burbuja) o "sticker" (id del catálogo cerrado, nunca texto
// libre). Nunca "account_reply" — esa solo la manda el cliente, verificada
// contra su cuenta real (ver store.routes.ts).
router.post("/:id/messages", (req, res) => {
  const chatId = Number(req.params.id);
  const chat = getChatById(chatId);
  if (!chat) return res.status(404).json({ message: "Chat no encontrado." });

  if (req.body?.type === "sticker") {
    const stickerId = String(req.body?.stickerId ?? "");
    if (!isValidStickerId(stickerId)) return res.status(400).json({ message: "Sticker no válido." });
    const message = addMessage(chatId, "admin", { type: "sticker", text: stickerId });
    emitChatEvent({ type: "message", chatId, message });
    return res.status(201).json({ message });
  }

  const type = req.body?.type === "account_request" ? "account_request" : "text";
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ message: "Escribe un mensaje." });

  const message = addMessage(chatId, "admin", { type, text });
  emitChatEvent({ type: "message", chatId, message });
  res.status(201).json({ message });
});

// Imagen fija de referencia para "Códigos > Prime Video / Crunchyroll" —
// no es un archivo del cliente (no hay nada que autodestruir), así que
// no pasa por Cloudinary: vive en /assets y se manda siempre la misma URL.
router.post("/:id/messages/code-reference", (req, res) => {
  const chatId = Number(req.params.id);
  const chat = getChatById(chatId);
  if (!chat) return res.status(404).json({ message: "Chat no encontrado." });

  const message = addMessage(chatId, "admin", {
    type: "image", mediaUrl: "/assets/codigo-referencia-1.png", mediaResourceType: "image",
  });
  emitChatEvent({ type: "message", chatId, message });
  res.status(201).json({ message });
});

router.post("/:id/messages/media", upload.single("file"), async (req, res) => {
  const chatId = Number(req.params.id);
  const chat = getChatById(chatId);
  if (!chat) return res.status(404).json({ message: "Chat no encontrado." });

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) return res.status(400).json({ message: "Falta el archivo." });

  const isImage = file.mimetype.startsWith("image/");
  const isVideo = file.mimetype.startsWith("video/");
  if (!isImage && !isVideo) return res.status(400).json({ message: "Solo se pueden enviar fotos o videos." });

  try {
    const { url, publicId } = await uploadChatMedia(file.buffer, isImage ? "image" : "video");
    const message = addMessage(chatId, "admin", {
      type: isImage ? "image" : "video", mediaUrl: url, mediaPublicId: publicId,
      mediaResourceType: isImage ? "image" : "video", mediaExpiresAt: mediaExpiresAtISO(),
    });
    emitChatEvent({ type: "message", chatId, message });
    res.status(201).json({ message });
  } catch (err: any) {
    res.status(502).json({ message: err?.message || "No se pudo subir el archivo." });
  }
});

router.post("/:id/typing", (req, res) => {
  const chatId = Number(req.params.id);
  const chat = getChatById(chatId);
  if (!chat) return res.status(404).json({ message: "Chat no encontrado." });

  const typing = !!req.body?.typing;
  setTyping(chatId, "admin", typing);
  emitChatEvent({ type: "typing", chatId, sender: "admin", typing });
  res.json({ ok: true });
});

// "Pendiente"/"cerrado" — orden del panel, no borra nada (eso es el botón
// de abajo). Si el cliente vuelve a escribir, el repositorio lo regresa
// solo a "pendiente" (ver addMessage).
router.post("/:id/tag", (req, res) => {
  const chatId = Number(req.params.id);
  const chat = getChatById(chatId);
  if (!chat) return res.status(404).json({ message: "Chat no encontrado." });

  const tag = req.body?.tag === "cerrado" ? "cerrado" : "pendiente";
  setChatTag(chatId, tag);
  res.json({ ok: true, tag });
});

// Cierra Y BORRA todo — mensajes y medios de Cloudinary, a propósito
// (pedido explícito del negocio, para no acumular espacio). Ya NO manda
// despedida automática acá — eso duplicaba el mensaje cuando el admin ya
// la había mandado con el botón rápido "🙏 Despedida" antes de cerrar
// (y el sintético de acá traía un formato de fecha que el cliente
// mostraba como "Invalid Date"). El admin la manda aparte si quiere.
router.post("/:id/close", async (req, res) => {
  const chatId = Number(req.params.id);
  const chat = getChatById(chatId);
  if (!chat) return res.status(404).json({ message: "Chat no encontrado." });

  const media = closeChat(chatId);
  await Promise.all(media.map(m => deleteChatMedia(m.publicId, m.resourceType)));

  emitChatEvent({ type: "closed", chatId });
  res.json({ ok: true });
});

// SSE — todos los eventos de todos los chats (el inbox es uno solo).
router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  const unsubscribe = onChatEvent((evt) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  });

  const ping = setInterval(() => res.write(":ping\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});

export default router;
