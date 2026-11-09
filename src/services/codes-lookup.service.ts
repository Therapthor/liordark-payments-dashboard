import axios from "axios";
import { AsyncLocalStorage } from "async_hooks";
import { env } from "../config/env";

// ─────────────────────────────────────────────────────────────
// CÓDIGOS — fuentes externas. El proveedor comparte páginas donde se
// consulta el último código que llegó a un correo (no tenemos acceso al
// correo en sí, solo a esta página). Cada "fuente" sabe cómo consultar
// una de esas páginas; access_accounts.code_source dice cuál usar para
// cada cuenta puntual (ver codes.repository.ts).
//
// Los códigos de 6 dígitos son más sensibles (cambio de datos de la
// cuenta) — por eso nunca se entregan al cliente acá, solo quedan
// disponibles para el admin (ver store.routes.ts / access.routes.ts).
// ─────────────────────────────────────────────────────────────

export type CodeLookupResult = {
  found: boolean;
  // "code" = dígitos (4 o 6); "link" = enlace de inicio de sesión.
  kind:  "code" | "link" | null;
  value: string | null;
  // Para "PallyStore con opciones": cuál sub-acción respondió
  // esto — algunas son sensibles aunque la cuenta esté configurada con
  // la fuente "normal" (ver CON_OPCIONES_ACTIONS / isSensitiveResult).
  sourceAction?: string;
  // Hora en que le llegó el correo al proveedor, tal como la muestra su
  // página (ej. "2026-11-02 23:04:51") — solo las fuentes que la dan.
  providerReceivedAt?: string;
  // Visor: el correo tal cual lo muestra el proveedor (HTML) y su asunto.
  // Nunca se manda al cliente sin pasar por sanitizeEmailHtml.
  emailHtml?: string;
  subject?: string;
  // Lo que dice la página del proveedor cuando no hay nada (ej. «Aún no
  // hay códigos recientes») — para saber QUÉ pasó, no solo que no hubo.
  providerMessage?: string;
  // La sesión con el proveedor había vencido y se volvió a entrar sola.
  relogged?: boolean;
  // El proveedor marca el correo como vencido (latinocol: «Caducado»).
  expired?: boolean;
  // Fuentes que listan TODOS los correos recientes (latinocol): la lista
  // completa, para la bandeja del panel. ref = id del correo en el proveedor.
  items?: ListedEmail[];
  providerRef?: string;
};

export type ListedEmail = { ref: string; subject: string; receivedAt?: string; expired?: boolean };

// ─────────────────────────────────────────────────────────────
// ERRORES DEL PROVEEDOR — antes cualquier falla se tragaba y se veía como
// «todavía no llega». Ahora se distingue: sesión, error del proveedor
// (con el mensaje que muestra su página), red/tiempo agotado.
// ─────────────────────────────────────────────────────────────

export type ProviderProblemKind = "session" | "provider" | "network" | "timeout";

export class ProviderError extends Error {
  constructor(public kind: ProviderProblemKind, message: string) { super(message); }
}

/** Cualquier error de una consulta → tipo + mensaje entendible. */
export function describeLookupError(err: any): { kind: ProviderProblemKind; message: string } {
  if (err instanceof ProviderError) return { kind: err.kind, message: err.message };
  const code = String(err?.code || "");
  const status = Number(err?.response?.status || 0);
  if (code === "ECONNABORTED" || code === "ETIMEDOUT" || /timeout/i.test(String(err?.message))) {
    return { kind: "timeout", message: "El proveedor no respondió a tiempo." };
  }
  if (status >= 500) return { kind: "provider", message: `La página del proveedor está caída (error ${status}).` };
  if (status === 403 || status === 429) return { kind: "provider", message: `El proveedor bloqueó la consulta (error ${status}).` };
  if (status) return { kind: "provider", message: `El proveedor respondió error ${status}.` };
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|socket hang up|EHOSTUNREACH/i.test(code + " " + err?.message)) {
    return { kind: "network", message: "No se pudo conectar con la página del proveedor." };
  }
  return { kind: "provider", message: String(err?.message || "Error desconocido del proveedor.").slice(0, 200) };
}

/** Texto visible de una página (sin etiquetas), recortado. */
function pageText(html: string, max = 200): string {
  return decodeHtmlEntities(String(html || "")
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim().slice(0, max);
}

/** Mensaje destacado de una página (alertas / errores), o null. */
function pageAlert(html: string): string | null {
  const m = String(html || "").match(/<(div|p|span|strong)\b[^>]*class\s*=\s*["'][^"']*\b(alert|error|danger|warning|mensaje|message|aviso)\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i);
  const text = m ? pageText(m[3] ?? "", 200) : "";
  return text || null;
}

// ── Contexto de cada consulta (quién la pidió) + observador ──
// El «cerebro» (codes-brain.service.ts) se suscribe para registrar cada
// consulta, guardar lo que llega en la bandeja y medir la salud de cada
// fuente — sin que cada lugar que consulta tenga que acordarse.

export type LookupOrigin = "cliente" | "panel" | "busqueda" | "asistente" | "vigilante";
export type LookupContext = { origin: LookupOrigin; accountId?: number | null };
export type LookupEvent = {
  sourceId: string; email: string; ctx: LookupContext; ms: number;
  result?: CodeLookupResult; error?: { kind: ProviderProblemKind; message: string };
};

const lookupContext = new AsyncLocalStorage<LookupContext>();
const lookupObservers: ((e: LookupEvent) => void)[] = [];

export function withLookupContext<T>(ctx: LookupContext, fn: () => Promise<T>): Promise<T> {
  return lookupContext.run(ctx, fn);
}

export function onLookup(fn: (e: LookupEvent) => void): void {
  lookupObservers.push(fn);
}

async function observed(sourceId: string, email: string, run: () => Promise<CodeLookupResult>): Promise<CodeLookupResult> {
  const ctx = lookupContext.getStore() ?? { origin: "panel" };
  const started = Date.now();
  const notify = (e: Omit<LookupEvent, "sourceId" | "email" | "ctx" | "ms">) => {
    for (const fn of lookupObservers) {
      try { fn({ sourceId, email, ctx, ms: Date.now() - started, ...e }); } catch (err: any) { console.error("⚠️ observador de códigos:", err?.message); }
    }
  };
  try {
    const result = await run();
    notify({ result });
    return result;
  } catch (err) {
    notify({ error: describeLookupError(err) });
    throw err;
  }
}

const NOT_FOUND_MARKER = "Aún no hay códigos recientes";

/**
 * Página de resultado de codes.pally.digital (formato confirmado con una
 * respuesta real, nov-2026): "Consulta Satisfactoria", "Asunto: Netflix ·
 * Link Inicio Sesión", "Fecha de recepción: 04/11/2026 18:33", y el cuerpo
 * en .email-body-wrapper → .codigo-resumen con un botón
 * <a href='https://www.netflix.com/…'> "Iniciar sesión en Netflix" (el
 * href viene con &amp; — se decodifica, si no el enlace llega roto) o el
 * código en texto. null = la página no tiene ese formato (se usa el
 * extractor anterior de respaldo).
 */
/** El <div class="…cls…"> completo (con sus divs internos balanceados). */
function findDivByClass(html: string, cls: string): { start: number; end: number } | null {
  const open = new RegExp(`<div\\b[^>]*class\\s*=\\s*["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>`, "i").exec(html);
  if (!open) return null;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = open.index;
  let depth = 0;
  for (let t = tags.exec(html); t; t = tags.exec(html)) {
    if (t[0][1] === "/") {
      depth--;
      if (depth === 0) return { start: open.index, end: t.index + t[0].length };
    } else if (!t[0].endsWith("/>")) {
      depth++;
    }
  }
  return { start: open.index, end: html.length };
}

export function parsePallyResultPage(html: string, preferCode = false): CodeLookupResult | null {
  // El recuadro del correo (la clase también aparece antes en el <style>
  // de la página: por eso se busca el <div> con esa clase, no el texto).
  const box = findDivByClass(html, "email-body-wrapper");
  if (!box) return null;
  const formStart = html.indexOf("<form", box.start);
  const end = formStart !== -1 && formStart < box.end ? formStart : box.end;
  const wrapper = html.slice(box.start, end);

  const received = html.match(/Fecha de recepci[oó]n:<\/strong>\s*([^<]+)/i)?.[1]?.trim();
  const subject  = html.match(/Asunto:<\/strong>\s*([^<]+)/i)?.[1]?.trim();
  const extra = {
    ...(received ? { providerReceivedAt: received } : {}),
    ...(subject ? { subject: decodeHtmlEntities(subject) } : {}),
    // Si Pally trae el correo original en un <iframe srcdoc>, se muestra su
    // contenido (el visor quita los iframes por seguridad).
    emailHtml: wrapper.replace(/<iframe\b[^>]*\ssrcdoc\s*=\s*"([^"]*)"[^>]*>(?:\s*<\/iframe>)?/gi,
      (_m, src: string) => `<div class="correo-original">${decodeHtmlEntities(src)}</div>`),
  };

  // Código: número de 4 a 8 dígitos en el texto del cuerpo (se quita la
  // explicación "código de 6 dígitos" que trae la página del enlace, y los
  // años tipo "© 2026"). Con preferCode (código de inicio de sesión de
  // Netflix) se busca ANTES que cualquier enlace: el correo del código
  // también trae enlaces (ayuda, etc.) y antes se devolvía el enlace.
  // El texto sale del correo ya decodificado (incluye el correo original
  // que Pally a veces trae incrustado en un <iframe srcdoc>, que antes se
  // perdía al quitar las etiquetas). Se prefiere el número que aparece
  // justo después de "código"/"code".
  const text = decodeHtmlEntities(extra.emailHtml.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/c[oó]digo de \d+ d[ií]gitos/gi, " ");
  const notYear = (d: string) => !/^(19|20)\d\d$/.test(d);
  const codes = [...text.matchAll(/(?<![\d/:.-])\d{4,8}(?![\d/:.-])/g)].map(m => m[0]).filter(notYear);
  const nearRaw = text.match(/(?:c[oó]digo|code)[^\d]{0,80}?(?<![\d/:.-])(\d{4,8})(?![\d/:.-])/i)?.[1];
  const near = nearRaw && notYear(nearRaw) ? nearRaw : undefined;
  const code = preferCode
    ? (near && near.length === 4 ? near : (codes.find(d => d.length === 4) ?? near ?? codes[0]))
    : (near ?? codes[0]);
  if (preferCode && code) return { found: true, kind: "code", value: code, ...extra };

  // 1) Enlace: el primer <a href> del cuerpo que no sea del propio sitio.
  for (const m of wrapper.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1/gi)) {
    const href = decodeHtmlEntities(m[2] ?? "").trim();
    if (/^https?:\/\//i.test(href) && !/pally\.digital/i.test(href)) {
      return { found: true, kind: "link", value: href, ...extra };
    }
  }

  // 2) Código.
  if (code) return { found: true, kind: "code", value: code, ...extra };

  if (subject) console.warn("Pally: resultado sin enlace ni código reconocible — asunto:", subject);
  return { found: false, kind: null, value: null, ...extra };
}

