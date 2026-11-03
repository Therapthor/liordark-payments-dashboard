import axios from "axios";
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
  // true = el correo era de algo delicado (ej. restablecer contraseña):
  // el código se guarda para el admin pero nunca se le entrega al cliente.
  adminOnly?: boolean;
};

const NOT_FOUND_MARKER = "Aún no hay códigos recientes";

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
    return { found: false, kind: null, value: null };
  }

  // El código (o enlace) viene dentro del primer <strong> dentro de .email-body-wrapper.
  const match = html.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
  const raw = match ? match[1].replace(/<[^>]+>/g, "").trim() : "";
  if (!raw) return { found: false, kind: null, value: null };

  const linkMatch = raw.match(/https?:\/\/\S+/i);
  if (linkMatch) return { found: true, kind: "link", value: linkMatch[0] };

  const digitsOnly = raw.replace(/\D/g, "");
  if (!digitsOnly) return { found: false, kind: null, value: null };

  return { found: true, kind: "code", value: digitsOnly };
}

// "PallyStore sin opciones" — primera fuente configurada (ver
// access_accounts.code_source = "netflix_sin_opciones").
function lookupNetflixSinOpciones(email: string): Promise<CodeLookupResult> {
  return fetchFromPallyDigital("netflix", email, "gustavo");
}

// Disney+ — mismo sitio (tipo=disney), sin menú de opciones, igual que
// Netflix "sin opciones".
function lookupDisneySinOpciones(email: string): Promise<CodeLookupResult> {
  return fetchFromPallyDigital("disney", email, "gustavo");
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
  if (NOT_FOUND_MARKERS_CON_OPCIONES.some(marker => html.includes(marker))) {
    return { found: false, kind: null, value: null };
  }

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

  return { found: false, kind: null, value: null };
}

type ConOpcionesAction = { id: string; label: string; adminOnly: boolean; accion: string };

const CON_OPCIONES_ACTIONS: ConOpcionesAction[] = [
  { id: "definir_hogar",    label: "Definir Hogar",         adminOnly: true,  accion: "tg_1" },
  { id: "codigo_hogar",     label: "Código Hogar",          adminOnly: false, accion: "tg_2" },
  { id: "codigo_login",     label: "Código Inicio Sesión",  adminOnly: false, accion: "tg_4" },
  { id: "codigo_6_digitos", label: "Código 6 dígitos",      adminOnly: true,  accion: "tg_5" },
  { id: "link_login",       label: "Link Inicio Sesión",    adminOnly: false, accion: "tg_6" },
];

/** Prueba las sub-acciones en orden sobre el mismo correo y se queda
 *  con la primera que responda algo — una sola llamada sirve tanto para
 *  el cliente (más abajo se filtran las sensibles) como para el admin. */
async function lookupNetflixConOpciones(email: string): Promise<CodeLookupResult> {
  for (const action of CON_OPCIONES_ACTIONS) {
    let result: CodeLookupResult;
    try {
      result = await fetchFromPallyDigitalConOpciones(email, "gustavo", action.accion);
    } catch {
      continue;
    }
    if (result.found) return { ...result, sourceAction: action.id };
  }
  return { found: false, kind: null, value: null };
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
  const netflix6 = sourceId === "netflix_sin_opciones" && result.kind === "code" && result.value?.length === 6;
  return netflix6 || !!result.adminOnly || isSensitiveResult(result);
}

/** Sub-acciones de una fuente, para que el admin elija puntualmente qué
 *  consultar (ej. "solo el código de 6 dígitos") en vez de probarlas
 *  todas a ciegas — null si la fuente no tiene sub-acciones. */
export function listSourceActions(sourceId: string | null): { id: string; label: string }[] | null {
  if (sourceId !== "netflix_con_opciones") return null;
  return CON_OPCIONES_ACTIONS.map(a => ({ id: a.id, label: a.label }));
}

/** Consulta puntual de UNA sub-acción específica — para fuentes sin
 *  sub-acciones (actionId ausente o no aplica), cae a la consulta normal. */
