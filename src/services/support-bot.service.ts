import {
  addMessage, closeChat, findChatByPhone, getChatById, getLastMessageOfType, getMessageById,
  hasCustomerMessageAfter, listBotChats, setBotState, setChatTag, setTyping,
  type Chat, type ChatMessage,
} from "../db/support-chat.repository";
import { getActiveAccountForClient, listAccountsByClientPhone } from "../db/access.repository";
import {
  getAccountCodeSource, getLastSeenCodeForEmail, listClientCodesAccounts, saveIncomingCode,
} from "../db/codes.repository";
import { listCatalogProducts } from "../db/catalog.repository";
import {
  TOTP_SOURCE_ID, isAdminOnlyResult, lookupCodeWithRetries, skipsRepeatedCodes,
  type CodeLookupResult,
} from "./codes-lookup.service";
import { deleteChatMedia } from "./cloudinary.service";
import { limaTodayISO } from "./access.service";
import { getCurrentTotp } from "../utils/totp.util";
import { emitChatEvent } from "../utils/chat-events.util";

// ─────────────────────────────────────────────────────────────
// ASISTENTE AUTOMÁTICO DEL CHAT DE SOPORTE — "cerebro" propio, sin IA ni
// API externa: reglas + palabras clave + botones. Atiende lo repetitivo
// (códigos, 2FA, dudas de compra) y arma el caso para una persona cuando
// es un problema real con la cuenta.
//
// Estados (support_chats.bot_state):
//   menu            → saludó / espera que elija qué necesita
//   code_pick       → eligiendo de qué cuenta quiere el código
//   code_searching  → buscando el código en la página del proveedor
//   code_result     → ya entregó (o no encontró) el código
//   totp_active     → mostrando un 2FA que vence en TOTP_WINDOW_MS
//   issue_pick      → eligiendo qué cuenta tiene el problema
//   issue_describe  → esperando que cuente qué pasó
//   human           → lo atiende una persona: el asistente no habla más
// NULL = chat sin asistente (clientes que todavía no lo tienen).
//
// Inactividad: si el cliente no responde en INACTIVITY_MS mientras el
// asistente lleva la conversación, se despide y cierra el chat solo.
// ─────────────────────────────────────────────────────────────

// De momento, solo este celular tiene el asistente (últimos 9 dígitos).
const BOT_PHONES = ["977430941"];

const INACTIVITY_MS      = 5 * 60 * 1000;
const TOTP_WINDOW_MS     = 2 * 60 * 1000;
const REPLY_DELAY_MS     = 900;   // pausa "escribiendo…" antes de responder
const MAX_LOOKUPS        = 3;     // búsquedas de código por cuenta, por chat
const MAX_MISUNDERSTOOD  = 2;     // mensajes sin entender antes de pasar a una persona

export function isSupportBotEnabledFor(phone: string): boolean {
  return BOT_PHONES.includes(phone.replace(/\D/g, "").slice(-9));
}

type BotOption = { id: string; label: string };

const MENU_OPTIONS: BotOption[] = [
  { id: "code",     label: "🔑 Necesito un código" },
  { id: "issue",    label: "⚠️ Problema con una cuenta" },
  { id: "products", label: "🛒 Productos y cómo comprar" },
  { id: "human",    label: "👤 Hablar con un asesor" },
];
const BACK_OPTION: BotOption  = { id: "menu",  label: "⬅️ Volver al menú" };
const HUMAN_OPTION: BotOption = { id: "human", label: "👤 Hablar con un asesor" };
const DONE_OPTION: BotOption  = { id: "done",  label: "✅ Listo, gracias" };

const GREETING_TEXT =
  "¡Hola! 👋 Soy el asistente de Liordark 🥭\n¿En qué te puedo ayudar hoy? Elige una opción o escríbeme tu consulta.";
const THANKS_TEXT =
  "¡Gracias por escribirnos! 🥭 Esperamos haberte ayudado. Cerramos este chat; si necesitas algo más, vuelve a escribirnos cuando quieras.";
const INACTIVITY_TEXT =
  "Como no recibimos respuesta, cerramos este chat. ¡Gracias por escribirnos! 🥭 Esperamos haberte ayudado; si necesitas algo más, vuelve a escribirnos cuando quieras.";
const TOTP_DONE_TEXT =
  "⏱️ El código 2FA ya expiró. ¡Gracias por confiar en Liordark! 🥭 Esperamos haberte ayudado; cerramos este chat. Si necesitas otro código, vuelve a escribirnos.";