// Código de acceso de Pally: solo vive en el servidor (nunca se manda al
// navegador). Se puede cambiar con PROVIDER_ACCESS_CODE en .env.production.
const PALLY_ACCESS_CODE = process.env.PROVIDER_ACCESS_CODE || "gustavo";

async function fetchFromPallyDigital(tipo: string, email: string, accessCode: string): Promise<CodeLookupResult> {
  const url = `https://codes.pally.digital/index.php?tipo=${encodeURIComponent(tipo)}`;
  const body = new URLSearchParams({
    plataforma: tipo,
    email,
    codigo: accessCode,
    accion_codigo: "codigo",
  });

  const res = await axios.post(url, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15_000,
  });

  const html: string = String(res.data);
  if (html.includes(NOT_FOUND_MARKER)) {
    return { found: false, kind: null, value: null, providerMessage: NOT_FOUND_MARKER };
  }

  const parsed = parsePallyResultPage(html, tipo === "netflix");
  if (parsed) return parsed;

  // Formato anterior: el código (o enlace) dentro del primer <strong>.
  const match = html.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
  const raw = match ? match[1].replace(/<[^>]+>/g, "").trim() : "";
  if (!raw) return pallyUnknownPage(html);

  const linkMatch = raw.match(/https?:\/\/\S+/i);
  if (linkMatch) return { found: true, kind: "link", value: linkMatch[0] };

  const digitsOnly = raw.replace(/\D/g, "");
  if (!digitsOnly) return { found: false, kind: null, value: null };

  return { found: true, kind: "code", value: digitsOnly };
}

// "PallyStore sin opciones" — primera fuente configurada (ver
// access_accounts.code_source = "netflix_sin_opciones").
function lookupNetflixSinOpciones(email: string): Promise<CodeLookupResult> {
  return fetchFromPallyDigital("netflix", email, PALLY_ACCESS_CODE);
}

// Disney+ — mismo sitio (tipo=disney), sin menú de opciones, igual que
// Netflix "sin opciones".
function lookupDisneySinOpciones(email: string): Promise<CodeLookupResult> {
  return fetchFromPallyDigital("disney", email, PALLY_ACCESS_CODE);
}

// ─────────────────────────────────────────────────────────────
// "PallyStore con opciones" — mismo sitio, pero el correo acá hace que
// la página muestre un menú de botones ("¿Qué necesitas?") en vez de
// entregar un solo resultado. Cada botón manda su propio accion_codigo
// (tg_N, confirmado por orden de aparición en el menú — "Link
// Contraseña"/tg_3 se descartó porque nunca se usa) sobre el mismo
// correo+clave. Es UNA sola fuente (no una por sub-acción): al consultar
// se prueban todas en orden y se usa la primera que responda algo.
// Definir Hogar y Código 6 dígitos son sensibles — si la que respondió
// es una de esas, nunca se entrega al cliente (igual que ya pasa con los
// códigos de 6 dígitos de "sin opciones"), pero el admin sí las ve todas
// desde el mismo lugar.
//
// El HTML de "no encontrado" acá es distinto al de "sin opciones" (texto
// confirmado por captura real). El de encontrado todavía no se vio en
// vivo — el extractor de abajo es best-effort (busca un enlace, si no
// dígitos de 4-6 en una etiqueta destacada) y se afina en cuanto se vea
// fallar con un caso real.
// ─────────────────────────────────────────────────────────────

const NOT_FOUND_MARKERS_CON_OPCIONES = [
  "No llegó ningún código para este correo",
  "Aún no hay códigos recientes",
];

