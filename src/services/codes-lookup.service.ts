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
  found:  boolean;
  code:   string | null;
  digits: number | null;
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
    return { found: false, code: null, digits: null };
  }

  // El código viene dentro del primer <strong> dentro de .email-body-wrapper.
  const match = html.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
  const digitsOnly = match ? match[1].replace(/\D/g, "") : "";
  if (!digitsOnly) return { found: false, code: null, digits: null };

  return { found: true, code: digitsOnly, digits: digitsOnly.length };
}

// "Netflix - Cuenta sin opciones" — primera fuente configurada (ver
// access_accounts.code_source = "netflix_sin_opciones").
function lookupNetflixSinOpciones(email: string): Promise<CodeLookupResult> {
  return fetchFromPallyDigital("netflix", email, "gustavo");
}

const SOURCES: Record<string, { label: string; lookup: (email: string) => Promise<CodeLookupResult> }> = {
  netflix_sin_opciones: { label: "Netflix - Cuenta sin opciones", lookup: lookupNetflixSinOpciones },
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
  if (!source) return { found: false, code: null, digits: null };
  return source.lookup(email);
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
  let last: CodeLookupResult = { found: false, code: null, digits: null };
  for (let i = 0; i < attempts; i++) {
    try {
      last = await lookupCode(sourceId, email);
    } catch {
      last = { found: false, code: null, digits: null };
    }
    if (last.found) return last;
    if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return last;
}
