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
  TOTP_SOURCE_ID, isAdminOnlyResult, lookupCodeForClientWithRetries, skipsRepeatedCodes,
  type CodeLookupResult,
} from "./codes-lookup.service";
import { deleteChatMedia } from "./cloudinary.service";
import { limaTodayISO } from "./access.service";
import { getCurrentTotp } from "../utils/totp.util";
import { emitChatEvent } from "../utils/chat-events.util";
import { createCodeLink, countBotLinksToday } from "../db/code-links.repository";

// ─────────────────────────────────────────────────────────────
// ASISTENTE AUTOMÁTICO DEL CHAT DE SOPORTE — "cerebro" propio, sin IA ni
// API externa: reglas + palabras clave + botones. Atiende lo repetitivo
// (códigos, 2FA, dudas de compra) y arma el caso para una persona cuando
// es un problema real con la cuenta.
//
// Estados (support_chats.bot_state):
//   menu            → saludó / espera que elija qué necesita
//   code_pick       → eligiendo de qué cuenta quiere el código
//   code_device     → Netflix: eligiendo dispositivo / guiado para pedir el código
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

// En producción para todos los clientes. Para volver a limitarlo, poner
// BOT_FOR_EVERYONE = false y llenar BOT_PHONES (últimos 9 dígitos).
const BOT_FOR_EVERYONE = true;
const BOT_PHONES: string[] = [];

const INACTIVITY_MS      = 5 * 60 * 1000;
const TOTP_WINDOW_MS     = 2 * 60 * 1000;
const REPLY_DELAY_MS     = 900;   // pausa "escribiendo…" antes de responder
const MAX_LOOKUPS        = 3;     // búsquedas de código por cuenta, por chat
const USE_CODE_LINKS     = true;  // códigos por link temporal (visor) en vez de buscar en el chat
const MAX_CODE_LINKS_PER_DAY = 2; // links que el cliente puede generar por día (luego, asesor)
const CODE_LINK_MINUTES  = 5;
const CODE_LINK_MINUTES_SLOW = 8; // Disney+: el correo tarda hasta ~4 min
const MAX_MISUNDERSTOOD  = 2;     // mensajes sin entender antes de pasar a una persona

export function isSupportBotEnabledFor(phone: string): boolean {
  return BOT_FOR_EVERYONE || BOT_PHONES.includes(phone.replace(/\D/g, "").slice(-9));
}

type BotOption = { id: string; label: string; url?: string };

// Variedad: el asistente no repite siempre la misma frase.
function pick<T>(options: readonly T[]): T {
  return options[Math.floor(Math.random() * options.length)]!;
}

/** "Recibir mi código" solo aparece si el cliente tiene alguna cuenta
 *  con códigos automáticos — si no, no hay nada que entregarle. */
// El asistente ya no entrega códigos (están en «Códigos») ni vende: solo
// atiende problemas con cuentas. Para hablar con una persona → WhatsApp.
// El cliente no escribe: solo elige. Cada reporte termina en WhatsApp con
// el mensaje ya armado (cuenta + problema).
const PROBLEMS: Record<string, { label: string; text: string }> = {
  nosub: { label: "📺 Mi cuenta dice «sin suscripción»", text: "dice sin suscripción" },
  login: { label: "🔒 No puedo ingresar a mi cuenta",   text: "no puedo ingresar" },
  other: { label: "⚠️ Otro problema con mi cuenta",       text: "tiene otro problema" },
};
const SUPPORT_WA = "51963081436";

function menuOptions(phone: string): BotOption[] {
  return [
    ...Object.entries(PROBLEMS).map(([id, p]) => ({ id: `rep:${id}`, label: p.label })),
    ...(listClientCodesAccounts(phone).length ? [{ id: "opencodes", label: "🔑 Necesito un código" }] : []),
  ];
}

