import axios from "axios";

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

type Source = { label: string; lookup: (email: string) => Promise<CodeLookupResult> };

const SOURCES: Record<string, Source> = {
  netflix_sin_opciones: { label: "PallyStore sin opciones", lookup: lookupNetflixSinOpciones },
  netflix_con_opciones: { label: "PallyStore con opciones", lookup: lookupNetflixConOpciones },
  disney_sin_opciones:  { label: "PallyStore sin opciones (Disney+)", lookup: lookupDisneySinOpciones },
};

export function listCodeSources(): { id: string; label: string }[] {
  return Object.entries(SOURCES).map(([id, s]) => ({ id, label: s.label }));
}

export function codeSourceLabel(sourceId: string | null): string {
  if (!sourceId) return "";
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
 * El correo puede tardar hasta ~30s en aparecer en la página del
 * proveedor — reintenta unas veces espaciadas antes de darse por vencido,
 * en vez de hacer esperar al cliente con un solo intento que casi
 * siempre sale vacío.
 */
export async function lookupCodeWithRetries(
  sourceId: string,
  email: string,
  attempts = 3,
  delayMs = 9000
): Promise<CodeLookupResult> {
  let last: CodeLookupResult = { found: false, kind: null, value: null };
  for (let i = 0; i < attempts; i++) {
    try {
      last = await lookupCode(sourceId, email);
    } catch {
      last = { found: false, kind: null, value: null };
    }
    if (last.found) return last;
    if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return last;
}
