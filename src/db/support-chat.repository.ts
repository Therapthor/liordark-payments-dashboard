import { db } from "./db";
import { normalizePeruPhone } from "../utils/phone.util";

// ─────────────────────────────────────────────────────────────
// CHAT DE SOPORTE EN VIVO (liordark.com <-> panel admin) — ver db.ts para
// el esquema. Un celular tiene a lo más UN chat a la vez (cualquier fila
// en support_chats está, por definición, abierta — cerrar = borrar).
// ─────────────────────────────────────────────────────────────

export type ChatSender = "customer" | "admin";
// account_request: el admin pide (botón "Solicitar cuenta") que el cliente
// elija cuál de sus cuentas tiene el problema — el cliente ve un selector
// inline en esa burbuja. account_reply: lo que el cliente mandó de vuelta,
// ya verificado contra SU cuenta real (ver /chat/messages en store.routes.ts).
// sticker: text guarda el id del catálogo (ver CHAT_STICKER_IDS más abajo) —
// cliente y admin lo renderizan cada uno con su propio mapa emoji/animación.
// bot_options / bot_code / bot_totp: mensajes del asistente automático
// (ver services/support-bot.service.ts) — text guarda JSON. bot_options =
// texto + botones de respuesta; bot_code = código ya encontrado;
// bot_totp = 2FA vigente por unos minutos (el código NUNCA se guarda acá,
// el cliente lo pide en vivo a /chat/totp/:id mientras no venza).
export type ChatMessageType =
  | "text" | "image" | "video" | "account_request" | "account_reply" | "sticker"
  | "bot_options" | "bot_code" | "bot_totp";

// Catálogo cerrado — ambos lados (cliente y admin) solo pueden mandar un id
// de esta lista, nunca texto libre, para no abrir una puerta de contenido
// arbitrario disfrazado de sticker.
export const CHAT_STICKER_IDS = [
  "mango_hi", "mango_love", "mango_lol", "mango_thumb",
  "mango_party", "mango_sad", "mango_sleep", "mango_fire",
] as const;
export type ChatStickerId = typeof CHAT_STICKER_IDS[number];
export function isValidStickerId(id: string): id is ChatStickerId {
  return (CHAT_STICKER_IDS as readonly string[]).includes(id);
}

export type ChatMessage = {
  id:               number;
  chatId:           number;
  sender:           ChatSender;
  type:              ChatMessageType;
  text:             string;
  mediaUrl:         string;
  mediaExpired:     boolean;
  createdAt:        string;
};

export type ChatTag = "pendiente" | "cerrado";

export type Chat = {
  id:               number;
  clientPhone:      string;
  adminTyping:      boolean;
  customerTyping:   boolean;
  tag:              ChatTag;
  botState:         string | null;
  botContext:       Record<string, any>;
  createdAt:        string;
  updatedAt:        string;
};

export type ChatSummary = Chat & {
  lastMessage:      string;
  lastMessageAt:    string;
  unreadForAdmin:   number;
};

function last9(phone: string): string {
  return phone.replace(/\D/g, "").slice(-9);
}

// Mismo criterio que isTypingNow de más abajo — "escribiendo" expira solo
// si no llega un nuevo aviso en TYPING_TTL_MS (por si el navegador se
// cierra sin avisar que paró), aparte del apagado explícito al mandar.
const TYPING_TTL_MS = 6_000;

function isTypingNow(typingAt: string | null): boolean {
  if (!typingAt) return false;
  const at = new Date(typingAt.replace(" ", "T") + "Z").getTime();
  return Date.now() - at < TYPING_TTL_MS;
}