async function fetchFromPallyDigitalConOpciones(email: string, accessCode: string, accion: string): Promise<CodeLookupResult> {
  const url = `https://codes.pally.digital/index.php?tipo=netflix`;
  const body = new URLSearchParams({
    plataforma: "netflix",
    email,
    codigo: accessCode,
    accion_codigo: accion,
  });

  const res = await axios.post(url, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15_000,
  });

  const html: string = String(res.data);
  const notFound = NOT_FOUND_MARKERS_CON_OPCIONES.find(marker => html.includes(marker));
  if (notFound) {
    return { found: false, kind: null, value: null, providerMessage: notFound };
  }

  const parsed = parsePallyResultPage(html, accion === "tg_4");
  if (parsed) return parsed;

  // 1) etiquetas de énfasis (<strong>/<b>) — mismo lugar que usa la
  // variante "sin opciones" para el valor real.
  const emphasisTexts = [...html.matchAll(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi)]
    .map(m => m[1].replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);

  for (const text of emphasisTexts) {
    const link = text.match(/https?:\/\/\S+/i);
    if (link) return { found: true, kind: "link", value: link[0] };
    const digits = text.replace(/\D/g, "");
    if (digits.length >= 4 && digits.length <= 6) return { found: true, kind: "code", value: digits };
  }

  // 2) de respaldo: cualquier enlace visible en el cuerpo que no sea un
  // recurso propio de la página (CDN de bootstrap, íconos, etc.).
  const bodyHtml = (html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html)
    .replace(/<(script|style|link)[\s\S]*?(<\/\1>|\/?>)/gi, "");
  const bodyLink = bodyHtml.match(/https?:\/\/(?![^"'\s<>]*(?:pally\.digital|cdn\.|bootstrap))\S+/i);
  if (bodyLink) return { found: true, kind: "link", value: bodyLink[0].replace(/["'<>].*$/, "") };

  return pallyUnknownPage(html);
}

// Página de Pally sin código y sin el aviso de «no hay códigos»: puede ser
// un error suyo (clave de acceso, correo no autorizado, mantenimiento…).
// Si trae una alerta se reporta como error del proveedor con su texto.
const PALLY_PROBLEM_RE = /(incorrect|inv[aá]lid|no autoriz|no permitid|bloquead|suspendid|mantenimiento|error|denegad|expirad|vencid|no tiene acceso|l[ií]mite)/i;

function pallyUnknownPage(html: string): CodeLookupResult {
  const alert = pageAlert(html);
  if (alert && PALLY_PROBLEM_RE.test(alert)) throw new ProviderError("provider", "Pally: " + alert);
  return { found: false, kind: null, value: null, providerMessage: alert ?? "Pally no mostró ningún código." };
}

type ConOpcionesAction = { id: string; label: string; adminOnly: boolean; accion: string };

// Orden de prueba: primero lo que se le puede entregar al cliente
// (inicio de sesión: código de 4 dígitos o enlace), luego el resto.
// Solo «Código Inicio Sesión» (tg_4, confirmado con captura de la página
// real, nov-2026). Los demás botones de Pally (Definir Hogar, Código Hogar,
// Link Contraseña, Código 6 dígitos, Link Inicio Sesión) ya no se consultan
// nunca: si hace falta alguno, el admin lo busca a mano en la web.
const CON_OPCIONES_ACTIONS: ConOpcionesAction[] = [
  { id: "codigo_login", label: "Código Inicio Sesión", adminOnly: false, accion: "tg_4" },
];

// Opción combinada para el panel: "Código o link de inicio de sesión" —
// un solo clic prueba el código de 4 dígitos y, si no hay, el enlace.
const LOGIN_COMBO_ACTION = { id: "inicio_sesion", label: "Código o link de inicio de sesión" };
const LOGIN_COMBO_IDS = ["codigo_login"];

/** Prueba las sub-acciones en orden sobre el mismo correo y se queda
 *  con la primera que responda algo — una sola llamada sirve tanto para
 *  el cliente (más abajo se filtran las sensibles) como para el admin. */
async function lookupNetflixConOpciones(email: string): Promise<CodeLookupResult> {
  let lastError: unknown = null;
  let lastNotFound: CodeLookupResult | null = null;
  for (const action of CON_OPCIONES_ACTIONS) {
    let result: CodeLookupResult;
    try {
      result = await fetchFromPallyDigitalConOpciones(email, PALLY_ACCESS_CODE, action.accion);
    } catch (err) {
      lastError = err;
      continue;
    }
    if (result.found) return { ...result, sourceAction: action.id };
    lastNotFound = result;
  }
  if (!lastNotFound && lastError) throw lastError;
  return lastNotFound ?? { found: false, kind: null, value: null };
}

/** true si el resultado vino de una de las 3 sub-acciones sensibles de
 *  "con opciones" — nunca se entrega al cliente aunque la cuenta esté
 *  configurada con esta fuente (igual criterio que el de 6 dígitos de
 *  "sin opciones", ver store.routes.ts). */
export function isSensitiveResult(result: CodeLookupResult): boolean {
  if (!result.sourceAction) return false;
  return CON_OPCIONES_ACTIONS.find(a => a.id === result.sourceAction)?.adminOnly ?? false;
}

/** true si este resultado NO se le puede entregar al cliente: el de 6
 *  dígitos de Netflix "sin opciones" (cambio de datos de la cuenta) y las
 *  sub-acciones sensibles de "con opciones". Lo ve solo el admin. */
export function isAdminOnlyResult(sourceId: string, result: CodeLookupResult): boolean {
  if (!result.found) return false;
  // Netflix por Pally: al cliente SOLO se le entrega automático el código
  // de inicio de sesión de 4 dígitos. Enlaces, códigos de 6 dígitos y lo
  // de Hogar los entrega un asesor (decisión del negocio, nov-2026).
  if (isLoginCodeOnlySource(sourceId)) return !isLoginCode(result);
  const netflix6 = (sourceId === "netflix_sin_opciones" || sourceId === "joseb_netflix") && result.kind === "code" && result.value?.length === 6;
  return netflix6 || isSensitiveResult(result);
}

// Netflix por Pally y por José Streaming: solo se trabaja con el código
// de inicio de sesión de 4 dígitos — ni enlaces, ni 6 dígitos, ni Hogar
// (ni al cliente ni en el panel). Disney+ y ChatGPT no entran acá.
const LOGIN_CODE_ONLY_SOURCES = ["netflix_sin_opciones", "netflix_con_opciones", "joseb_netflix"];

export function isLoginCodeOnlySource(sourceId: string | null): boolean {
  return !!sourceId && LOGIN_CODE_ONLY_SOURCES.includes(sourceId);
}

export function isLoginCode(result: CodeLookupResult): boolean {
  return result.found && result.kind === "code" && /^\d{4}$/.test(result.value ?? "");
}

/** Búsqueda para el CLIENTE (asistente del chat): en Netflix por Pally
 *  "con opciones" consulta solo «Código Inicio Sesión» (4 dígitos) — no
 *  prueba las demás opciones, así se generan muchas menos consultas al
 *  proveedor. El resto de fuentes, igual que lookupCodeWithRetries. */
export function lookupCodeForClientWithRetries(
  sourceId: string, email: string, exclude: SeenCode | null = null
): Promise<CodeLookupResult> {
  if (sourceId === "netflix_con_opciones") {
    return lookupCodeActionWithRetries(sourceId, email, "codigo_login", exclude);
  }
  return lookupCodeWithRetries(sourceId, email, exclude);
}

/** Sub-acciones de una fuente, para que el admin elija puntualmente qué
 *  consultar (ej. "solo el código de 6 dígitos") en vez de probarlas
 *  todas a ciegas — null si la fuente no tiene sub-acciones. */
export function listSourceActions(sourceId: string | null): { id: string; label: string }[] | null {
  if (sourceId !== "netflix_con_opciones") return null;
  // Solo «Código 4 dígitos» (enlaces y demás opciones retirados del panel).
  return [{ id: "codigo_login", label: "Código 4 dígitos" }];
}

/** Consulta puntual de UNA sub-acción específica — para fuentes sin
 *  sub-acciones (actionId ausente o no aplica), cae a la consulta normal. */
export async function lookupCodeAction(sourceId: string, email: string, actionId?: string): Promise<CodeLookupResult> {
  if (sourceId === "netflix_con_opciones" && actionId) {
    return observed(sourceId, email, () => lookupConOpcionesAction(email, actionId));
  }
  return lookupCode(sourceId, email);
}

async function lookupConOpcionesAction(email: string, actionId: string): Promise<CodeLookupResult> {
  if (actionId === LOGIN_COMBO_ACTION.id) {
    let last: CodeLookupResult = { found: false, kind: null, value: null };
    for (const id of LOGIN_COMBO_IDS) {
      const action = CON_OPCIONES_ACTIONS.find(a => a.id === id)!;
      const result = withFallbackExtraction(await fetchFromPallyDigitalConOpciones(email, PALLY_ACCESS_CODE, action.accion));
      if (result.found) return { ...result, sourceAction: action.id };
      last = result;
    }
    return last;
  }
  const action = CON_OPCIONES_ACTIONS.find(a => a.id === actionId);
  if (!action) return { found: false, kind: null, value: null };
  const result = withFallbackExtraction(await fetchFromPallyDigitalConOpciones(email, PALLY_ACCESS_CODE, action.accion));
  return result.found ? { ...result, sourceAction: action.id } : result;
}

// ─────────────────────────────────────────────────────────────
// "Streaming Market — página de códigos" (bot2.nexbolstore.com) — a
// diferencia de PallyStore pide iniciar sesión (cookie PHPSESSID). Flujo,
// igual al de su propia página: /visor/verificar responde
// {"encontrado":true|false}; si llegó, POST /visor/buscar redirige a
// /visor con el código y la hora de "Recibido" en el HTML. Por ahora
// solo ChatGPT (plataforma_id=1).
// ─────────────────────────────────────────────────────────────

const SM_BASE = "https://bot2.nexbolstore.com";
const SM_CHATGPT_PLATFORM_ID = "1";
const SM_NOT_FOUND: CodeLookupResult = { found: false, kind: null, value: null };

type SmLogin = { user: string; password: string };

// Una sesión (cookie) por usuario — cada usuario solo ve sus propios correos.
const smCookies = new Map<string, string>();
// La página guarda el último resultado en la sesión (buscar → visor), así
// que dos búsquedas a la vez con la misma sesión podrían cruzarse — se
// atienden de a una.
let smQueue: Promise<unknown> = Promise.resolve();

function smSessionCookie(setCookie: string[] | undefined): string | null {
  const raw = setCookie?.find(c => c.startsWith("PHPSESSID="));
  return raw ? raw.split(";")[0] : null;
}

async function smLogin(login: SmLogin): Promise<string> {
  const page = await axios.get(`${SM_BASE}/auth/login`, { timeout: 15_000, maxRedirects: 0, validateStatus: () => true });
  let cookie = smSessionCookie(page.headers["set-cookie"]);
  if (!cookie) throw new Error("Streaming Market no devolvió cookie de sesión.");

  const body = new URLSearchParams({ nombre_usuario: login.user, password: login.password });
  const res = await axios.post(`${SM_BASE}/auth/login`, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    timeout: 15_000, maxRedirects: 0, validateStatus: () => true,
  });
  // Un login correcto redirige al visor; uno rechazado vuelve al login.
  const location = String(res.headers.location ?? "");
  if (res.status < 300 || res.status >= 400 || location.includes("/auth/login")) {
    throw new ProviderError("session", `Streaming Market rechazó el usuario ${login.user} (¿cambió la contraseña?).`);
  }
  cookie = smSessionCookie(res.headers["set-cookie"]) ?? cookie;
  return cookie;
}

function smParseVisor(html: string): CodeLookupResult {
  const code = html.match(/class="codigo mono">\s*([^<]+?)\s*</)?.[1];
  if (!code) return SM_NOT_FOUND;
  const received = html.match(/Recibido:<\/strong>\s*([^<]+?)\s*</)?.[1];
  const link = code.match(/https?:\/\/\S+/)?.[0];
  return {
    found: true,
    kind: link ? "link" : "code",
    value: link ?? code,
    ...(received ? { providerReceivedAt: received } : {}),
  };
}

async function smLookupOnce(email: string, login: SmLogin, allowRelogin: boolean): Promise<CodeLookupResult> {
  let cookie = smCookies.get(login.user);
  const relogged = !allowRelogin;
  if (!cookie) {
    cookie = await smLogin(login);
    smCookies.set(login.user, cookie);
  }
  const query = new URLSearchParams({ plataforma_id: SM_CHATGPT_PLATFORM_ID, correo_remitente: email });

  const check = await axios.get(`${SM_BASE}/visor/verificar?${query}`, {
    headers: { Cookie: cookie }, timeout: 15_000, maxRedirects: 0, validateStatus: () => true,
  });
  // Sesión vencida: el sitio redirige al login en vez de responder JSON.
  if (check.status !== 200 || typeof check.data !== "object" || check.data === null) {
    smCookies.delete(login.user);
    if (allowRelogin) return smLookupOnce(email, login, false);
    throw new ProviderError("session", "Streaming Market no aceptó la sesión ni después de volver a entrar.");
  }
  if (!check.data.encontrado) {
    return { ...SM_NOT_FOUND, providerMessage: "Streaming Market: aún no llegó ningún código a este correo.", ...(relogged ? { relogged } : {}) };
  }

  const res = await axios.post(`${SM_BASE}/visor/buscar`, query.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie }, timeout: 15_000,
  });
  const parsed = smParseVisor(String(res.data));
  return relogged ? { ...parsed, relogged } : parsed;
}

// Prueba con cada usuario configurado hasta que alguno tenga el correo —
// así no hace falta elegir a mano con qué usuario va cada cuenta.
async function smLookupAnyLogin(email: string): Promise<CodeLookupResult> {
  if (env.STREAMING_MARKET_LOGINS.length === 0) {
    throw new ProviderError("session", "No hay usuarios de Streaming Market configurados en el servidor.");
  }
  let lastNotFound: CodeLookupResult | null = null;
  let lastError: unknown = null;
  for (const login of env.STREAMING_MARKET_LOGINS) {
    try {
      const result = await smLookupOnce(email, login, true);
      if (result.found) return result;
      lastNotFound = result;
    } catch (err) {
      // Un usuario caído o rechazado no frena a los demás.
      lastError = err;
    }
  }
  if (!lastNotFound && lastError) throw lastError;
  return lastNotFound ?? SM_NOT_FOUND;
}

function lookupStreamingMarket(email: string): Promise<CodeLookupResult> {
  const run = smQueue.then(() => smLookupAnyLogin(email));
  smQueue = run.catch(() => undefined);
  return run;
}

// ── Vegamig (Prime Video / Crunchyroll) ──
// Página pública, sin usuario: se manda el correo (POST email_cliente) y
// devuelve la misma página con el último correo que le llegó, incrustado
// en un <iframe srcdoc="..."> (HTML escapado). Si no hay nada, no trae
// el recuadro "success-text". Del correo se saca el código (Amazon: "your
// verification code is: 123456") o, si no hay código, el enlace de
// confirmación (Crunchyroll: "confirmar correo").

const VG_URL = "https://vegamig.com/solicitud%20codigo/index.php";
const VG_NOT_FOUND: CodeLookupResult = { found: false, kind: null, value: null };

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

function emailHtmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\b[^>]*>|<\/(p|div|tr|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .split("\n").map(l => l.replace(/[\s\u200a]+/g, " ").trim()).filter(Boolean).join("\n");
}

// Texto típico del botón que hay que tocar (Crunchyroll: confirmar correo
// / dispositivo). Si ninguno calza, se usa el primer enlace con forma de
// botón que no sea de los de abajo (ayuda, redes, darse de baja…).
const VG_CONFIRM_LINK = /(confirm|verif|activ|validar|validate|aprob|approve|autoriz|authoriz|s[ií],? (fui|soy) yo|it was me|this was me|yes,? it|continu|s[ií],? la envi[eé] yo|obtener c[oó]digo|get code|actualizar (tu )?hogar|update (your )?household|update-primary-location|travel\/verify)/i;
const VG_IGNORE_LINK = /(deny|deneg|no fui yo|not me|wasn.t me|unsubscribe|desuscrib|darte de baja|preferenc|privacy|privacidad|help|ayuda|support|soporte|centro de|reset|password|contrase|terms|t[eé]rminos|facebook|twitter|instagram|youtube|tiktok|discord|app store|google play|view in browser|ver en (el )?navegador)/i;
const VG_BUTTON_TAG = /(background|bgcolor|padding|border-radius|class="[^"]*(button|btn|cta)|role="button")/i;
// Años (ej. "© 2026") no son códigos.
const isYear = (d: string) => /^(19|20)\d\d$/.test(d);

export function parseVegamigPage(page: string): CodeLookupResult {
  if (!/class="success-text"/.test(page)) return VG_NOT_FOUND;
  const srcdoc = page.match(/srcdoc="([^"]*)"/)?.[1];
  if (!srcdoc) return VG_NOT_FOUND;

  const emailHtml = decodeHtmlEntities(srcdoc);
  const received = emailHtmlToText(emailHtml).match(/(?:When|Cu[aá]ndo|Fecha)\s*:\s*([^\n]+)/i)?.[1]?.trim();
  // Lo que muestra esta página es para el cliente, sin restricciones.
  const r = extractCodeFromEmailHtml(emailHtml, received, { anyButtonFallback: true });
  return { ...r, emailHtml, ...(received && !r.providerReceivedAt ? { providerReceivedAt: received } : {}) };
}

