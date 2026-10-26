import { EventEmitter } from "events";
import type { ChatMessage } from "../db/support-chat.repository";

// Pub/sub en memoria para el chat de soporte — mismo criterio que
// live-events.util.ts (panel de Pagos), un solo emitter de proceso: cada
// pestaña abierta (cliente o admin) se suscribe acá vía SSE.

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export type ChatLiveEvent =
  | { type: "message"; chatId: number; message: ChatMessage }
  | { type: "typing"; chatId: number; sender: "customer" | "admin"; typing: boolean }
  | { type: "closed"; chatId: number }
  | { type: "chat_created"; chatId: number; clientPhone: string };

export function onChatEvent(listener: (evt: ChatLiveEvent) => void): () => void {
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}

export function emitChatEvent(evt: ChatLiveEvent): void {
  emitter.emit("event", evt);
}
