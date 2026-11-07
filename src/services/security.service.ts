import type { Request } from "express";
import { db } from "../db/db";
import { blockPhone, blockIp, isPhoneBlocked } from "../db/security.repository";
import { findChatByPhone, setBotState, setChatTag } from "../db/support-chat.repository";
import { emitChatEvent } from "../utils/chat-events.util";

// ─────────────────────────────────────────────────────────────
// SEGURIDAD DEL CHAT — un cliente no tiene por qué mandar enlaces ni
// código al chat de soporte. Si lo hace, se bloquea su número al
// instante (sin confirmación) y su IP no puede crear cuentas nuevas por
// 7 días. Nada de lo que manda se abre ni se visita nunca: el servidor no
// sigue enlaces de clientes y el panel los muestra como texto.
// ─────────────────────────────────────────────────────────────

// Enlaces: http(s)://…, www.… o dominio seguido de una ruta (sitio.com/x).
// Un correo (nombre@gmail.com) NO cuenta como enlace. Los de las propias
// plataformas (ej. netflix.com/tv8) se permiten: un cliente puede citarlos.
const LINK_FIND = /(?:https?:\/\/|\bwww\.)[^\s"'<>`]+|(?:^|[\s"'(<])([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\/[^\s"'<>`]*)/gi;
const ALLOWED_LINK_HOSTS = [
  "netflix.com", "disneyplus.com", "disney.com", "primevideo.com", "amazon.com", "crunchyroll.com",
  "chatgpt.com", "openai.com", "max.com", "hbomax.com", "paramountplus.com", "youtube.com", "youtu.be",
  "spotify.com", "canva.com", "google.com", "apple.com", "vix.com",
];

function linkHost(raw: string): string {
  return raw.trim().replace(/^[\s"'(<]+/, "").replace(/^https?:\/\//i, "").replace(/^www\./i, "")
    .split(/[/?#:]/)[0]!.toLowerCase();
}

function hasForeignLink(text: string): boolean {
  for (const m of text.matchAll(LINK_FIND)) {
    const host = linkHost(m[1] ?? m[0]);
    if (!host) return true;
    if (!ALLOWED_LINK_HOSTS.some(d => host === d || host.endsWith("." + d))) return true;
  }
  return false;
}

// Código o pruebas de inyección.
const INJECTION_RE = new RegExp([
  "<\\s*\\/?\\s*(script|img|svg|iframe|a|body|style|object|embed|video|audio|input|form|link|meta|details|math)\\b",
  "\\bon[a-z]{3,}\\s*=",
  "javascript\\s*:",
  "data\\s*:\\s*text\\/html",
  "\\bfetch\\s*\\(",
  "\\bdocument\\s*\\.",
  "\\bwindow\\s*\\.",
  "\\bbtoa\\s*\\(",
  "\\beval\\s*\\(",
  "\\.then\\s*\\(",
  "\\balert\\s*\\(",
  "webhook\\.site", "dnslog", "burpcollaborator", "oastify", "interact\\.sh", "requestbin", "ngrok",
].join("|"), "i");

export function suspiciousReason(text: string): string | null {
  if (INJECTION_RE.test(text)) return "Intento de inyección de código";
  if (hasForeignLink(text)) return "Envió enlaces";
  return null;
}

/** IP pública real (no la del propio servidor ni de la red interna). Las
 *  reglas por IP solo se aplican a estas: si nginx no mandara la IP del
 *  cliente, todos llegarían como 127.0.0.1 y se bloquearía a todo el mundo. */
export function isPublicIp(ip: string): boolean {
  if (!ip) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(ip)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return false; // CGNAT interno
  if (ip === "::1" || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip)) return false;
  return true;
}

/** IP real del cliente detrás de nginx (último salto de X-Forwarded-For). */
export function clientIp(req: Request): string {
  const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const ip = xff.length ? xff[xff.length - 1]! : String(req.headers["x-real-ip"] ?? req.ip ?? "");
  return ip.replace(/^::ffff:/, "").slice(0, 64);
}

/** Bloquea el número (y por 7 días su IP para cuentas nuevas) y cierra su chat. */
export function autoBlockCustomer(phone: string, ip: string, reason: string, evidence: string): void {
  blockPhone({ phone, reason, evidence, source: "auto", ip });
  if (isPublicIp(ip)) blockIp(ip, reason);
  const chat = findChatByPhone(phone);
  if (chat) {
    setBotState(chat.id, "blocked", { reason });
    setChatTag(chat.id, "cerrado");
    emitChatEvent({ type: "chat_created", chatId: chat.id, clientPhone: chat.clientPhone });
  }
  console.warn(`🚫 Bloqueado automáticamente ${phone} (${reason}) ip=${ip || "?"}`);
}

/** Al arrancar: revisa los mensajes ya guardados y bloquea a quien haya mandado enlaces o código. */
export function scanPastChatMessages(): number {
  const rows = db.prepare(`
    SELECT c.client_phone AS phone, m.text AS text
    FROM support_chat_messages m JOIN support_chats c ON c.id = m.chat_id
    WHERE m.sender = 'customer' AND m.type = 'text'
    ORDER BY m.id ASC
  `).all() as { phone: string; text: string }[];
  let blocked = 0;
  for (const r of rows) {
    if (isPhoneBlocked(r.phone)) continue;
    const reason = suspiciousReason(r.text);
    if (!reason) continue;
    autoBlockCustomer(r.phone, "", reason, r.text);
    blocked++;
  }
  return blocked;
}