export async function lookupCodeAction(sourceId: string, email: string, actionId?: string): Promise<CodeLookupResult> {
  if (sourceId === "netflix_con_opciones" && actionId) {
    const action = CON_OPCIONES_ACTIONS.find(a => a.id === actionId);
    if (!action) return { found: false, kind: null, value: null };
    const result = await fetchFromPallyDigitalConOpciones(email, "gustavo", action.accion);
    return result.found ? { ...result, sourceAction: action.id } : result;
  }
  return lookupCode(sourceId, email);
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
    throw new Error(`Streaming Market rechazó el usuario ${login.user}.`);
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
    throw new Error("Streaming Market no aceptó la sesión.");
  }
  if (!check.data.encontrado) return SM_NOT_FOUND;

  const res = await axios.post(`${SM_BASE}/visor/buscar`, query.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie }, timeout: 15_000,
  });
  return smParseVisor(String(res.data));
}

// Prueba con cada usuario configurado hasta que alguno tenga el correo —
// así no hace falta elegir a mano con qué usuario va cada cuenta.
async function smLookupAnyLogin(email: string): Promise<CodeLookupResult> {
  if (env.STREAMING_MARKET_LOGINS.length === 0) {
    throw new Error("No hay usuarios de Streaming Market configurados en el servidor.");
  }
  for (const login of env.STREAMING_MARKET_LOGINS) {
    try {
      const result = await smLookupOnce(email, login, true);
      if (result.found) return result;
    } catch {
      // Un usuario caído o rechazado no frena a los demás.
    }
  }
  return SM_NOT_FOUND;
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

// Correos de cambio/recuperación de contraseña: el código serviría para
// quitarnos la cuenta — solo para el admin.
const VG_SENSITIVE = /(reset|restablec|recuper|forgot|olvidaste|password assistance|asistencia (de|con la) contrase|change (your )?password|cambi(ar|o) (de |tu |la )?contrase|nueva contrase|new password)/i;
const VG_CONFIRM_LINK = /(confirm|verif|activ|validar|validate)/i;
const VG_IGNORE_LINK = /(deny|deneg|unsubscribe|desuscrib|privacy|privacidad|help|ayuda|support|soporte|reset|password|contrase|terms|t[eé]rminos)/i;

export function parseVegamigPage(page: string): CodeLookupResult {
  if (!/class="success-text"/.test(page)) return VG_NOT_FOUND;
  const srcdoc = page.match(/srcdoc="([^"]*)"/)?.[1];
  if (!srcdoc) return VG_NOT_FOUND;

  const emailHtml = decodeHtmlEntities(srcdoc);
  const text = emailHtmlToText(emailHtml);
  const adminOnly = VG_SENSITIVE.test(text);
  const received = text.match(/(?:When|Cu[aá]ndo|Fecha)\s*:\s*([^\n]+)/i)?.[1]?.trim();
  const extra = { ...(received ? { providerReceivedAt: received } : {}), ...(adminOnly ? { adminOnly } : {}) };

  const code =
    text.match(/(?:code|c[oó]digo)[^\d]{0,80}?\b(\d{4,8})\b/i)?.[1] ??
    emailHtml.match(/>\s*(\d{4,8})\s*</)?.[1];
  if (code) return { found: true, kind: "code", value: code, ...extra };

  for (const m of emailHtml.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeHtmlEntities(m[1] ?? "");
    const label = emailHtmlToText(m[2] ?? "");
    if (!/^https?:\/\//i.test(href)) continue;
    if (VG_IGNORE_LINK.test(label)) continue;
    if (VG_CONFIRM_LINK.test(label) || VG_CONFIRM_LINK.test(href)) {
      return { found: true, kind: "link", value: href, ...extra };
    }
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

type Source = { label: string; lookup: (email: string) => Promise<CodeLookupResult> };

const SOURCES: Record<string, Source> = {
  netflix_sin_opciones: { label: "PallyStore sin opciones (Netflix)", lookup: lookupNetflixSinOpciones },
  netflix_con_opciones: { label: "PallyStore con opciones (Netflix)", lookup: lookupNetflixConOpciones },
  disney_sin_opciones:  { label: "PallyStore sin opciones (Disney+)", lookup: lookupDisneySinOpciones },
  streaming_market_web: { label: "Streaming Market — página de códigos", lookup: lookupStreamingMarket },
  vegamig_web:          { label: "Vegamig — Prime Video / Crunchyroll", lookup: lookupVegamig },
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
  return source.lookup(email);
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
      result = await source.lookup(email);
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
  return sourceId === "streaming_market_web" || sourceId === "vegamig_web";
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
