import crypto from "crypto";
import {
  createShare, getShare, listShares, deleteShare, bumpShareViews, getConversation, listMessages,
  createConversation, addMessage, touchConversation, type AiShareMessage, type AiShare,
} from "../db/manguito.repository";
import { TIERS } from "./manguito.service";

// ─────────────────────────────────────────────────────────────
// MANGUITO PRO — compartir un chat con un link nuestro
// (liordark.com/manguito/s/<token>).
//
// · El cliente elige qué se ve: todo el chat, solo el resultado (la última
//   respuesta) o los mensajes que marque. Se guarda una COPIA fija: lo que
//   escriba después no aparece, y si borra la conversación el link sigue
//   hasta que lo borre.
// · Público (cualquiera con el link) o privado con contraseña (se guarda
//   solo su huella scrypt, nunca la contraseña).
// · Las imágenes no se comparten (solo se indica que había una imagen).
// · Quien abre el link sin cuenta solo puede leer; para continuar la
//   conversación necesita su cuenta y Manguito Pro (se le copia a su chat).
// ─────────────────────────────────────────────────────────────

export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_SHARES = 100;
const MAX_TEXT = 30_000;
const MAX_TOTAL = 200_000;

const tierLabel = (t: string) => (TIERS as Record<string, { label: string }>)[t]?.label || "";

function hashPass(pass: string, salt: string): string {
  return crypto.scryptSync(pass, salt, 32).toString("hex");
}

export function createShareFor(customerId: number, body: any): { ok: true; token: string } | { ok: false; message: string } {
  const conv = getConversation(customerId, Number(body?.conversationId));
  if (!conv) return { ok: false, message: "Conversación no encontrada." };
  if (listShares(customerId).length >= MAX_SHARES) return { ok: false, message: "Tienes muchos links. Borra alguno en «Mis links compartidos»." };

  const all = listMessages(conv.id).filter(m => m.text.trim() || m.images.length || m.files.length);
  const mode = body?.mode === "result" ? "result" : body?.mode === "selected" ? "selected" : "all";
  let chosen = all;
  if (mode === "result") {
    const last = [...all].reverse().find(m => m.role === "assistant" && m.text.trim() && m.status !== "error");
    if (!last) return { ok: false, message: "Todavía no hay una respuesta para compartir." };
    chosen = [last];
  } else if (mode === "selected") {
    const ids = new Set((Array.isArray(body?.messageIds) ? body.messageIds : []).map(Number));
    chosen = all.filter(m => ids.has(m.id));
    if (!chosen.length) return { ok: false, message: "Marca al menos un mensaje." };
  }
  if (!chosen.length) return { ok: false, message: "Esta conversación todavía está vacía." };

  let total = 0;
  const messages: AiShareMessage[] = [];
  for (const m of chosen) {
    const text = m.text.length > MAX_TEXT ? m.text.slice(0, MAX_TEXT) + "\n[…]" : m.text;
    total += text.length;
    if (total > MAX_TOTAL) break;
    messages.push({ role: m.role, text, ...(m.role === "assistant" && tierLabel(m.tier) ? { label: tierLabel(m.tier) } : {}), ...(m.images.length + m.files.length ? { images: m.images.length + m.files.length } : {}) });
  }

  const password = typeof body?.password === "string" ? body.password : "";
  if (body?.visibility === "private") {
    if (password.length < 4 || password.length > 64) return { ok: false, message: "La contraseña debe tener de 4 a 64 caracteres." };
  }
  const salt = body?.visibility === "private" ? crypto.randomBytes(16).toString("hex") : "";
  const token = crypto.randomBytes(16).toString("base64url");
  createShare({
    token, customerId, conversationId: conv.id, mode, messages,
    title: String(body?.title || conv.title || "Conversación").replace(/\s+/g, " ").trim().slice(0, 80) || "Conversación",
    passHash: salt ? hashPass(password, salt) : "", passSalt: salt,
  });
  return { ok: true, token };
}

export function mySharesView(customerId: number) {
  return listShares(customerId).map(s => ({
    token: s.token, title: s.title, mode: s.mode, locked: s.locked, views: s.views, createdAt: s.createdAt,
    count: s.messages.length, conversationId: s.conversationId,
  }));
}

export function removeShare(customerId: number, token: string): boolean {
  return deleteShare(customerId, token);
}

function publicMessages(s: AiShare) {
  return s.messages.map(m => ({ role: m.role, text: m.text, label: m.label || "", images: m.images || 0 }));
}

/** Lo que ve quien abre el link (sin mensajes si tiene contraseña). */
export function shareView(token: string, countView: boolean) {
  const s = SHARE_TOKEN_RE.test(token) ? getShare(token) : null;
  if (!s) return null;
  if (countView && !s.locked) bumpShareViews(token);
  return {
    title: s.locked ? "Chat protegido" : s.title,
    locked: s.locked, mode: s.mode, createdAt: s.createdAt,
    messages: s.locked ? null : publicMessages(s),
  };
}

export function checkSharePassword(s: AiShare, password: string): boolean {
  if (!s.locked) return true;
  const got = Buffer.from(hashPass(String(password || "").slice(0, 64), s.passSalt), "hex");
  const want = Buffer.from(s.passHash, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export function unlockShare(token: string, password: string) {
  const s = SHARE_TOKEN_RE.test(token) ? getShare(token) : null;
  if (!s) return null;
  if (!checkSharePassword(s, password)) return { ok: false as const };
  bumpShareViews(token);
  return { ok: true as const, title: s.title, mode: s.mode, createdAt: s.createdAt, messages: publicMessages(s) };
}

/** Copia el chat compartido a una conversación nueva del visitante (con cuenta). */
export function continueShare(customerId: number, token: string, password: string): { ok: true; conversationId: number } | { ok: false; status: number; message: string } {
  const s = SHARE_TOKEN_RE.test(token) ? getShare(token) : null;
  if (!s) return { ok: false, status: 404, message: "Este link ya no existe." };
  if (!checkSharePassword(s, password)) return { ok: false, status: 403, message: "Contraseña incorrecta." };
  const conv = createConversation(customerId, ("↪ " + s.title).slice(0, 60));
  // Turnos alternados (cliente / Manguito), empezando por el cliente.
  const turns: { role: "user" | "assistant"; text: string }[] = [];
  for (const m of s.messages) {
    const note = m.role === "user" && m.images ? `[${m.images} imagen(es) o archivo(s) en el chat original]\n` : "";
    const text = note + m.text;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.text += "\n\n" + text;
    else turns.push({ role: m.role, text });
  }
  if (turns[0]?.role === "assistant") turns.unshift({ role: "user", text: "📎 Chat compartido conmigo:" });
  for (const t of turns) addMessage({ conversationId: conv.id, role: t.role, text: t.text, images: [] });
  touchConversation(conv.id);
  return { ok: true, conversationId: conv.id };
}