function whatsappUrl(text: string): string {
  return "https://wa.me/" + SUPPORT_WA + "?text=" + encodeURIComponent(text);
}

function showReportAccounts(chat: Chat, phone: string, problem: string): void {
  const p = PROBLEMS[problem];
  if (!p) return showMenu(chat);
  const accounts = activeAccounts(phone);
  if (accounts.length <= 1) return finishReport(chat, phone, problem, accounts[0] ?? null);
  say(chat.id, "¿Con cuál de tus cuentas? 👇", [
    ...accounts.slice(0, 12).map((a, i) => ({ id: `rpa:${problem}|${i}`, label: accountLabel(a.platform, a.email) })),
    BACK_OPTION,
  ]);
  setBotState(chat.id, "menu", { ...chat.botContext, misses: 0 });
}

function finishReport(chat: Chat, phone: string, problem: string, account: { platform: string; email: string } | null): void {
  const p = PROBLEMS[problem];
  if (!p) return showMenu(chat);
  const local = phone.replace(/\D/g, "").slice(-9);
  const text = account
    ? `Hola, mi cuenta de ${account.platform} (${account.email}) ${p.text}. Mi número: ${local}`
    : `Hola, mi cuenta ${p.text}. Mi número: ${local}`;
  say(chat.id, "Listo 🙌. Toca el botón y te abrimos WhatsApp con tu reporte ya escrito; un asesor te atiende por ahí.", [
    { id: "whatsapp", label: "💬 Enviar reporte por WhatsApp", url: whatsappUrl(text) },
    BACK_OPTION,
  ]);
  setBotState(chat.id, "menu", { ...chat.botContext, misses: 0 });
}
const WHATSAPP_OPTION: BotOption = { id: "whatsapp", label: "💬 Abrir WhatsApp", url: "https://wa.me/51963081436?text=" + encodeURIComponent("Hola, necesito ayuda 🙏") };

function offerWhatsapp(chat: Chat, text = "Con gusto 😊. Un asesor te atiende por WhatsApp: toca el botón y te abrimos el chat 👇"): void {
  say(chat.id, text, [WHATSAPP_OPTION, BACK_OPTION]);
  setBotState(chat.id, "menu", { ...chat.botContext, misses: 0 });
}
const BACK_OPTION: BotOption  = { id: "menu",  label: "⬅️ Volver al menú" };
const HUMAN_OPTION: BotOption = { id: "human", label: "👤 Hablar con un asesor" };
const DONE_OPTION: BotOption  = { id: "done",  label: "✅ Listo, gracias" };

const GREETINGS = [
  "¡Hola! 👋 Soy Manguito, el asistente de Liordark 🥭\n¿Qué problema tiene tu cuenta? Elige una opción 👇",
  "¡Hola! 😊 Soy Manguito 🥭. Cuéntame qué pasa con tu cuenta eligiendo una opción 👇",
];
const THANKS = [
  "¡Fue un gusto ayudarte! 🥭 Gracias por confiar en Liordark. Cierro este chat por ahora; cuando necesites algo, aquí estaremos para ti 💛",
  "¡Muchas gracias por escribirnos! 😊 Espero haberte ayudado. Cierro este chat, pero puedes volver a escribirnos cuando quieras 🥭",
  "¡Genial, me alegra haberte ayudado! 🙌 Gracias por preferir Liordark 🥭. Cierro este chat; cualquier cosa, aquí estamos.",
];
const INACTIVITY_TEXT =
  "Parece que ya no estás por aquí 🙂. Cierro este chat por ahora, ¡gracias por escribirnos! 🥭 Espero haberte ayudado; si necesitas algo más, vuelve a escribirnos cuando quieras.";
const TOTP_DONE_TEXT =
  "⏱️ Tu código 2FA ya expiró. ¡Gracias por confiar en Liordark! 🥭 Espero haberte ayudado; cierro este chat. Si necesitas otro código, escríbenos cuando quieras.";
