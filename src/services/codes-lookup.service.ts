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
  // Visor: el correo tal cual lo muestra el proveedor (HTML) y su asunto.
  // Nunca se manda al cliente sin pasar por sanitizeEmailHtml.
  emailHtml?: string;
  subject?: string;
};

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
export function parsePallyResultPage(html: string, preferCode = false): CodeLookupResult | null {
  const wrapperStart = html.indexOf("email-body-wrapper");
  if (wrapperStart === -1) return null;
  const formStart = html.indexOf("<form", wrapperStart);
  const wrapper = html.slice(wrapperStart, formStart === -1 ? undefined : formStart);

  const received = html.match(/Fecha de recepci[oó]n:<\/strong>\s*([^<]+)/i)?.[1]?.trim();
  const subject  = html.match(/Asunto:<\/strong>\s*([^<]+)/i)?.[1]?.trim();
  const bodyStart = html.lastIndexOf("<div", wrapperStart);
  const extra = {
    ...(received ? { providerReceivedAt: received } : {}),
    ...(subject ? { subject: decodeHtmlEntities(subject) } : {}),
    emailHtml: html.slice(bodyStart === -1 ? wrapperStart : bodyStart, formStart === -1 ? undefined : formStart),
  };

  // Código: número de 4 a 8 dígitos en el texto del cuerpo (se quita la
  // explicación "código de 6 dígitos" que trae la página del enlace, y los
  // años tipo "© 2026"). Con preferCode (código de inicio de sesión de
  // Netflix) se busca ANTES que cualquier enlace: el correo del código
  // también trae enlaces (ayuda, etc.) y antes se devolvía el enlace.
  const text = decodeHtmlEntities(wrapper.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/c[oó]digo de \d+ d[ií]gitos/gi, " ");
  const codes = [...text.matchAll(/(?<![\d/:.-])\d{4,8}(?![\d/:.-])/g)].map(m => m[0]).filter(d => !/^(19|20)\d\d$/.test(d));
  const code = preferCode ? (codes.find(d => d.length === 4) ?? codes[0]) : codes[0];
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

  const parsed = parsePallyResultPage(html, tipo === "netflix");
  if (parsed) return parsed;

  // Formato anterior: el código (o enlace) dentro del primer <strong>.
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

  return { found: false, kind: null, value: null };
}

type ConOpcionesAction = { id: string; label: string; adminOnly: boolean; accion: string };

// Orden de prueba: primero lo que se le puede entregar al cliente
// (inicio de sesión: código de 4 dígitos o enlace), luego el resto.
const CON_OPCIONES_ACTIONS: ConOpcionesAction[] = [
  { id: "codigo_login",     label: "Código Inicio Sesión",  adminOnly: false, accion: "tg_4" },
  { id: "link_login",       label: "Link Inicio Sesión",    adminOnly: false, accion: "tg_6" },
  { id: "codigo_hogar",     label: "Código Hogar",          adminOnly: false, accion: "tg_2" },
  { id: "definir_hogar",    label: "Definir Hogar",         adminOnly: true,  accion: "tg_1" },
  { id: "codigo_6_digitos", label: "Código 6 dígitos",      adminOnly: true,  accion: "tg_5" },
];

// Opción combinada para el panel: "Código o link de inicio de sesión" —
// un solo clic prueba el código de 4 dígitos y, si no hay, el enlace.
const LOGIN_COMBO_ACTION = { id: "inicio_sesion", label: "Código o link de inicio de sesión" };
const LOGIN_COMBO_IDS = ["codigo_login", "link_login"];

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
  if (sourceId === "netflix_con_opciones" && actionId === LOGIN_COMBO_ACTION.id) {
    for (const id of LOGIN_COMBO_IDS) {
      const action = CON_OPCIONES_ACTIONS.find(a => a.id === id)!;
      const result = await fetchFromPallyDigitalConOpciones(email, "gustavo", action.accion).catch(() => null);
      if (result?.found) return { ...result, sourceAction: action.id };
    }
    return { found: false, kind: null, value: null };
  }
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

const JB_BASE = "https://joseb.shop";
const JB_NETFLIX_CATEGORY = "1";
const JB_DISNEY_CATEGORY  = "3"; // confirmado con una búsqueda real (nov-2026)
const JB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
let jbCookie: string | null = null;
let jbQueue: Promise<unknown> = Promise.resolve();

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
  if (!cookie.includes("PHPSESSID")) throw new Error("José Streaming no devolvió sesión.");
  return cookie;
}

async function jbSearch(email: string, cookie: string, category: string): Promise<any> {
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
  try { return JSON.parse(String(res.data)); } catch { return null; } // null = sesión vencida (devuelve HTML/redirección)
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

async function jbLookupOnce(email: string, category: string): Promise<any> {
  if (!jbCookie) jbCookie = await jbLogin();
  let data = await jbSearch(email, jbCookie, category);
  if (data === null) {            // sesión vencida: se vuelve a entrar una vez
    jbCookie = await jbLogin();
    data = await jbSearch(email, jbCookie, category);
  }
  return data;
}

// Las búsquedas se hacen de a una (misma sesión para Netflix y Disney+).
function jbQueued(email: string, category: string): Promise<any> {
  const run = jbQueue.then(() => jbLookupOnce(email, category));
  jbQueue = run.catch(() => undefined);
  return run;
}

async function lookupJosebNetflix(email: string): Promise<CodeLookupResult> {
  return parseJosebResponse(await jbQueued(email, JB_NETFLIX_CATEGORY));
}

async function lookupJosebDisney(email: string): Promise<CodeLookupResult> {
  return parseJosebDisneyResponse(await jbQueued(email, JB_DISNEY_CATEGORY));
}

type Source = { label: string; lookup: (email: string) => Promise<CodeLookupResult> };

const SOURCES: Record<string, Source> = {
  netflix_sin_opciones: { label: "PallyStore sin opciones (Netflix)", lookup: lookupNetflixSinOpciones },
  netflix_con_opciones: { label: "PallyStore con opciones (Netflix)", lookup: lookupNetflixConOpciones },
  disney_sin_opciones:  { label: "PallyStore sin opciones (Disney+)", lookup: lookupDisneySinOpciones },
  streaming_market_web: { label: "Streaming Market — página de códigos", lookup: lookupStreamingMarket },
  vegamig_web:          { label: "Vegamig — Prime Video / Crunchyroll", lookup: lookupVegamig },
  joseb_netflix:        { label: "José Streaming — Netflix", lookup: lookupJosebNetflix },
  joseb_disney:         { label: "José Streaming — Disney+", lookup: lookupJosebDisney },
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
  return sourceId === "streaming_market_web" || sourceId === "vegamig_web" || sourceId === "joseb_netflix" || sourceId === "joseb_disney"
    || sourceId === "netflix_con_opciones" || sourceId === "netflix_sin_opciones" || sourceId === "disney_sin_opciones";
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
  } else {
    out = '<base target="_blank">' + out;
  }
  return '<meta charset="utf-8"><style>body{margin:0;padding:12px;font-family:Arial,sans-serif;background:#fff;color:#222}img{max-width:100%;height:auto}table{max-width:100%}</style>' + out;
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
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (dmy) {
    const [, d, m, y, hh, mm, ss] = dmy;
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh) + 5, Number(mm), Number(ss ?? 0)));
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