// ── Mensajes del asistente ──

function say(chatId: number, text: string, options: BotOption[] = []): ChatMessage {
  const message = addMessage(chatId, "admin", { type: "bot_options", text: JSON.stringify({ text, options }) });
  emitChatEvent({ type: "message", chatId, message });
  return message;
}

function typing(chatId: number, on: boolean): void {
  setTyping(chatId, "admin", on);
  emitChatEvent({ type: "typing", chatId, sender: "admin", typing: on });
}

async function closeWithThanks(chatId: number, text: string): Promise<void> {
  say(chatId, text);
  const media = closeChat(chatId);
  await Promise.all(media.map(m => deleteChatMedia(m.publicId, m.resourceType).catch(() => undefined)));
  emitChatEvent({ type: "closed", chatId });
}

function handoff(chat: Chat, text: string): void {
  say(chat.id, text);
  setBotState(chat.id, "human", {});
  setChatTag(chat.id, "pendiente");
}

// ── Entender texto libre (sin IA) ──

function normalize(text: string): string {
  return text.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9@.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type Intent = "human" | "code" | "issue" | "products" | "done" | "menu";

const INTENT_RULES: { intent: Intent; re: RegExp }[] = [
  { intent: "human",    re: /\b(asesor|asesora|humano|persona|agente|operador|encargad[oa]|hablar con alguien|atiendame|atiendeme)\b/ },
  { intent: "code",     re: /\b(codigo|codigos|code|2fa|otp|verificacion|verificar|token|clave temporal|inicio de sesion|iniciar sesion)\b/ },
  { intent: "issue",    re: /(problema|no (me )?(funciona|sirve|entra|carga|abre|deja|puedo|reproduce|conecta)|se (me )?(cayo|cerro|bloqueo|desconecto|salio|vencio)|caid[ao]|suspendid[ao]|bloquead[ao]|\berror\b|falla|contrasena (incorrecta|mal|no)|clave (incorrecta|mal|no)|sin acceso|no tengo acceso|garantia|reclamo|pantallas?)/ },
  { intent: "products", re: /\b(precio|precios|cuanto|cuesta|costo|comprar|compro|venden|vendes|tienen|catalogo|productos?|planes|plan|disponible|stock|combo|combos|pagar|pago|yape|plin|oferta|promo|renovar|renovacion)\b/ },
  { intent: "done",     re: /\b(gracias|chao|adios|bye|eso es todo|eso era todo|ya esta|ya quedo|todo bien|solucionado)\b/ },
  { intent: "menu",     re: /^(hola|holi|buenas|buenos|buen dia|hey|alo|menu|inicio|opciones)\b/ },
];

function detectIntent(text: string): Intent | null {
  const n = normalize(text);
  for (const rule of INTENT_RULES) if (rule.re.test(n)) return rule.intent;
  return null;
}

/** "chat gpt" / "ChatGPT" / "netflix" escrito a mano → la opción de esa
 *  cuenta, si es la única que calza. */
function matchOptionByText(text: string, options: BotOption[]): BotOption | null {
  const squash = (s: string) => normalize(s).replace(/\s+/g, "");
  const t = squash(text);
  const hits = options.filter(o => {
    if (!o.id.includes(":") || o.id.endsWith(":other")) return false;
    const [platform = "", email = ""] = o.label.split(" · ");
    const p = squash(platform.replace(/^[^\p{L}\p{N}]+/u, ""));
    return (p.length >= 3 && t.includes(p)) || (email && t.includes(squash(email)));
  });
  return hits.length === 1 ? hits[0]! : null;
}

// ── Cuentas del cliente ──

function activeAccounts(phone: string): { platform: string; email: string }[] {
  const today = limaTodayISO();
  const seen = new Set<string>();
  return listAccountsByClientPhone(phone)
    .filter(a => !a.expiresAt || a.expiresAt >= today)
    .filter(a => {
      const key = a.platform.toUpperCase() + "|" + a.email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(a => ({ platform: a.platform, email: a.email }));
}

function accountLabel(platform: string, email: string): string {
  return `${platform} · ${email}`;
}

// ── Pasos ──

function showMenu(chat: Chat, text = "¿En qué más te puedo ayudar? 👇"): void {
  say(chat.id, text, MENU_OPTIONS);
  setBotState(chat.id, "menu", { ...chat.botContext, misses: 0 });
}

function showCodeAccounts(chat: Chat, phone: string): void {
  const codesAccounts = listClientCodesAccounts(phone);
  const autoIds = new Set<number>();
  const options: BotOption[] = [];
  for (const a of codesAccounts) {
    if (autoIds.has(a.accountId)) continue;
    autoIds.add(a.accountId);
    options.push({ id: `code:${a.accountId}`, label: accountLabel(a.platform, a.email) });
  }
  const autoKeys = new Set(codesAccounts.map(a => a.platform.toUpperCase() + "|" + a.email.toLowerCase()));
  for (const a of activeAccounts(phone)) {
    if (autoKeys.has(a.platform.toUpperCase() + "|" + a.email.toLowerCase())) continue;
    options.push({ id: `codeh:${a.platform}|${a.email}`, label: accountLabel(a.platform, a.email) });
  }

  if (options.length === 0) {
    say(chat.id, "No encontré cuentas activas en tu perfil 🤔. ¿Quieres que te atienda un asesor?", [HUMAN_OPTION, BACK_OPTION]);
    setBotState(chat.id, "menu", chat.botContext);
    return;
  }
  say(chat.id, "¿De cuál de tus cuentas necesitas el código? 👇", [...options, BACK_OPTION]);
  setBotState(chat.id, "code_pick", chat.botContext);
}

async function deliverTotp(chat: Chat, accountId: number, platform: string, email: string): Promise<void> {
  const expiresAt = new Date(Date.now() + TOTP_WINDOW_MS).toISOString();
  const message = addMessage(chat.id, "admin", {
    type: "bot_totp",
    text: JSON.stringify({
      text: "🔐 Aquí tienes tu código de verificación (2FA). Se actualiza solo cada 30 segundos y estará visible por 2 minutos.",
      accountId, platform, email, expiresAt,
    }),
  });
  emitChatEvent({ type: "message", chatId: chat.id, message });
  setBotState(chat.id, "totp_active", { ...chat.botContext, totpExpiresAt: expiresAt });
}

async function startCodeLookup(chat: Chat, phone: string, accountId: number): Promise<void> {
  const account = listClientCodesAccounts(phone).find(a => a.accountId === accountId);
  if (!account) {
    showMenu(chat, "Esa cuenta ya no figura como activa en tu perfil 🤔. ¿Te ayudo con otra cosa?");
    return;
  }

  if (account.totpSecret) {
    await deliverTotp(chat, accountId, account.platform, account.email);
    return;
  }

  const sourceId = getAccountCodeSource(accountId);
  if (!sourceId || sourceId === TOTP_SOURCE_ID) {
    handoff(chat, `Para tu cuenta de ${account.platform} el código lo envía un asesor 👤. Ya le avisé, te escribirá por aquí en breve 🙌`);
    return;
  }

  const lookups: Record<string, number> = { ...(chat.botContext.lookups ?? {}) };
  const done = lookups[accountId] ?? 0;
  if (done >= MAX_LOOKUPS) {
    handoff(chat, "Ya buscamos varias veces y no llegó un código nuevo 😕. Te paso con un asesor para revisarlo contigo 👤");
    return;
  }
  lookups[accountId] = done + 1;

  say(chat.id,
    `🔎 Buscando tu código de ${account.platform}…\n` +
    "Si aún no lo pediste, solicítalo ahora en la app o página (botón «Enviar código» al iniciar sesión). Puede tardar hasta 1 minuto ⏳");
  setBotState(chat.id, "code_searching", { ...chat.botContext, lookups, accountId });
  typing(chat.id, true);

  const exclude = skipsRepeatedCodes(sourceId) ? getLastSeenCodeForEmail(account.email) : null;
  let result: CodeLookupResult;
  try {
    result = await lookupCodeWithRetries(sourceId, account.email, exclude);
  } catch {
    result = { found: false, kind: null, value: null };
  }

  // Mientras buscaba pudo cerrarse el chat o tomarlo una persona.
  const current = getChatById(chat.id);
  if (!current || current.botState !== "code_searching") return;
  typing(chat.id, false);

  if (result.found && result.value) {
    const snippet = result.providerReceivedAt ? `Recibido: ${result.providerReceivedAt}` : "";
    saveIncomingCode({ accountId, code: result.value, snippet, source: "external" });
  }

  if (result.found && isAdminOnlyResult(sourceId, result)) {
    handoff(current, "Por seguridad, este tipo de código lo entrega un asesor 👤. Ya le avisé, te escribirá por aquí en breve 🙌");
    return;
  }

  if (!result.found || !result.value) {
    say(chat.id,
      "No llegó ningún código nuevo todavía 😕. Asegúrate de haberlo solicitado en la app y vuelve a intentarlo.",
      [{ id: `retry:${accountId}`, label: "🔄 Buscar de nuevo" }, HUMAN_OPTION, BACK_OPTION]);
    setBotState(chat.id, "code_result", current.botContext);
    return;
  }

  const message = addMessage(chat.id, "admin", {
    type: "bot_code",
    text: JSON.stringify({
      platform: account.platform, email: account.email,
      kind: result.kind, value: result.value, received: result.providerReceivedAt ?? "",
    }),
  });
  emitChatEvent({ type: "message", chatId: chat.id, message });
  say(chat.id, result.kind === "link"
    ? "Toca «✅ Confirmar ingreso» y luego vuelve a la app. ¿Funcionó?"
    : "¿Te funcionó el código?", [
    DONE_OPTION,
    { id: `retry:${accountId}`, label: "🔄 No sirvió, buscar otro" },
    HUMAN_OPTION,
  ]);
  setBotState(chat.id, "code_result", current.botContext);
}

function startIssue(chat: Chat, phone: string, text = "Lamento el inconveniente 😕. ¿Con cuál de tus cuentas es el problema? 👇"): void {
  const accounts = activeAccounts(phone);
  if (accounts.length === 0) {
    say(chat.id, "Cuéntame qué pasó y con qué cuenta (correo). También puedes mandar una foto 📷");
    setBotState(chat.id, "issue_describe", { ...chat.botContext, issueAccount: "" });
    return;
  }
  const options: BotOption[] = accounts.map(a => ({ id: `iss:${a.platform}|${a.email}`, label: accountLabel(a.platform, a.email) }));
  say(chat.id, text, [...options, { id: "iss:other", label: "Otra / no aparece" }, BACK_OPTION]);
  setBotState(chat.id, "issue_pick", chat.botContext);
}

function askIssueDescription(chat: Chat, issueAccount: string): void {
  say(chat.id,
    "Cuéntame qué pasó (por ejemplo: «se cayó la suscripción», «no me deja entrar», «la contraseña no funciona»). También puedes mandar una foto 📷");
  setBotState(chat.id, "issue_describe", { ...chat.botContext, issueAccount });
}

function registerIssue(chat: Chat, description: string): void {
  const account = String(chat.botContext.issueAccount ?? "");
  handoff(chat,
    "📝 Listo, registré tu caso" + (account ? ` (${account})` : "") + `: «${description.slice(0, 200)}».\n` +
    "Un asesor lo revisará y te responderá por aquí mismo lo antes posible 🙌");
}

function showProducts(chat: Chat): void {
  const seen = new Set<string>();
  const lines = listCatalogProducts(true)
    .filter(p => { if (seen.has(p.title)) return false; seen.add(p.title); return true; })
    .sort((a, b) => parseFloat(a.price) - parseFloat(b.price))
    .slice(0, 25)
    .map(p => `• ${p.title} — S/ ${p.price}`);

  const text =
    (lines.length ? "🛒 Esto es lo que tenemos:\n" + lines.join("\n") + "\n\n" : "") +
    "¿Cómo comprar?\n" +
    "1️⃣ Entra a «Catálogo» y toca el producto (o arma tu combo con descuento).\n" +
    "2️⃣ Paga por Yape el monto exacto que te indica.\n" +
    "3️⃣ Tu cuenta aparece sola en «Mis cuentas» apenas se confirma el pago ✅";
  say(chat.id, text, [DONE_OPTION, HUMAN_OPTION, BACK_OPTION]);
  setBotState(chat.id, "menu", { ...chat.botContext, misses: 0 });
}

async function handleOption(chat: Chat, phone: string, optionId: string): Promise<void> {
  if (optionId === "menu")     return showMenu(chat);
  if (optionId === "code")     return showCodeAccounts(chat, phone);
  if (optionId === "issue")    return startIssue(chat, phone);
  if (optionId === "products") return showProducts(chat);
  if (optionId === "human") {
    return handoff(chat, "👤 Listo, te paso con un asesor. Escribe tu consulta y te responderemos por aquí mismo lo antes posible 🙌");
  }
  if (optionId === "done") return closeWithThanks(chat.id, THANKS_TEXT);

  const [kind, rest = ""] = splitOnce(optionId, ":");
  if (kind === "code" || kind === "retry") return startCodeLookup(chat, phone, Number(rest));
  if (kind === "codeh") {
    const [platform = ""] = rest.split("|");
    return handoff(chat, `Para tu cuenta de ${platform} el código lo envía un asesor 👤. Ya le avisé, te escribirá por aquí en breve 🙌`);
  }
  if (kind === "iss") {
    if (rest === "other") return askIssueDescription(chat, "");
    const [platform = "", email = ""] = rest.split("|");
    return askIssueDescription(chat, accountLabel(platform, email));
  }
  showMenu(chat);
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
}

function lastOptions(chatId: number): BotOption[] {
  const msg = getLastMessageOfType(chatId, "bot_options");
  if (!msg) return [];
  try { return JSON.parse(msg.text).options ?? []; } catch { return []; }
}

async function handleText(chat: Chat, phone: string, text: string): Promise<void> {
  const state = chat.botState;
  const intent = detectIntent(text);

  if (state === "issue_describe") return registerIssue(chat, text);

  if (intent === "human") return handleOption(chat, phone, "human");

  if (state === "code_searching") {
    say(chat.id, "⏳ Sigo buscando tu código, dame un momento…");
    return;
  }
  if (state === "totp_active") {
    say(chat.id, "👆 Tu código 2FA está arriba y se actualiza solo. Cópialo antes de que expire.");
    return;
  }

  if (state === "code_pick" || state === "issue_pick") {
    const match = matchOptionByText(text, lastOptions(chat.id));
    if (match) return handleOption(chat, phone, match.id);
  }

  if (intent) {
    // En code_result, "gracias"/"listo" = funcionó.
    return handleOption(chat, phone, intent);
  }

  const misses = Number(chat.botContext.misses ?? 0) + 1;
  if (misses > MAX_MISUNDERSTOOD) {
    return handoff(chat, "No logré entenderte bien 😅. Te paso con un asesor, te responderá por aquí mismo 👤");
  }
  say(chat.id, "No te entendí bien 🤔. Elige una de estas opciones:", MENU_OPTIONS);
  setBotState(chat.id, "menu", { ...chat.botContext, misses });
}

// ── Entrada pública (rutas) ──

type BotInput =
  | { kind: "text"; text: string }
  | { kind: "media" }
  | { kind: "choice"; optionId: string };

/** Saluda en un chat recién abierto (sin mensajes todavía). */
export function startSupportBot(chatId: number): void {
  setBotState(chatId, "menu", {});
  say(chatId, GREETING_TEXT, MENU_OPTIONS);
}

/** El cliente escribió algo (o tocó un botón): responde tras una pausa
 *  corta con "escribiendo…", para que se sienta natural y su propio
 *  mensaje se pinte antes que la respuesta. `wasFirstMessage`: el chat
 *  no tenía nada antes (ej. lo cerraron y escribió de nuevo) — arranca
 *  el asistente ahí mismo. */
export function notifyCustomerMessage(chatId: number, phone: string, input: BotInput, wasFirstMessage = false): void {
  if (!isSupportBotEnabledFor(phone)) return;
  const chat = getChatById(chatId);
  if (!chat) return;
  if (chat.botState === null && wasFirstMessage) setBotState(chatId, "menu", {});
  else if (!chat.botState || chat.botState === "human") return;

  typing(chatId, true);
  setTimeout(() => {
    react(chatId, phone, input)
      .catch(err => console.error("⚠️ Asistente del chat:", err?.message))
      .finally(() => {
        const after = getChatById(chatId);
        if (after && after.botState !== "code_searching") typing(chatId, false);
      });
  }, REPLY_DELAY_MS);
}

async function react(chatId: number, phone: string, input: BotInput): Promise<void> {
  const chat = getChatById(chatId);
  if (!chat || !chat.botState || chat.botState === "human") return;

  if (input.kind === "choice") return handleOption(chat, phone, input.optionId);

  if (input.kind === "media") {
    if (chat.botState === "issue_describe") return registerIssue(chat, "📷 envió una foto/video");
    if (chat.botState === "code_searching" || chat.botState === "totp_active") return;
    return startIssue(chat, phone, "Vi tu archivo 👀. ¿Con cuál de tus cuentas es el problema?");
  }

  return handleText(chat, phone, input.text);
}

/**
 * El cliente tocó un botón del asistente. Verifica que la opción exista
 * en ESE mensaje, que sea el último del asistente y que no la haya
 * respondido ya (botones viejos quedan muertos). Guarda su elección como
 * mensaje del cliente — si eligió una cuenta con problema, como tarjeta de
 * cuenta verificada (igual que "Solicitar cuenta") para que el asesor la
 * vea completa — y dispara la respuesta.
 */
export function recordCustomerChoice(
  phone: string, messageId: number, optionId: string
): { ok: true; message: ChatMessage } | { ok: false; error: string } {
  const chat = findChatByPhone(phone);
  if (!chat || !chat.botState || chat.botState === "human") return { ok: false, error: "El asistente ya no está activo en este chat." };

  const botMsg = getMessageById(messageId);
  const latest = getLastMessageOfType(chat.id, "bot_options");
  if (!botMsg || botMsg.chatId !== chat.id || botMsg.type !== "bot_options" || latest?.id !== botMsg.id
      || hasCustomerMessageAfter(chat.id, botMsg.id)) {
    return { ok: false, error: "Esa opción ya no está disponible." };
  }

  let options: BotOption[] = [];
  try { options = JSON.parse(botMsg.text).options ?? []; } catch { /* sin opciones */ }
  const option = options.find(o => o.id === optionId);
  if (!option) return { ok: false, error: "Opción no válida." };

  let message: ChatMessage;
  const [kind, rest = ""] = splitOnce(option.id, ":");
  const [platform = "", email = ""] = rest.split("|");
  const account = kind === "iss" && rest !== "other" ? getActiveAccountForClient(phone, platform, email) : null;
  if (account) {
    message = addMessage(chat.id, "customer", {
      type: "account_reply",
      text: JSON.stringify({
        platform: account.platform, email: account.email, password: account.password,
        expiresAt: account.expiresAt, provider: account.provider || "",
      }),
    });
  } else {
    message = addMessage(chat.id, "customer", { type: "text", text: option.label });
  }
  emitChatEvent({ type: "message", chatId: chat.id, message });
  notifyCustomerMessage(chat.id, phone, { kind: "choice", optionId: option.id });
  return { ok: true, message };
}

/** Escribió una persona desde el panel: el asistente se hace a un lado. */
export function botStepAside(chatId: number): void {
  const chat = getChatById(chatId);
  if (!chat || !chat.botState || chat.botState === "human") return;
  setBotState(chatId, "human", {});
}

/** 2FA en vivo para la burbuja bot_totp — solo de SU chat, solo mientras
 *  no venza, y solo si la cuenta sigue siendo suya. El código nunca se
 *  guarda en el mensaje. */
export async function getBotTotpForCustomer(
  phone: string, messageId: number
): Promise<{ code: string; secondsRemaining: number; expiresInSeconds: number } | null> {
  const chat = findChatByPhone(phone);
  const msg = getMessageById(messageId);
  if (!chat || !msg || msg.chatId !== chat.id || msg.type !== "bot_totp") return null;

  let payload: { accountId?: number; expiresAt?: string } = {};
  try { payload = JSON.parse(msg.text); } catch { return null; }
  const expiresInMs = new Date(payload.expiresAt ?? 0).getTime() - Date.now();
  if (!(expiresInMs > 0)) return null;

  const account = listClientCodesAccounts(phone).find(a => a.accountId === payload.accountId);
  if (!account?.totpSecret) return null;

  try {
    const totp = await getCurrentTotp(account.totpSecret);
    return { ...totp, expiresInSeconds: Math.ceil(expiresInMs / 1000) };
  } catch (err: any) {
    console.error("⚠️ Clave 2FA inválida en la cuenta", payload.accountId, "-", err?.message);
    return null;
  }
}

// ── Barrido periódico (index.ts) ──

function sqliteUtcMs(value: string): number {
  return new Date(value.replace(" ", "T") + "Z").getTime();
}

export async function runSupportBotSweep(): Promise<void> {
  const now = Date.now();
  for (const chat of listBotChats()) {
    if (chat.botState === "totp_active") {
      const expiresAt = new Date(chat.botContext.totpExpiresAt ?? 0).getTime();
      if (now >= expiresAt) await closeWithThanks(chat.id, TOTP_DONE_TEXT);
      continue;
    }
    if (now - sqliteUtcMs(chat.updatedAt) >= INACTIVITY_MS) {
      await closeWithThanks(chat.id, INACTIVITY_TEXT);
    }
  }
}