/** Saca el código (o el enlace a tocar) de un correo en HTML — compartido
 *  por las fuentes que muestran el correo completo (Vegamig, José Streaming).
 *  anyButtonFallback: si no hay código ni botón "de confirmar", usar el
 *  primer botón del correo (sirve en Crunchyroll; en Netflix no, porque sus
 *  correos sin código traen "Ver todas las series" como botón). */
function extractCodeFromEmailHtml(
  emailHtml: string, received: string | undefined, opts: { anyButtonFallback: boolean }
): CodeLookupResult {
  const text = emailHtmlToText(emailHtml);
  const extra = received ? { providerReceivedAt: received } : {};

  // 1) Código explícito ("your verification code is: 123456").
  const code = text.match(/(?:code|c[oó]digo)[^\d]{0,80}?\b(\d{4,8})\b/i)?.[1];
  if (code && !isYear(code)) return { found: true, kind: "code", value: code, ...extra };

  // 2) Botón / enlace de confirmar.
  const links = [...emailHtml.matchAll(/<a\b([^>]*)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map(m => ({
      href:  decodeHtmlEntities(m[2] ?? ""),
      label: emailHtmlToText(m[4] ?? ""),
      isButton: VG_BUTTON_TAG.test((m[1] ?? "") + (m[3] ?? "")),
    }))
    .filter(l => /^https?:\/\//i.test(l.href) && !VG_IGNORE_LINK.test(l.label) && !VG_IGNORE_LINK.test(l.href));
  const confirm = links.find(l => VG_CONFIRM_LINK.test(l.label)) ?? links.find(l => VG_CONFIRM_LINK.test(l.href));
  if (confirm) return { found: true, kind: "link", value: confirm.href, ...extra };

  // 3) Número suelto en su propia caja (código sin la palabra "code").
  const loose = [...emailHtml.matchAll(/>\s*(\d{4,8})\s*</g)].map(m => m[1] ?? "").find(d => !isYear(d));
  if (loose) return { found: true, kind: "code", value: loose, ...extra };

  // 4) Cualquier otro botón (con texto) del correo.
  if (opts.anyButtonFallback) {
    const button = links.find(l => l.isButton && l.label);
    if (button) return { found: true, kind: "link", value: button.href, ...extra };
  }

  return VG_NOT_FOUND;
}

async function lookupVegamig(email: string): Promise<CodeLookupResult> {
  const res = await axios.post(VG_URL, new URLSearchParams({ email_cliente: email }).toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Referer: VG_URL,
    },
    timeout: 20_000,
    responseType: "text",
  });
  return parseVegamigPage(String(res.data));
}

// ── José Streaming (joseb.shop) — Netflix ──
// Pide usuario: POST auth_handler.php (username/password) deja la sesión en
// la cookie PHPSESSID; la búsqueda es POST search_handler.php (multipart:
// categoria_id=1 → Netflix, remitente=correo) y devuelve JSON
// { success, details: { subject, date }, html } con el último correo.
// Credenciales en .env.production: JOSEB_USER / JOSEB_PASSWORD.

// JOSEB_BASE_URL solo sirve para pruebas locales con un José falso.
const JB_BASE = process.env.JOSEB_BASE_URL || "https://joseb.shop";
const JB_NETFLIX_CATEGORY = "1";
const JB_DISNEY_CATEGORY  = "3"; // confirmado con una búsqueda real (nov-2026)
const JB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
let jbCookie: string | null = null;
let jbCookieAt = 0;
let jbQueue: Promise<unknown> = Promise.resolve();

// José corta la sesión cuando pasa un rato sin uso (es lo que pasa en su
// web si se deja abierta: «error, vuelve a iniciar sesión»). Antes solo se
// volvía a entrar si la respuesta NO era JSON — si José avisaba con un JSON
// de error, se tomaba como «no llegó» y el cliente esperaba para siempre.
// Ahora: se renueva la sesión antes de que venza y ante cualquier aviso de
// sesión, y su mensaje queda registrado tal cual.
const JB_SESSION_MAX_MS = 12 * 60 * 1000;
const JB_AUTH_RE = /(sesi[oó]n|session|login|inicia|autentic|autoriz|token|expir|vencid|acceso denegado|unauthori[sz]ed|forbidden|csrf)/i;
const JB_NOT_FOUND_RE = /(no se encontr|no hay|sin resultados|not found|ning[uú]n (correo|mensaje|resultado)|no existen|no tiene correos|no se hallaron)/i;

type JbResponse = { data: any; raw: string; status: number };

function jbMessage(r: JbResponse): string {
  const d = r.data;
  if (d && typeof d === "object") return String(d.message ?? d.error ?? d.msg ?? d.mensaje ?? "").trim();
  return pageText(r.raw, 160);
}

function jbSessionCookie(setCookie: string[] | string | undefined): string | null {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const m = list.map(c => c.match(/PHPSESSID=([^;]+)/)?.[1]).find(Boolean);
  return m ? `PHPSESSID=${m}; cookies_accepted=true` : null;
}

async function jbLogin(): Promise<string> {
  if (!env.JOSEB_USER || !env.JOSEB_PASSWORD) throw new Error("Faltan JOSEB_USER / JOSEB_PASSWORD en .env.production.");
  const page = await axios.get(`${JB_BASE}/index.php`, { headers: { "User-Agent": JB_UA }, timeout: 15_000, maxRedirects: 0, validateStatus: () => true });
  let cookie = jbSessionCookie(page.headers["set-cookie"]) ?? "cookies_accepted=true";
  const res = await axios.post(`${JB_BASE}/auth_handler.php`,
    new URLSearchParams({ username: env.JOSEB_USER, password: env.JOSEB_PASSWORD }).toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, "User-Agent": JB_UA, Referer: `${JB_BASE}/index.php` },
      timeout: 15_000, maxRedirects: 0, validateStatus: () => true,
    });
  cookie = jbSessionCookie(res.headers["set-cookie"]) ?? cookie;
  let loginData: any = null;
  try { loginData = typeof res.data === "string" ? JSON.parse(res.data) : res.data; } catch { /* página */ }
  if (loginData && typeof loginData === "object" && loginData.success === false) {
    throw new ProviderError("session", "José Streaming rechazó el usuario: " + String(loginData.message ?? loginData.error ?? "sin detalle"));
  }
  if (res.status >= 500) throw new ProviderError("provider", `José Streaming está caído (error ${res.status}).`);
  if (!cookie.includes("PHPSESSID")) throw new ProviderError("session", "José Streaming no devolvió sesión al entrar.");
  return cookie;
}