const HANDOFF_TEXTS = [
  "👤 ¡Claro que sí! Ya le aviso a un asesor para que te atienda personalmente. Escribe tu consulta con confianza y te responderemos por aquí mismo lo antes posible 🙌",
  "👤 ¡Con gusto! Te comunico con una persona de nuestro equipo. Déjanos tu consulta aquí y en breve te responden 😊",
];

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

function showMenu(chat: Chat, text = pick(["¿En qué más te puedo ayudar? 😊", "¿Qué más necesitas? Aquí sigo para ayudarte 👇", "Cuéntame, ¿en qué más te ayudo? 🥭"])): void {
  say(chat.id, text, menuOptions(chat.clientPhone));
  setBotState(chat.id, "menu", { ...chat.botContext, misses: 0 });
}

// Los códigos ya no se entregan por el chat: el cliente los ve él mismo en
// la sección «Códigos» de liordark.com (3 consultas por cuenta al día).
const OPEN_CODES_OPTION: BotOption = { id: "opencodes", label: "🔑 Ir a Códigos" };

function showCodeAccounts(chat: Chat, phone: string): void {
  if (listClientCodesAccounts(phone).length === 0) {
    say(chat.id,
      "Por ahora tus cuentas no tienen entrega automática de códigos 🙏. Si necesitas ayuda con algo más, con gusto te atiendo.",
      [HUMAN_OPTION, BACK_OPTION]);
    setBotState(chat.id, "menu", chat.botContext);
    return;
  }
  say(chat.id,
    "¡Claro! 🔑 Ahora tus códigos los ves tú mismo, al instante, en la sección «Códigos» de tu cuenta: " +
    "eliges la cuenta y te mostramos el código apenas llega (revisamos cada 30 segundos). " +
    "Toca el botón para ir 👇",
    [OPEN_CODES_OPTION, HUMAN_OPTION, BACK_OPTION]);
  setBotState(chat.id, "menu", { ...chat.botContext, misses: 0 });
}

// ─────────────────────────────────────────────────────────────
// NETFLIX — antes de buscar el código se pregunta en qué dispositivo va a
// iniciar sesión, para guiarlo bien: en celular/PC se pide «Usar un código
// de inicio de sesión» (4 dígitos); en la TV no se puede pedir directo —
// primero inicia sesión en el celular o PC y luego escanea el QR de la TV.
// Recién cuando el cliente toca «✅ Ya lo pedí» se consulta al proveedor
// (así no se busca antes de que el código exista).
// ─────────────────────────────────────────────────────────────

function findCodesAccount(phone: string, accountId: number) {
  return listClientCodesAccounts(phone).find(a => a.accountId === accountId) ?? null;
}

function askLoginDevice(chat: Chat, phone: string, accountId: number): Promise<void> | void {
  const account = findCodesAccount(phone, accountId);
  if (!account || account.totpSecret || !/netflix/i.test(account.platform)) {
    return startCodeLookup(chat, phone, accountId);
  }
  say(chat.id, "¿En qué dispositivo vas a iniciar sesión? 👇", [
    { id: `dev:${accountId}|movil`, label: "📱 Celular o tablet" },
    { id: `dev:${accountId}|pc`,    label: "💻 Laptop o PC" },
    { id: `dev:${accountId}|tv`,    label: "📺 TV" },
    BACK_OPTION,
  ]);
  setBotState(chat.id, "code_device", { ...chat.botContext, accountId });
}

