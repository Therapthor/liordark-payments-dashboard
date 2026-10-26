import { listExpiredChatMedia, markChatMediaExpired } from "../db/support-chat.repository";
import { deleteChatMedia } from "../services/cloudinary.service";

// ─────────────────────────────────────────────────────────────
// Fotos/videos del chat de soporte se autodestruyen al día de mandados —
// borra el archivo de Cloudinary y deja el mensaje como marcador vacío
// (ver support-chat.repository.ts markChatMediaExpired). El chat cerrado
// entero se borra aparte (closeChat), esto es solo para medios de chats
// que siguen abiertos.
// ─────────────────────────────────────────────────────────────

export async function runExpireChatMedia(): Promise<void> {
  const expired = listExpiredChatMedia();
  for (const m of expired) {
    await deleteChatMedia(m.publicId, m.resourceType);
    markChatMediaExpired(m.messageId);
  }
}