function parseJsonObject(raw: unknown): Record<string, any> {
  try {
    const v = JSON.parse(String(raw ?? "{}"));
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}

function toChat(row: any): Chat {
  return {
    id:             row.id,
    clientPhone:    row.client_phone,
    adminTyping:    isTypingNow(row.admin_typing_at),
    customerTyping: isTypingNow(row.customer_typing_at),
    tag:            row.tag === "cerrado" ? "cerrado" : "pendiente",
    botState:       row.bot_state ?? null,
    botContext:     parseJsonObject(row.bot_context),
    createdAt:      row.created_at,
    updatedAt:      row.updated_at,
  };
}

function toMessage(row: any): ChatMessage {
  return {
    id:           row.id,
    chatId:       row.chat_id,
    sender:       row.sender,
    type:         row.type,
    text:         row.text,
    mediaUrl:     row.media_url,
    mediaExpired: !!row.media_expired,
    createdAt:    row.created_at,
  };
}

export function findChatByPhone(phone: string): Chat | null {
  const row = db.prepare(`SELECT * FROM support_chats WHERE substr(client_phone, -9) = ?`).get(last9(phone));
  return row ? toChat(row) : null;
}

export function getChatById(id: number): Chat | null {
  const row = db.prepare(`SELECT * FROM support_chats WHERE id = ?`).get(id);
  return row ? toChat(row) : null;
}

export function getOrCreateOpenChatForPhone(phone: string): Chat {
  const existing = findChatByPhone(phone);
  if (existing) return existing;

  const digits = normalizePeruPhone(phone);
  const info = db.prepare(`INSERT INTO support_chats (client_phone) VALUES (?)`).run(digits);
  return getChatById(info.lastInsertRowid as number) as Chat;
}

/** Inbox del panel — todos los chats abiertos (de momento, a lo más uno,
 *  el del celular de prueba), más nuevo primero. Un chat recién creado por
 *  el cliente al simplemente abrir el widget (GET /chat, SSE) todavía no
 *  tiene ningún mensaje — no debe aparecer acá como "nuevo" hasta que de
 *  verdad escriba algo. */
export function listChatsForAdmin(): ChatSummary[] {
  const rows = db.prepare(`SELECT * FROM support_chats ORDER BY updated_at DESC`).all() as any[];
  return rows.flatMap(row => {
    // Solo el saludo del asistente (el cliente abrió el chat pero no
    // escribió nada) tampoco cuenta como conversación.
    const hasCustomer = db.prepare(`
      SELECT 1 FROM support_chat_messages WHERE chat_id = ? AND sender = 'customer' LIMIT 1
    `).get(row.id);
    if (!hasCustomer) return [];
    const last = db.prepare(`
      SELECT type, text, created_at FROM support_chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1
    `).get(row.id) as any;
    if (!last) return [];

    const chat = toChat(row);
    const unread = db.prepare(`
      SELECT COUNT(*) AS n FROM support_chat_messages
      WHERE chat_id = ? AND sender = 'customer' AND (? IS NULL OR created_at > ?)
    `).get(row.id, row.admin_seen_at, row.admin_seen_at) as { n: number };
    return [{
      ...chat,
      lastMessage:   messagePreview(last.type, last.text),
      lastMessageAt: last.created_at,
      unreadForAdmin: unread.n,
    }];
  });
}

function messagePreview(type: string, text: string): string {
  switch (type) {
    case "text":            return text;
    case "image":           return "📷 Foto";
    case "video":           return "🎥 Video";
    case "sticker":         return "🥭 Sticker";
    case "account_request": return "📋 Pedido de cuenta";
    case "account_reply":   return "📋 Cuenta enviada";
    case "bot_code":        return "🤖 Código enviado";
    case "bot_totp":        return "🤖 Código 2FA enviado";
    case "bot_options":     return "🤖 " + String(parseJsonObject(text).text ?? "").split("\n")[0];
    default:                return "";
  }
}

export function getMessageById(id: number): ChatMessage | null {
  const row = db.prepare(`SELECT * FROM support_chat_messages WHERE id = ?`).get(id);
  return row ? toMessage(row) : null;
}

/** true si este chat todavía no tiene ningún mensaje. */
export function chatHasNoMessages(chatId: number): boolean {
  return !db.prepare(`SELECT 1 FROM support_chat_messages WHERE chat_id = ? LIMIT 1`).get(chatId);
}

/** Último mensaje del chat (el más nuevo), si hay. */
export function getLastMessage(chatId: number): ChatMessage | null {
  const row = db.prepare(`SELECT * FROM support_chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1`).get(chatId);
  return row ? toMessage(row) : null;
}

/** Último mensaje de este tipo en el chat (ej. los últimos botones del asistente). */
export function getLastMessageOfType(chatId: number, type: ChatMessageType): ChatMessage | null {
  const row = db.prepare(`
    SELECT * FROM support_chat_messages WHERE chat_id = ? AND type = ? ORDER BY id DESC LIMIT 1
  `).get(chatId, type);
  return row ? toMessage(row) : null;
}

/** true si el cliente ya escribió algo después de este mensaje — así un
 *  botón viejo del asistente no se puede volver a tocar. */
export function hasCustomerMessageAfter(chatId: number, messageId: number): boolean {
  return !!db.prepare(`
    SELECT 1 FROM support_chat_messages WHERE chat_id = ? AND sender = 'customer' AND id > ? LIMIT 1
  `).get(chatId, messageId);
}

export function setBotState(chatId: number, state: string | null, context: Record<string, any> = {}): void {
  db.prepare(`UPDATE support_chats SET bot_state = ?, bot_context = ? WHERE id = ?`)
    .run(state, JSON.stringify(context), chatId);
}

/** Chats donde el asistente lleva la conversación (no "human") — para el
 *  barrido de inactividad / 2FA vencido (ver support-bot.service.ts). */
export function listBotChats(): Chat[] {
  return (db.prepare(`
    SELECT * FROM support_chats WHERE bot_state IS NOT NULL AND bot_state != 'human'
  `).all() as any[]).map(toChat);
}

export function listMessages(chatId: number, afterId = 0): ChatMessage[] {
  return (db.prepare(`
    SELECT * FROM support_chat_messages WHERE chat_id = ? AND id > ? ORDER BY id ASC
  `).all(chatId, afterId) as any[]).map(toMessage);
}

export function addMessage(chatId: number, sender: ChatSender, params: {
  type: ChatMessageType; text?: string; mediaUrl?: string; mediaPublicId?: string;
  mediaResourceType?: string; mediaExpiresAt?: string | null;
}): ChatMessage {
  const info = db.prepare(`
    INSERT INTO support_chat_messages
      (chat_id, sender, type, text, media_url, media_public_id, media_resource_type, media_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chatId, sender, params.type, params.text ?? "", params.mediaUrl ?? "",
    params.mediaPublicId ?? "", params.mediaResourceType ?? "", params.mediaExpiresAt ?? null
  );

  // Mandar un mensaje implica que ya dejó de escribir, y renueva la
  // actividad del chat (orden del inbox del panel). Si el cliente escribe
  // en uno que el admin ya había marcado "cerrado", vuelve a "pendiente"
  // solo — si no, pasaría desapercibido.
  const typingCol = sender === "admin" ? "admin_typing_at" : "customer_typing_at";
  db.prepare(`UPDATE support_chats SET ${typingCol} = NULL, updated_at = datetime('now') WHERE id = ?`).run(chatId);
  if (sender === "customer") {
    db.prepare(`UPDATE support_chats SET tag = 'pendiente' WHERE id = ? AND tag = 'cerrado'`).run(chatId);
  }

  return toMessage(db.prepare(`SELECT * FROM support_chat_messages WHERE id = ?`).get(info.lastInsertRowid));
}

export function setTyping(chatId: number, sender: ChatSender, typing: boolean): void {
  const col = sender === "admin" ? "admin_typing_at" : "customer_typing_at";
  db.prepare(`UPDATE support_chats SET ${col} = ? WHERE id = ?`).run(typing ? new Date().toISOString() : null, chatId);
}

/** El cliente escribe en un chat marcado "cerrado": vuelve solo a
 *  "pendiente" (si no, se perdería entre los cerrados sin que el admin
 *  se dé cuenta de que hay algo nuevo). */
export function setChatTag(chatId: number, tag: ChatTag): void {
  db.prepare(`UPDATE support_chats SET tag = ? WHERE id = ?`).run(tag, chatId);
}

export function markSeen(chatId: number, by: ChatSender): void {
  const col = by === "admin" ? "admin_seen_at" : "customer_seen_at";
  db.prepare(`UPDATE support_chats SET ${col} = datetime('now') WHERE id = ?`).run(chatId);
}

/** Para el numerito en el botón "💬 Soporte" de la barra — así el cliente
 *  sabe que ya le respondieron sin tener que abrir el chat. */
export function countUnreadForCustomer(phone: string): number {
  const chat = findChatByPhone(phone);
  if (!chat) return 0;
  const row = db.prepare(`SELECT customer_seen_at AS seenAt FROM support_chats WHERE id = ?`).get(chat.id) as { seenAt: string | null };
  const unread = db.prepare(`
    SELECT COUNT(*) AS n FROM support_chat_messages
    WHERE chat_id = ? AND sender = 'admin' AND (? IS NULL OR created_at > ?)
  `).get(chat.id, row.seenAt, row.seenAt) as { n: number };
  return unread.n;
}

export type ChatMediaRef = { publicId: string; resourceType: string };

/** Cierra (borra) el chat entero — devuelve los medios de Cloudinary que
 *  hay que borrar también (el caller se encarga, esto es solo SQLite). */
export function closeChat(chatId: number): ChatMediaRef[] {
  const media = (db.prepare(`
    SELECT media_public_id AS publicId, media_resource_type AS resourceType
    FROM support_chat_messages WHERE chat_id = ? AND media_public_id != ''
  `).all(chatId) as ChatMediaRef[]);

  const run = db.transaction((id: number) => {
    db.prepare(`DELETE FROM support_chat_messages WHERE chat_id = ?`).run(id);
    db.prepare(`DELETE FROM support_chats WHERE id = ?`).run(id);
  });
  run(chatId);

  return media;
}

/** Fotos/videos a punto de autodestruirse (1 día) — ver expiry-chat-media.job.ts. */
export function listExpiredChatMedia(): (ChatMediaRef & { messageId: number })[] {
  return db.prepare(`
    SELECT id AS messageId, media_public_id AS publicId, media_resource_type AS resourceType
    FROM support_chat_messages
    WHERE media_expired = 0 AND media_public_id != '' AND media_expires_at IS NOT NULL AND media_expires_at <= datetime('now')
  `).all() as (ChatMediaRef & { messageId: number })[];
}

/** El archivo ya se borró de Cloudinary — deja el mensaje como marcador vacío. */
export function markChatMediaExpired(messageId: number): void {
  db.prepare(`
    UPDATE support_chat_messages SET media_url = '', media_public_id = '', media_expired = 1 WHERE id = ?
  `).run(messageId);
}