function guideLoginDevice(chat: Chat, phone: string, accountId: number, device: string): void {
  const account = findCodesAccount(phone, accountId);
  if (!account) {
    showMenu(chat, "Esa cuenta ya no figura como activa en tu perfil 🤔. ¿Te ayudo con otra cosa?");
    return;
  }
  const ready = { id: `go:${accountId}`, label: "✅ Ya lo pedí" };

  if (device === "tv") {
    say(chat.id,
      "📺 En la TV no se puede pedir el código directamente. Hazlo así:\n" +
      "1️⃣ Primero inicia sesión en tu celular (app de Netflix) o en tu laptop/PC con el código de 4 dígitos que te doy aquí.\n" +
      "2️⃣ Luego, en la TV elige «Iniciar sesión con el celular» y escanea el código QR con ese celular ✅\n\n" +
      "¿Dónde vas a iniciar sesión primero?", [
        { id: `dev:${accountId}|movil`, label: "📱 En mi celular" },
        { id: `dev:${accountId}|pc`,    label: "💻 En mi laptop o PC" },
        BACK_OPTION,
      ]);
    setBotState(chat.id, "code_device", { ...chat.botContext, accountId });
    return;
  }

  const where = device === "pc"
    ? "Entra a netflix.com en tu navegador"
    : "Abre la app de Netflix";
  say(chat.id,
    `${device === "pc" ? "💻" : "📱"} ${where} → toca «Iniciar sesión» → escribe el correo ${account.email} → ` +
    "elige «Usar un código de inicio de sesión».\n" +
    "Cuando Netflix te diga que envió el código, toca «✅ Ya lo pedí» y te paso el link para ver tu código de 4 dígitos 🔢", [ready, BACK_OPTION]);
  setBotState(chat.id, "code_device", { ...chat.botContext, accountId, device });
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

  // Visor de códigos: en vez de buscar acá, se le da un link de 5 min
  // (liordark.com/codigo/…) donde ve el código de SU cuenta y puede
  // «Actualizar» hasta que llegue. Máximo 2 links al día; luego, asesor.
  if (USE_CODE_LINKS) {
    const usedToday = countBotLinksToday(phone);
    if (usedToday >= MAX_CODE_LINKS_PER_DAY) {
      handoff(chat, `Hoy ya generaste ${MAX_CODE_LINKS_PER_DAY} links de código 🙏. Te paso con un asesor para ayudarte 👤`);
      return;
    }
    // Disney+ tarda hasta ~4 min en mandar el correo: link más largo y
    // aviso de no pedir otro código mientras tanto.
    const slow = /disney|netflix_sin_opciones|netflix_con_opciones/i.test(sourceId) || /disney/i.test(account.platform);
    const minutes = slow ? CODE_LINK_MINUTES_SLOW : CODE_LINK_MINUTES;
    const link = createCodeLink({
      accountId, email: account.email, sourceId, clientPhone: phone, createdBy: "bot", minutes,
    });
    const left = MAX_CODE_LINKS_PER_DAY - usedToday - 1;
    say(chat.id,
      `🔑 Abre este link para ver tu código de ${account.platform}:\n` +
      `https://liordark.com/codigo/${link.token}\n\n` +
      (slow
        ? `⏳ El correo de ${account.platform} puede tardar hasta 4 minutos en llegar. Pide el código UNA sola vez y espera en esa página: se actualiza sola. ` +
          "Si pides otro, el anterior deja de servir.\n"
        : "Si el código aún no aparece, toca «Actualizar» en esa página. ") +
      `El link vence en ${minutes} minutos` +
      (left > 0 ? ` (hoy te queda ${left} link más).` : " (es tu último link de hoy)."),
      [DONE_OPTION, HUMAN_OPTION]);
    setBotState(chat.id, "code_result", { ...chat.botContext, accountId });
    return;
  }

  const lookups: Record<string, number> = { ...(chat.botContext.lookups ?? {}) };
  const done = lookups[accountId] ?? 0;
  if (done >= MAX_LOOKUPS) {
    handoff(chat, "Ya buscamos varias veces y no llegó un código nuevo 😕. Te paso con un asesor para revisarlo contigo 👤");
    return;
  }
  lookups[accountId] = done + 1;

  // Netflix: solo se entrega el código de inicio de sesión de 4 dígitos.
  // En la TV no se puede pedir directo — se recuerda el paso previo.
  const isNetflix = /netflix/i.test(account.platform);
  say(chat.id, isNetflix
    ? "🔎 Buscando tu código de inicio de sesión de 4 dígitos… Puede tardar hasta 1 minuto ⏳"
    : `🔎 Buscando tu código de ${account.platform}…\n` +
      "Si aún no lo pediste, solicítalo ahora en la app o página (botón «Enviar código» al iniciar sesión). Puede tardar hasta 1 minuto ⏳");
  setBotState(chat.id, "code_searching", { ...chat.botContext, lookups, accountId });
  typing(chat.id, true);

  const exclude = skipsRepeatedCodes(sourceId) ? getLastSeenCodeForEmail(account.email) : null;
  let result: CodeLookupResult;
  try {
    result = await lookupCodeForClientWithRetries(sourceId, account.email, exclude);
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
    handoff(current, result.kind === "link"
      ? "El enlace de acceso lo envía un asesor 👤. Ya le avisé, te escribirá por aquí en breve 🙌"
      : "Por seguridad, este tipo de código lo entrega un asesor 👤. Ya le avisé, te escribirá por aquí en breve 🙌");
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

// ── Ventas: primero qué servicio quiere, luego una sola propuesta con sus
// beneficios y un botón que abre la compra en la tienda (sin listas
// largas de golpe). ──

const PRODUCTS_PER_PAGE = 8;

const PLATFORM_EMOJI: [RegExp, string][] = [
  [/netflix/i, "🎬"], [/disney/i, "🏰"], [/prime|amazon/i, "📦"], [/hbo|max/i, "🎞️"],
  [/spotify/i, "🎵"], [/youtube/i, "▶️"], [/crunchy/i, "🍥"], [/chatgpt|gpt/i, "🤖"],
  [/canva/i, "🎨"], [/paramount/i, "⛰️"], [/apple/i, "🍎"], [/gemini/i, "✨"],
];
function platformEmoji(platform: string): string {
  return PLATFORM_EMOJI.find(([re]) => re.test(platform))?.[1] ?? "⭐";
}

function catalogProducts() {
  const seen = new Set<string>();
  return listCatalogProducts(true)
    .filter(p => { if (seen.has(p.platform)) return false; seen.add(p.platform); return true; })
    .sort((a, b) => a.title.localeCompare(b.title, "es"));
}

function showProducts(chat: Chat, page = 1): void {
  const products = catalogProducts();
  if (products.length === 0) {
    handoff(chat, "En este momento estamos actualizando nuestro catálogo 🙏. Te comunico con un asesor para ayudarte con tu compra 👤");
    return;
  }
  const from = (page - 1) * PRODUCTS_PER_PAGE;
  const pageItems = products.slice(from, from + PRODUCTS_PER_PAGE);
  const options: BotOption[] = pageItems.map(p => ({ id: `buy:${p.platform}`, label: `${platformEmoji(p.platform)} ${p.title}` }));
  if (from + PRODUCTS_PER_PAGE < products.length) options.push({ id: `products:${page + 1}`, label: "➕ Ver más servicios" });
  if (products.length >= 2) options.push({ id: "buycombo", label: "🎁 Armar mi combo (con descuento)" });
  options.push(HUMAN_OPTION);

  say(chat.id, page > 1 ? "Aquí tienes más opciones 👇" : pick([
    "¡Qué bueno que quieras unirte! 🎉 ¿Qué servicio te gustaría tener?",
    "¡Me encanta! 😍 Cuéntame, ¿qué servicio te interesa?",
    "¡Genial! 🙌 ¿Cuál de nuestros servicios te gustaría disfrutar?",
  ]), options);
  setBotState(chat.id, "menu", { ...chat.botContext, misses: 0 });
}

function showPitch(chat: Chat, platform: string): void {
  const product = catalogProducts().find(p => p.platform === platform);
  if (!product) return showProducts(chat);

  const opener = pick(["¡Excelente elección! 😍", "¡Buenísima opción! 🙌", "¡Gran elección! ✨"]);
  say(chat.id,
    `${opener} ${platformEmoji(product.platform)} ${product.title}\n` +
    `💰 Solo S/ ${product.price}${product.hasProfiles ? " — con tu propio perfil" : ""}\n` +
    "⚡ Activación inmediata apenas se confirma tu pago\n" +
    "🛡️ Garantía incluida durante todo tu servicio\n" +
    "💬 Soporte directo por este mismo chat\n" +
    "¿Te lo activamos ahora? 👇",
    [
      { id: `buynow:${product.platform}`, label: "🛒 ¡Sí, quiero comprarlo!" },
      { id: "products", label: "🔙 Ver otros servicios" },
      { id: "human", label: "👤 Tengo una duda" },
    ]);
  setBotState(chat.id, "menu", { ...chat.botContext, misses: 0 });
}

function confirmPurchase(chat: Chat, platform: string): void {
  const product = catalogProducts().find(p => p.platform === platform);
  say(chat.id,
    `¡Perfecto, gran decisión! 🎉 Te abrí la compra de ${product ? product.title : "tu servicio"}.\n` +
    `Solo paga${product ? ` S/ ${product.price}` : ""} por Yape (el monto exacto) y tu cuenta aparecerá al instante en «Mis cuentas» ✅\n` +
    "Si te surge cualquier duda, aquí estoy para ayudarte 😊",
    [DONE_OPTION, HUMAN_OPTION]);
  setBotState(chat.id, "menu", { ...chat.botContext, misses: 0 });
}

function confirmCombo(chat: Chat): void {
  say(chat.id,
    "¡Genial! 🎁 Te abrí el armador de combos: elige 2 o más servicios y el descuento se aplica solito.\n" +
    "Pagas por Yape y tus cuentas aparecen al instante en «Mis cuentas» ✅, todas con garantía incluida 🛡️",
    [DONE_OPTION, HUMAN_OPTION]);
  setBotState(chat.id, "menu", { ...chat.botContext, misses: 0 });
}

/** "quiero netflix" → el producto de esa plataforma, si es el único que calza. */
function matchProductByText(text: string): string | null {
  const n = normalize(text);
  const words = new Set(n.split(" "));
  const squashed = n.replace(/\s+/g, "");
  const generic = new Set(["video", "plus", "premium", "perfil", "cuenta", "cuentas", "plan", "music", "basic", "standard"]);
  const hits = catalogProducts().filter(p => {
    const plat = normalize(p.platform);
    if (squashed.includes(plat.replace(/\s+/g, ""))) return true;
    return plat.split(" ").some(w => w.length >= 3 && !generic.has(w) && words.has(w));
  });
  return hits.length === 1 ? hits[0]!.platform : null;
}

async function handleOption(chat: Chat, phone: string, optionId: string): Promise<void> {
  if (optionId === "menu")     return showMenu(chat);
  if (optionId === "code")     return showCodeAccounts(chat, phone);
  if (optionId === "opencodes") {
    say(chat.id, "¡Listo! Te abrí «Códigos» 🔑. Si necesitas algo más, aquí estoy 😊", [DONE_OPTION, BACK_OPTION]);
    setBotState(chat.id, "menu", { ...chat.botContext, misses: 0 });
    return;
  }
  if (optionId === "buycombo") return confirmCombo(chat);
  if (optionId === "human" || optionId === "issue") return offerWhatsapp(chat);
  if (optionId === "whatsapp") {
    say(chat.id, "¡Listo! Te abrí WhatsApp 💬. Si no se abrió, escríbenos al +51 963 081 436.", [DONE_OPTION, BACK_OPTION]);
    setBotState(chat.id, "menu", { ...chat.botContext, misses: 0 });
    return;
  }
  if (optionId === "products" || optionId === "opencatalog") {
    if (optionId === "opencatalog") {
      say(chat.id, "¡Listo! Te abrí el Catálogo 🛒. Ahí ves precios y compras al instante con Yape.", [DONE_OPTION, BACK_OPTION]);
    } else {
      say(chat.id, "Puedes ver todos los precios y comprar al instante en el Catálogo de la tienda 🛒", [{ id: "opencatalog", label: "🛒 Ir al Catálogo" }, BACK_OPTION]);
    }
    setBotState(chat.id, "menu", { ...chat.botContext, misses: 0 });
    return;
  }
  if (optionId === "done") return closeWithThanks(chat.id, pick(THANKS));

  const [kind, rest = ""] = splitOnce(optionId, ":");
  if (kind === "rep") return showReportAccounts(chat, phone, rest);
  if (kind === "rpa") {
    const [problem = "", idx = ""] = rest.split("|");
    return finishReport(chat, phone, problem, activeAccounts(phone)[Number(idx)] ?? null);
  }
  // Botones viejos de códigos (mensajes anteriores): también van a «Códigos».
  if (kind === "code" || kind === "dev" || kind === "go" || kind === "retry") return showCodeAccounts(chat, phone);
  if (kind === "products") return showProducts(chat, Math.max(1, Number(rest) || 1));
  if (kind === "buy")      return showPitch(chat, rest);
  if (kind === "buynow")   return confirmPurchase(chat, rest);
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

  if (state === "code_device") {
    const id = Number(chat.botContext.accountId);
    const t = normalize(text);
    if (/\b(ya|listo|lo pedi|pedido|enviado|me llego)\b/.test(t) && chat.botContext.device) return handleOption(chat, phone, `go:${id}`);
    if (/\b(tv|tele|televisor|television|smart)\b/.test(t)) return handleOption(chat, phone, `dev:${id}|tv`);
    if (/\b(laptop|pc|computadora|compu|navegador|notebook)\b/.test(t)) return handleOption(chat, phone, `dev:${id}|pc`);
    if (/\b(celular|cel|telefono|movil|tablet|ipad|iphone|android)\b/.test(t)) return handleOption(chat, phone, `dev:${id}|movil`);
    const match = matchOptionByText(text, lastOptions(chat.id));
    if (match) return handleOption(chat, phone, match.id);
  }

  if (state === "code_pick" || state === "issue_pick") {
    const match = matchOptionByText(text, lastOptions(chat.id));
    if (match) return handleOption(chat, phone, match.id);
  }

  // "quiero netflix" / "cuánto cuesta disney" → directo a esa propuesta.
  if (intent === "products" || intent === null || intent === "menu") {
    const platform = matchProductByText(text);
    if (platform && (intent === "products" || /\b(quiero|comprar|precio|cuanto|cuesta|tienen|venden)\b/.test(normalize(text)))) {
      return handleOption(chat, phone, "products");
    }
  }

  if (intent) {
    // En code_result, "gracias"/"listo" = funcionó.
    return handleOption(chat, phone, intent);
  }

  const misses = Number(chat.botContext.misses ?? 0) + 1;
  if (misses > MAX_MISUNDERSTOOD) {
    return offerWhatsapp(chat, "Disculpa, no quiero hacerte perder tiempo 😅. Un asesor te atiende por WhatsApp: toca el botón 👇");
  }
  say(chat.id, pick([
    "Disculpa, no logré entenderte del todo 🤔. ¿Me ayudas eligiendo una de estas opciones?",
    "Uy, creo que no te entendí bien 😅. Toca una de estas opciones y te ayudo al toque:",
  ]), menuOptions(phone));
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
  const chat = getChatById(chatId);
  say(chatId, pick(GREETINGS), chat ? menuOptions(chat.clientPhone) : []);
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
  if (chat.botState === "blocked") return; // número bloqueado: no se atiende
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