async function jbSearch(email: string, cookie: string, category: string): Promise<JbResponse> {
  const boundary = "----LiordarkBoundary" + Math.random().toString(16).slice(2);
  const body =
    `--${boundary}\r\nContent-Disposition: form-data; name="categoria_id"\r\n\r\n${category}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="remitente"\r\n\r\n${email}\r\n` +
    `--${boundary}--\r\n`;
  const res = await axios.post(`${JB_BASE}/search_handler.php`, body, {
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`, Cookie: cookie,
      "User-Agent": JB_UA, Referer: `${JB_BASE}/index.php`, Accept: "*/*",
    },
    timeout: 20_000, maxRedirects: 0, validateStatus: () => true, responseType: "text", transformResponse: r => r,
  });
  const raw = String(res.data ?? "");
  let data: any = null;   // null = no vino JSON (sesión vencida: HTML/redirección)
  try { data = JSON.parse(raw); } catch { /* página */ }
  if (data === null && res.status >= 500) throw new ProviderError("provider", `José Streaming está caído (error ${res.status}).`);
  return { data, raw, status: res.status };
}

/** Adjunta el correo completo de José (para el visor). */
function withEmail(result: CodeLookupResult, data: any): CodeLookupResult {
  const subject = typeof data?.details?.subject === "string" ? data.details.subject : undefined;
  const received = typeof data?.details?.date === "string" ? data.details.date : undefined;
  return {
    ...result,
    emailHtml: data.html,
    ...(subject ? { subject } : {}),
    ...(received && !result.providerReceivedAt ? { providerReceivedAt: received } : {}),
  };
}

/** JSON de search_handler → código/enlace. Exportado para pruebas. */
export function parseJosebResponse(data: any): CodeLookupResult {
  if (!data || data.success !== true || typeof data.html !== "string") return VG_NOT_FOUND;
  const received = typeof data.details?.date === "string" ? data.details.date : undefined;
  return withEmail(extractCodeFromEmailHtml(data.html, received, { anyButtonFallback: false }), data);
}

/**
 * Disney+ (categoría 3): el correo trae el "código de acceso único" de 6
 * dígitos en texto (el idioma varía — el de prueba vino en checo), sin
 * botón. Se toma el primer número de exactamente 6 dígitos del cuerpo
 * (la dirección/registro de Disney al pie tienen 4 u 8 dígitos).
 * Exportado para pruebas.
 */
export function parseJosebDisneyResponse(data: any): CodeLookupResult {
  if (!data || data.success !== true || typeof data.html !== "string") return VG_NOT_FOUND;
  const received = typeof data.details?.date === "string" ? data.details.date : undefined;
  const code = emailHtmlToText(data.html).match(/(?<![\d.,/-])\d{6}(?![\d.,/-])/)?.[0];
  if (!code) return withEmail(VG_NOT_FOUND, data);
  return withEmail({ found: true, kind: "code", value: code, ...(received ? { providerReceivedAt: received } : {}) }, data);
}

async function jbFreshLogin(): Promise<string> {
  jbCookie = await jbLogin();
  jbCookieAt = Date.now();
  return jbCookie;
}

/** Respuesta de búsqueda → el JSON de José, con dos marcas propias:
 *  __relogged (se renovó la sesión) y __notFoundMessage (su aviso de
 *  «no hay correos»). Lanza ProviderError si José da un error real. */
async function jbLookupOnce(email: string, category: string): Promise<any> {
  let relogged = false;
  if (!jbCookie || Date.now() - jbCookieAt > JB_SESSION_MAX_MS) await jbFreshLogin();
  let r = await jbSearch(email, jbCookie!, category);

  const looksLikeSession = (x: JbResponse) => {
    if (x.data === null) return true;
    if (x.data?.success === true) return false;
    const msg = jbMessage(x);
    if (msg && JB_NOT_FOUND_RE.test(msg)) return false;
    // Sin mensaje: solo si la sesión ya tiene unos minutos (recién entrado, se le cree).
    return msg ? JB_AUTH_RE.test(msg) : Date.now() - jbCookieAt > 2 * 60 * 1000;
  };
  if (looksLikeSession(r)) {
    await jbFreshLogin();
    relogged = true;
    r = await jbSearch(email, jbCookie!, category);
  }

  if (r.data === null) {
    throw new ProviderError("session", "José Streaming no aceptó la sesión ni después de volver a entrar" +
      (pageText(r.raw, 100) ? ": «" + pageText(r.raw, 100) + "»" : "."));
  }
  if (r.data.success !== true) {
    const msg = jbMessage(r);
    if (!msg || JB_NOT_FOUND_RE.test(msg)) {
      return { ...r.data, __notFoundMessage: msg ? "José Streaming: " + msg : "José Streaming: no hay correos recientes.", __relogged: relogged };
    }
    throw new ProviderError(JB_AUTH_RE.test(msg) ? "session" : "provider", "José Streaming: " + msg);
  }
  return { ...r.data, __relogged: relogged };
}

/** Agrega al resultado el aviso de José y si se renovó la sesión. */
function jbDecorate(result: CodeLookupResult, data: any): CodeLookupResult {
  return {
    ...result,
    ...(!result.found && data?.__notFoundMessage ? { providerMessage: data.__notFoundMessage } : {}),
    ...(data?.__relogged ? { relogged: true } : {}),
  };
}

// Las búsquedas se hacen de a una (misma sesión para Netflix y Disney+).
function jbQueued(email: string, category: string): Promise<any> {
  const run = jbQueue.then(() => jbLookupOnce(email, category));
  jbQueue = run.catch(() => undefined);
  return run;
}

async function lookupJosebNetflix(email: string): Promise<CodeLookupResult> {
  const data = await jbQueued(email, JB_NETFLIX_CATEGORY);
  return jbDecorate(parseJosebResponse(data), data);
}

async function lookupJosebDisney(email: string): Promise<CodeLookupResult> {
  const data = await jbQueued(email, JB_DISNEY_CATEGORY);
  return jbDecorate(parseJosebDisneyResponse(data), data);
}


// ─────────────────────────────────────────────────────────────
// GRALEXANDER (latinocol.com) — Netflix «Estoy de viaje». Páginas
// públicas (sin usuario): se escribe el correo y listan TODOS los correos
// recientes de esa dirección (se borran cada día a las 24:00). El correo
// trae el botón «Obtener código» (vence en 15 min) que muestra el código
// de acceso temporal.
//  · Outlook (joma.latinocol.com): POST index.php → tabla HTML con
//    Asunto / Fecha / Vence («Caducado») y el id del correo; el cuerpo en
//    index4_body_prueba.php?email=…&id=….
//  · Yurama (jomayaa.latinocol.com): POST search_emails.php (multipart) →
//    JSON { emails: [{ subject, time, number, account_index }], error };
//    el cuerpo en redirect_to_view_email.php?email_number=…&account_index=….
// ─────────────────────────────────────────────────────────────

const LC_OUTLOOK = "https://joma.latinocol.com";
const LC_YURAMA  = "https://jomayaa.latinocol.com";
const LC_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const lcCookies = new Map<string, string>();

function lcHeaders(base: string, extra: Record<string, string> = {}): Record<string, string> {
  const cookie = lcCookies.get(base);
  return { "User-Agent": LC_UA, Referer: base + "/", ...(cookie ? { Cookie: cookie } : {}), ...extra };
}

function lcKeepCookie(base: string, setCookie: string[] | string | undefined): void {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const sid = list.map(c => c.match(/PHPSESSID=([^;]+)/)?.[1]).find(Boolean);
  if (sid) lcCookies.set(base, "PHPSESSID=" + sid);
}

function cellText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Tabla de joma.latinocol.com → correos (más nuevo primero). Exportado para pruebas. */
export function parseLatinocolOutlookList(html: string): ListedEmail[] {
  const items: ListedEmail[] = [];
  for (const row of String(html || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const inner = row[1] ?? "";
    const ref = inner.match(/data-id\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!ref) continue;
    const cells = [...inner.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(c => cellText(c[1] ?? ""));
    items.push({
      ref: decodeHtmlEntities(ref),
      subject: cells[0] ?? "",
      ...(cells[1] ? { receivedAt: cells[1] } : {}),
      expired: /caducad|vencid|expirad/i.test(cells[2] ?? ""),
    });
  }
  return sortNewestFirst(items);
}

function sortNewestFirst(items: ListedEmail[]): ListedEmail[] {
  return items
    .map((it, i) => ({ it, i, t: parseProviderDate(it.receivedAt)?.getTime() ?? null }))
    .sort((a, b) => (a.t !== null && b.t !== null ? b.t - a.t : a.i - b.i))
    .map(x => x.it);
}

/** El correo listado → código/enlace (el resultado lleva el correo completo). */
function listedEmailResult(item: ListedEmail, emailHtml: string, items: ListedEmail[]): CodeLookupResult {
  const r = extractCodeFromEmailHtml(emailHtml, item.receivedAt, { anyButtonFallback: false });
  return {
    ...r,
    emailHtml,
    subject: item.subject,
    ...(item.receivedAt ? { providerReceivedAt: item.receivedAt } : {}),
    ...(item.expired ? { expired: true } : {}),
    providerRef: item.ref,
    items,
    ...(r.found ? {} : { providerMessage: `Llegó «${item.subject}», pero no trae código ni enlace.` }),
  };
}

async function lcOutlookList(email: string): Promise<{ items: ListedEmail[]; html: string }> {
  const res = await axios.post(`${LC_OUTLOOK}/index.php`, new URLSearchParams({ email }).toString(), {
    headers: lcHeaders(LC_OUTLOOK, { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" }),
    timeout: 25_000, responseType: "text", transformResponse: r => r,
  });
  lcKeepCookie(LC_OUTLOOK, res.headers["set-cookie"]);
  const html = String(res.data ?? "");
  return { items: parseLatinocolOutlookList(html), html };
}

// Un correo ya llegado no cambia: su contenido se guarda en memoria (así el
// vigilante no lo vuelve a bajar cada 2 minutos).
const lcBodyCache = new Map<string, string>();
async function cachedBody(key: string, fetch: () => Promise<string>): Promise<string> {
  const hit = lcBodyCache.get(key);
  if (hit !== undefined) return hit;
  const body = await fetch();
  if (body.trim()) {
    lcBodyCache.set(key, body);
    if (lcBodyCache.size > 400) lcBodyCache.delete(lcBodyCache.keys().next().value!);
  }
  return body;
}

async function lcOutlookBody(email: string, ref: string): Promise<string> {
  return cachedBody("outlook|" + email.toLowerCase() + "|" + ref, () => lcOutlookBodyFetch(email, ref));
}

async function lcOutlookBodyFetch(email: string, ref: string): Promise<string> {
  const res = await axios.get(`${LC_OUTLOOK}/index4_body_prueba.php`, {
    params: { email, id: ref }, headers: lcHeaders(LC_OUTLOOK), timeout: 25_000, responseType: "text", transformResponse: r => r,
  });
  lcKeepCookie(LC_OUTLOOK, res.headers["set-cookie"]);
  return String(res.data ?? "");
}

async function lookupLatinocolOutlook(email: string): Promise<CodeLookupResult> {
  const { items, html } = await lcOutlookList(email);
  if (!items.length) {
    const said = pageAlert(html) ?? pageText(html, 160);
    return { found: false, kind: null, value: null, items: [], providerMessage: said ? "Gralexander Outlook: " + said : "Gralexander Outlook: no llegó ningún correo hoy a esta dirección." };
  }
  const newest = items[0]!;
  return listedEmailResult(newest, await lcOutlookBody(email, newest.ref), items);
}

/** Respuesta JSON de jomayaa → correos (más nuevo primero). Exportado para pruebas. */
export function parseLatinocolYuramaList(data: any): ListedEmail[] {
  const list = Array.isArray(data?.emails) ? data.emails : [];
  const items: ListedEmail[] = list
    .filter((e: any) => e && e.number !== undefined && e.account_index !== undefined)
    .map((e: any) => ({
      ref: `${e.number}|${e.account_index}`,
      subject: decodeHtmlEntities(String(e.subject ?? "")).trim(),
      ...(e.time ? { receivedAt: String(e.time).trim() } : {}),
    }));
  // Sin fecha legible: el número de correo más alto es el más nuevo.
  const byNumber = [...items].sort((a, b) => Number(b.ref.split("|")[0]) - Number(a.ref.split("|")[0]));
  return items.some(i => parseProviderDate(i.receivedAt)) ? sortNewestFirst(items) : byNumber;
}

async function lcYuramaBody(ref: string, email = ""): Promise<string> {
  return cachedBody("yurama|" + email.toLowerCase() + "|" + ref, () => lcYuramaBodyFetch(ref));
}

async function lcYuramaBodyFetch(ref: string): Promise<string> {
  const [number, account] = ref.split("|");
  const res = await axios.get(`${LC_YURAMA}/redirect_to_view_email.php`, {
    params: { email_number: number, account_index: account }, headers: lcHeaders(LC_YURAMA), timeout: 25_000,
    responseType: "text", transformResponse: r => r,
  });
  lcKeepCookie(LC_YURAMA, res.headers["set-cookie"]);
  return String(res.data ?? "");
}

async function lookupLatinocolYurama(email: string): Promise<CodeLookupResult> {
  const boundary = "----LiordarkBoundary" + Math.random().toString(16).slice(2);
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="email"\r\n\r\n${email}\r\n--${boundary}--\r\n`;
  const res = await axios.post(`${LC_YURAMA}/search_emails.php`, body, {
    headers: lcHeaders(LC_YURAMA, { "Content-Type": `multipart/form-data; boundary=${boundary}`, Accept: "application/json, */*" }),
    timeout: 25_000, responseType: "text", transformResponse: r => r,
  });
  lcKeepCookie(LC_YURAMA, res.headers["set-cookie"]);
  const raw = String(res.data ?? "");
  let data: any = null;
  try { data = JSON.parse(raw); } catch { /* página */ }
  if (!data || typeof data !== "object") {
    throw new ProviderError("provider", "Gralexander Yurama respondió algo inesperado" + (pageText(raw, 100) ? ": «" + pageText(raw, 100) + "»" : "."));
  }
  const items = parseLatinocolYuramaList(data);
  if (!items.length) {
    const said = String(data.error ?? "").trim();
    return { found: false, kind: null, value: null, items: [], providerMessage: "Gralexander Yurama: " + (said || "no hay correos recientes.") };
  }
  const newest = items[0]!;
  return listedEmailResult(newest, await lcYuramaBody(newest.ref, email), items);
}

/** Cuerpo de UN correo de la lista (para la bandeja: los demás correos
 *  recientes de la misma dirección, no solo el más nuevo). */
export async function fetchListedEmail(sourceId: string, email: string, item: ListedEmail): Promise<CodeLookupResult | null> {
  if (sourceId === "latinocol_outlook") return listedEmailResult(item, await lcOutlookBody(email, item.ref), []);
  if (sourceId === "latinocol_yurama") return listedEmailResult(item, await lcYuramaBody(item.ref, email), []);
  return null;
}

/** Fuentes que listan todos los correos recientes (las vigila el panel solo). */
export const LIST_SOURCES = ["latinocol_outlook", "latinocol_yurama"];

type Source = { label: string; lookup: (email: string) => Promise<CodeLookupResult> };

const SOURCES: Record<string, Source> = {
  netflix_sin_opciones: { label: "PallyStore sin opciones (Netflix)", lookup: lookupNetflixSinOpciones },
  netflix_con_opciones: { label: "PallyStore con opciones (Netflix)", lookup: lookupNetflixConOpciones },
  disney_sin_opciones:  { label: "PallyStore sin opciones (Disney+)", lookup: lookupDisneySinOpciones },
  streaming_market_web: { label: "Streaming Market — página de códigos", lookup: lookupStreamingMarket },
  vegamig_web:          { label: "Vegamig — Prime Video / Crunchyroll", lookup: lookupVegamig },
  joseb_netflix:        { label: "José Streaming — Netflix", lookup: lookupJosebNetflix },
  joseb_disney:         { label: "José Streaming — Disney+", lookup: lookupJosebDisney },
  latinocol_outlook:    { label: "Gralexander Outlook — Netflix", lookup: lookupLatinocolOutlook },
  latinocol_yurama:     { label: "Gralexander Yurama — Netflix", lookup: lookupLatinocolYurama },
};

// 2FA por TOTP — no consulta ninguna página: el código sale de la clave
// guardada en access_accounts.totp_secret (ver utils/totp.util.ts). Va en
// el mismo desplegable que las fuentes de arriba, pero no tiene lookup
// por correo, por eso no vive en SOURCES.
export const TOTP_SOURCE_ID = "streaming_market_2fa";
const TOTP_SOURCE_LABEL = "Streaming Market — código 2FA";

export function listCodeSources(): { id: string; label: string }[] {
  return [
    ...Object.entries(SOURCES).map(([id, s]) => ({ id, label: s.label })),
    { id: TOTP_SOURCE_ID, label: TOTP_SOURCE_LABEL },
  ];
}

export function codeSourceLabel(sourceId: string | null): string {
  if (!sourceId) return "";
  if (sourceId === TOTP_SOURCE_ID) return TOTP_SOURCE_LABEL;
  return SOURCES[sourceId]?.label || sourceId;
}

/** Una sola consulta puntual, sin reintentos — para el botón admin "Consultar ahora". */
export async function lookupCode(sourceId: string, email: string): Promise<CodeLookupResult> {
  const source = SOURCES[sourceId];
  if (!source) return { found: false, kind: null, value: null };
  return observed(sourceId, email, async () => withFallbackExtraction(await source.lookup(email)));
}

/** Si la fuente trajo el correo pero su lector no reconoció nada, se
 *  intenta con el lector genérico (código junto a "código"/"code", botón
 *  de confirmar o número en su propia caja). Los filtros de qué se le
 *  entrega al cliente se aplican después, igual que siempre. */
function withFallbackExtraction(result: CodeLookupResult): CodeLookupResult {
  if (result.found || !result.emailHtml) return result;
  const generic = extractCodeFromEmailHtml(result.emailHtml, result.providerReceivedAt, { anyButtonFallback: false });
  return generic.found ? { ...result, ...generic, emailHtml: result.emailHtml } : result;
}

/**
 * Buscador libre del admin (Códigos): prueba el correo en TODAS las
 * fuentes configuradas, sin que haga falta elegir plataforma — un
 * intento por fuente, sin reintentos, se queda con la primera que
 * encuentre algo.
 */
export async function lookupAnySource(
  email: string
): Promise<{ sourceId: string; label: string; result: CodeLookupResult } | null> {
  for (const [id, source] of Object.entries(SOURCES)) {
    let result: CodeLookupResult;
    try {
      result = await lookupCode(id, email);
    } catch {
      continue;
    }
    if (result.found) return { sourceId: id, label: source.label, result };
  }
  return null;
}

/**
 * El correo puede tardar hasta ~1 minuto en aparecer en la página del
 * proveedor (confirmado con Disney+) — reintenta espaciado antes de darse
 * por vencido, en vez de un solo intento que casi siempre sale vacío.
 * Aplica tanto al cliente como al admin (ver lookupCodeActionWithRetries
 * / lookupAnySourceWithRetries más abajo).
 */
const RETRY_ATTEMPTS = 6;
const RETRY_DELAY_MS = 12000; // 5 esperas de 12s ≈ 60s en total

// ── Códigos repetidos ──
// Streaming Market muestra siempre el ÚLTIMO código que llegó, aunque ya
// se haya entregado — "Consultar" de nuevo devolvía el mismo, que ya se
// sabe que no sirve. Para esas fuentes, un código igual al último ya
// entregado (mismo valor y misma hora de "Recibido") cuenta como "todavía
// no llegó uno nuevo" y se sigue esperando.
export type SeenCode = { value: string; providerReceivedAt?: string };

export function skipsRepeatedCodes(sourceId: string | null): boolean {
  return sourceId === "streaming_market_web" || sourceId === "vegamig_web" || sourceId === "joseb_netflix" || sourceId === "joseb_disney"
    || sourceId === "netflix_con_opciones" || sourceId === "netflix_sin_opciones" || sourceId === "disney_sin_opciones"
    || sourceId === "latinocol_outlook" || sourceId === "latinocol_yurama";
}

function isSameCode(result: CodeLookupResult, seen: SeenCode | null): boolean {
  if (!seen || !result.found || result.value !== seen.value) return false;
  return !result.providerReceivedAt || !seen.providerReceivedAt || result.providerReceivedAt === seen.providerReceivedAt;
}

const NOT_FOUND: CodeLookupResult = { found: false, kind: null, value: null };

async function retryUntilNewCode(
  attemptLookup: () => Promise<CodeLookupResult>,
  exclude: SeenCode | null,
  attempts: number,
  delayMs: number
): Promise<CodeLookupResult> {
  for (let i = 0; i < attempts; i++) {
    let result = NOT_FOUND;
    try {
      result = await attemptLookup();
    } catch { /* se reintenta igual */ }
    if (result.found && !isSameCode(result, exclude)) return result;
    if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return NOT_FOUND;
}

/** `exclude`: último código ya entregado — si vuelve a salir el mismo, se
 *  sigue esperando uno nuevo (solo se pasa para skipsRepeatedCodes). */
export async function lookupCodeWithRetries(
  sourceId: string,
  email: string,
  exclude: SeenCode | null = null,
  attempts = RETRY_ATTEMPTS,
  delayMs = RETRY_DELAY_MS
): Promise<CodeLookupResult> {
  return retryUntilNewCode(() => lookupCode(sourceId, email), exclude, attempts, delayMs);
}

/** Igual que lookupCodeWithRetries, pero para una sub-acción puntual
 *  (botón "Consultar" del admin cuando la fuente tiene sub-acciones). */
export async function lookupCodeActionWithRetries(
  sourceId: string,
  email: string,
  actionId?: string,
  exclude: SeenCode | null = null,
  attempts = RETRY_ATTEMPTS,
  delayMs = RETRY_DELAY_MS
): Promise<CodeLookupResult> {
  return retryUntilNewCode(() => lookupCodeAction(sourceId, email, actionId), exclude, attempts, delayMs);
}

/** Igual que lookupAnySource, pero reintenta antes de darse por vencido
 *  (buscador libre del admin). `exclude` solo aplica a las fuentes que
 *  saltan códigos repetidos. */
export async function lookupAnySourceWithRetries(
  email: string,
  exclude: SeenCode | null = null,
  attempts = RETRY_ATTEMPTS,
  delayMs = RETRY_DELAY_MS
): Promise<{ sourceId: string; label: string; result: CodeLookupResult } | null> {
  for (let i = 0; i < attempts; i++) {
    const found = await lookupAnySource(email);
    if (found && !(skipsRepeatedCodes(found.sourceId) && isSameCode(found.result, exclude))) return found;
    if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return null;
}


// ─────────────────────────────────────────────────────────────
// VISOR DE CÓDIGOS — el correo tal cual llegó (ver code-viewer.routes.ts)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// AL CLIENTE, SOLO INICIO DE SESIÓN — nunca un código o enlace para
// cambiar la contraseña, el correo o el teléfono de la cuenta (con eso
// cualquiera se la roba). Se mira el asunto y lo que dice el correo ANTES
// del código: el pie de los correos de inicio de sesión suele decir «si no
// fuiste tú, cambia tu contraseña» y eso no cuenta. Varios idiomas (Disney+
// a veces llega en otro). Ante la duda, no se muestra (lo ve el admin).
// ─────────────────────────────────────────────────────────────

const CHANGE_PURPOSE_RE = new RegExp([
  // contraseña (es/en/pt/fr/de/nl/pl/cs/it)
  "contrase[nñ]a", "password", "passwort", "senha", "mot de passe", "wachtwoord", "has[lł]o", "hesl[oa]", "parola d",
  // restablecer / recuperar
  "restablec", "reestablec", "\\breset", "recupera", "recover", "redefin", "r[ée]initialis", "zur[üu]cksetz", "obnov",
  // cambio de correo / teléfono / datos de la cuenta
  "(cambi|actualiz|modific)\\w* (de |tu |el |la |su )?(direcci[oó]n de )?(correo|e-?mail|email|tel[eé]fono|n[uú]mero de (tel[eé]fono|celular|m[oó]vil))",
  "(change|update|modify|edit)\\w* (your |the |of )?(account )?(new )?(e-?mail|email address|phone|mobile)",
  "(e-?mail|email|phone) (address )?(change|update)",
  "(nuevo|nueva|new) (correo|e-?mail|email|direcci[oó]n|address|n[uú]mero|phone)",
  "(alterar|trocar|mudar) (o |seu |sua )?(e-?mail|telefone|senha)",
  "zm[eě]n", // checo: změna / změnit
  "(datos|informaci[oó]n) de (tu |la |su )?cuenta", "account (details|information|settings)",
].join("|"), "i");

// Frases que solo traen los correos de cambio, estén donde estén.
const CHANGE_ANYWHERE_RE = /(asistencia (de|con) (la |tu )?contrase[nñ]a|password assistance|restablecimiento de (la |tu )?contrase[nñ]a|password reset (request|code)|(c[oó]digo|code|passcode)[^.\n]{0,60}\b(para|to) (cambiar|actualizar|restablecer|modificar|change|update|reset|modify|verify your new)|cambio de (correo|e-?mail|contrase[nñ]a|tel[eé]fono)|(email|password|phone) change request)/i;

// Enlaces de cambio/recuperación (por la dirección).
const CHANGE_LINK_RE = /(reset|password|passwd|contrase|senha|forgot|recover|recupera|change[-_]?email|email[-_]?change|update[-_]?email|account\/(security|settings|edit))/i;

// «Contraseña de un solo uso» / «one-time password» = código de acceso, no
// cambio de contraseña: se quita antes de mirar.
const OTP_PHRASES_RE = /one[- ]time pass(word|code)|contrase[nñ]a (de un solo uso|[uú]nica|temporal de acceso)|senha (de uso [uú]nico|tempor[aá]ria)|\botp\b/gi;

/** true = el correo es para cambiar/recuperar datos de la cuenta (o el
 *  enlace lleva a eso): al cliente nunca se le muestra. */
export function isAccountChangeResult(result: CodeLookupResult): boolean {
  if (!result.found) return false;
  if (result.kind === "link" && result.value && CHANGE_LINK_RE.test(result.value)) return true;
  const subject = String(result.subject || "").replace(OTP_PHRASES_RE, " ");
  const text = result.emailHtml ? emailHtmlToText(result.emailHtml).replace(OTP_PHRASES_RE, " ") : "";
  if (!subject && !text) return false; // la fuente solo da el código (ej. Streaming Market)
  if (CHANGE_ANYWHERE_RE.test(subject) || CHANGE_ANYWHERE_RE.test(text)) return true;
  const at = result.kind === "code" && result.value ? text.indexOf(result.value) : -1;
  const before = at >= 0 ? text.slice(0, at) : text.slice(0, 600);
  return CHANGE_PURPOSE_RE.test(subject) || CHANGE_PURPOSE_RE.test(before);
}

/**
 * Limpia el HTML del correo para mostrarlo dentro de un <iframe sandbox>:
 * sin scripts, sin formularios ni manejadores on*. forClient=true además
 * desactiva todos los enlaces (los enlaces de Netflix los maneja un asesor).
 */
export function sanitizeEmailHtml(html: string, forClient: boolean): string {
  let out = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<(iframe|object|embed|form|input|button|textarea|select|meta|link|base)\b[\s\S]*?>/gi, "")
    .replace(/<\/(iframe|object|embed|form|button|textarea|select)>/gi, "")
    .replace(/\s(on\w+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi, "");
  if (forClient) {
    out = out
      .replace(/<a\b[^>]*>/gi, '<span style="color:inherit;text-decoration:none">')
      .replace(/<\/a>/gi, "</span>");
  }
  // Sin forzar fondo ni color: hay correos oscuros (Netflix: fondo negro
  // por bgcolor, letras blancas) y un fondo blanco los dejaba en blanco.
  const head = '<meta charset="utf-8"><style>body{margin:0}img{max-width:100%;height:auto}</style>' +
    (forClient ? "" : '<base target="_blank">');
  // Si el correo es un documento completo, lo de arriba va dentro de su
  // <head> (antes del <!DOCTYPE> lo pondría en modo raro).
  if (/<head\b[^>]*>/i.test(out)) return out.replace(/<head\b[^>]*>/i, m => m + head);
  return head + out;
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * Hora de llegada del correo tal como la da cada proveedor → Date.
 * "Thu, 5 Nov 2026 00:28:02 +0000" (José), "04/11/2026 18:33" (Pally,
 * hora de Lima), "2026-11-02 23:04:51" (Streaming Market, hora de Lima).
 */
export function parseProviderDate(raw: string | undefined | null): Date | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const dmyAmpm = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?$/i);
  if (dmyAmpm) {
    const [, d, m, y, hh, mm, ss, ap] = dmyAmpm;
    let h = Number(hh) % 12;
    if (/p/i.test(ap ?? "")) h += 12;
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), h + 5, Number(mm), Number(ss ?? 0)));
  }
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (dmy) {
    const [, d, m, y, hh, mm, ss] = dmy;
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh) + 5, Number(mm), Number(ss ?? 0)));
  }
  const ampm = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?$/i)
    ?? null;
  if (ampm) {
    const [, y, m, d, hh, mm, ss, ap] = ampm;
    let h = Number(hh) % 12;
    if (/p/i.test(ap ?? "")) h += 12;
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), h + 5, Number(mm), Number(ss ?? 0)));
  }
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (ymd) {
    const [, y, m, d, hh, mm, ss] = ymd;
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh) + 5, Number(mm), Number(ss ?? 0)));
  }
  if (/[a-z]{3}/i.test(s) && !(s.toLowerCase().slice(0, 3) in MONTHS) && Number.isNaN(Date.parse(s))) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}
