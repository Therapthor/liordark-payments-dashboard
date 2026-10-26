import { Router } from "express";
import multer from "multer";
import {
  listChatsForAdmin, getChatById, listMessages, addMessage, setTyping, markSeen, closeChat,
} from "../db/support-chat.repository";
import { uploadChatMedia, deleteChatMedia } from "../services/cloudinary.service";
import { onChatEvent, emitChatEvent } from "../utils/chat-events.util";

// ─────────────────────────────────────────────────────────────
// PANEL ADMIN > CHAT DE SOPORTE — requireAuth se aplica al montar en
// index.ts. De momento solo puede existir el chat del celular de prueba
// (ver SUPPORT_TEST_PHONE en store.routes.ts), así que el inbox siempre
// va a tener a lo más una conversación — igual queda armado para varias.
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

// type: "text" (normal, o el botón rápido "👋 Saludo") o "account_request"
// (botón "📋 Solicitar cuenta" — el cliente ve un selector de sus cuentas
// en esa burbuja). Nunca "account_reply" — esa solo la manda el cliente,
// verificada contra su cuenta real (ver store.routes.ts).
router.post("/:id/messages", (req, res) => {
  const chatId = Number(req.params.id);
  const chat = getChatById(chatId);
  if (!chat) return res.status(404).json({ message: "Chat no encontrado." });

  const type = req.body?.type === "account_request" ? "account_request" : "text";
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ message: "Escribe un mensaje." });

  const message = addMessage(chatId, "admin", { type, text });
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

// Cierra Y BORRA todo — mensajes y medios de Cloudinary, a propósito
// (pedido explícito del negocio, para no acumular espacio).
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
