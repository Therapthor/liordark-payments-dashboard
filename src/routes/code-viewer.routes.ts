import { Router } from "express";
import { getAccountById } from "../db/access.repository";
import { getAccountCodeSource, getAccountTotpSecret, saveIncomingCode } from "../db/codes.repository";
import {
  createCodeLink, findCodeLink, markCodeLinkOpened, closeCodeLink, codeLinkState, sqliteDate,
  type CodeLink,
} from "../db/code-links.repository";
import {
  lookupCodeAction, codeSourceLabel, isLoginCodeOnlySource, isLoginCode, isAdminOnlyResult, isAccountChangeResult,
  sanitizeEmailHtml, parseProviderDate, describeLookupError, withLookupContext, LIST_SOURCES, TOTP_SOURCE_ID,
  type CodeLookupResult, type LookupOrigin,
} from "../services/codes-lookup.service";
import { alertClientWaiting } from "../services/codes-brain.service";
import { getCurrentTotp } from "../utils/totp.util";

// ─────────────────────────────────────────────────────────────
// VISOR DE CÓDIGOS — muestra el correo tal cual llegó al proveedor.
//  · Admin (requireAuth): /api/code-viewer/...
//  · Cliente (link temporal, sin sesión): /api/code-link/<token>
// Una sola consulta por pedido (sin reintentos): el que mira decide
// cuándo «Actualizar». Para Netflix (Pally con opciones) solo se consulta
// «Código Inicio Sesión» — el resto de botones se busca a mano.
// ─────────────────────────────────────────────────────────────

export const CODE_LINK_MINUTES = [5, 10, 15];
// 2FA (ChatGPT): el código se ve al instante y rota cada 30 s.
export const TOTP_LINK_MINUTES = [2, 5, 10];

function limaTime(d: Date): string {
  return d.toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "numeric", minute: "2-digit" });
}

type Problem = { kind: string; message: string } | null;

/** Una consulta, anotada en el registro con quién la pidió. Si el proveedor
 *  falla, se devuelve el problema (antes se tragaba y parecía «no llegó»). */
async function fetchOnce(
  sourceId: string, email: string, origin: LookupOrigin, accountId: number
): Promise<{ result: CodeLookupResult; problem: Problem }> {
  const actionId = sourceId === "netflix_con_opciones" ? "codigo_login" : undefined;
  try {
    const result = await withLookupContext({ origin, accountId }, () => lookupCodeAction(sourceId, email, actionId));
    return { result, problem: null };
  } catch (err: any) {
    const problem = describeLookupError(err);
    console.error("⚠️ visor de códigos:", sourceId, problem.message);
    return { result: { found: false, kind: null, value: null }, problem };
  }
}

function receivedInfo(result: CodeLookupResult) {
  const when = parseProviderDate(result.providerReceivedAt);
  return {
    receivedAt: result.providerReceivedAt ?? null,
    receivedAtIso: when ? when.toISOString() : null,
    receivedAtLima: when ? limaTime(when) : null,
  };
}

// ═════════ ADMIN ═════════

export const codeViewerAdminRoutes = Router();

// Consulta en vivo + correo completo (con enlaces) para el panel.
codeViewerAdminRoutes.post("/:accountId/fetch", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const account = getAccountById(accountId);
  if (!account) return res.status(404).json({ message: "Cuenta no encontrada." });
  const sourceId = getAccountCodeSource(accountId);
  if (!sourceId) return res.status(409).json({ message: "Esta cuenta no tiene fuente de códigos configurada." });

  const base = { accountId, email: account.email, platform: account.platform, sourceId, sourceLabel: codeSourceLabel(sourceId) };

  if (sourceId === TOTP_SOURCE_ID) {
    const secret = getAccountTotpSecret(accountId);
    if (!secret) return res.status(409).json({ message: "Falta la clave 2FA en Accesos > Editar cuenta." });
    const totp = await getCurrentTotp(secret);
    return res.json({ ...base, totp });
  }

  const { result, problem } = await fetchOnce(sourceId, account.email, "panel", accountId);
  if (result.found && result.value) {
    saveIncomingCode({
      accountId, code: result.value,
      snippet: result.providerReceivedAt ? `Recibido: ${result.providerReceivedAt}` : "", source: "external",
    });
  }
  res.json({
    ...base,
    found: result.found, kind: result.kind, value: result.value,
    problem, providerMessage: result.providerMessage ?? null, expired: !!result.expired, relogged: !!result.relogged,
    accountChange: isAccountChangeResult(result),
    subject: result.subject ?? null,
    ...receivedInfo(result),
    html: result.emailHtml ? sanitizeEmailHtml(result.emailHtml, false) : null,
  });
});

// Link para el cliente (5, 10 o 15 min).
codeViewerAdminRoutes.post("/:accountId/link", (req, res) => {
  const accountId = Number(req.params.accountId);
  const account = getAccountById(accountId);
  if (!account) return res.status(404).json({ message: "Cuenta no encontrada." });
  const sourceId = getAccountCodeSource(accountId);
  if (!sourceId) {
    return res.status(409).json({ message: "Esta cuenta no tiene fuente de códigos configurada." });
  }
  const isTotp = sourceId === TOTP_SOURCE_ID;
  if (isTotp && !getAccountTotpSecret(accountId)) {
    return res.status(409).json({ message: "Falta la clave 2FA en Accesos > Editar cuenta." });
  }
  const allowed = isTotp ? TOTP_LINK_MINUTES : CODE_LINK_MINUTES;
  const minutes = allowed.includes(Number(req.body?.minutes)) ? Number(req.body.minutes) : allowed[0]!;
  const link = createCodeLink({
    accountId, email: account.email, sourceId, clientPhone: String(req.body?.clientPhone ?? ""),
    createdBy: "admin", minutes,
  });
  res.json({ token: link.token, url: "https://liordark.com/codigo/" + link.token, expiresAt: sqliteDate(link.expiresAt)?.toISOString(), minutes });
});

// Estado del link (para «Abierto por el cliente: …» en el panel).
codeViewerAdminRoutes.get("/link/:token", (req, res) => {
  const link = findCodeLink(String(req.params.token));
  if (!link) return res.status(404).json({ message: "Link no encontrado." });
  res.json({
    state: codeLinkState(link),
    openedAt: sqliteDate(link.openedAt)?.toISOString() ?? null,
    closedAt: sqliteDate(link.closedAt)?.toISOString() ?? null,
    expiresAt: sqliteDate(link.expiresAt)?.toISOString() ?? null,
  });
});

// ═════════ CLIENTE (link temporal) ═════════

export const codeLinkRoutes = Router();

// Para no martillar al proveedor: como mucho una consulta cada 25 s por
// link (el visor revisa cada 30 s); entre medio se responde lo último.
const CHECK_MIN_INTERVAL_MS = 25_000;
const lastChecks = new Map<string, { at: number; body: unknown }>();

// Un correo que llegó bastante antes de que se creara el link es el código
// viejo (el que ya se usó): se trata como «todavía no llega».
const OLD_EMAIL_MARGIN_MS = 10 * 60 * 1000;

/** Minutos que suele tardar el correo en llegar (Disney+ es lento). */
export function codeWaitMinutes(sourceId: string, platform: string): number {
  // Disney+ y PallyStore tardan en recibir el correo; Gralexander pide 2-3 min.
  if (LIST_SOURCES.includes(sourceId)) return 3;
  return /disney|netflix_sin_opciones|netflix_con_opciones/i.test(sourceId) || /disney/i.test(platform) ? 4 : 1;
}

/** Qué tiene que pedir el cliente en la app (depende del proveedor). */
function clientHint(sourceId: string, platform: string): string {
  if (LIST_SOURCES.includes(sourceId)) {
    return "En la TV o app de Netflix elige «Estoy de viaje» y pide el código de acceso temporal. Luego espera aquí: llega en 2 o 3 minutos.";
  }
  if (/netflix/i.test(platform)) return "Pide el código en Netflix («Usar un código de inicio de sesión») y espera aquí: revisamos cada 30 segundos.";
  return codeWaitMinutes(sourceId, platform) > 1
    ? `Pide el código en la app de ${platform} una sola vez y espera aquí.`
    : `Pide el código en la app de ${platform} y espera aquí: revisamos cada 30 segundos.`;
}

// Si el código no llega en este tiempo, se avisa al admin y se le dice al
// cliente que un asesor ya está atento (así nunca queda a la deriva).
function escalateAfterMinutes(sourceId: string, platform: string): number {
  return Math.max(3, codeWaitMinutes(sourceId, platform) + 2);
}

function linkInfo(link: CodeLink) {
  const account = getAccountById(link.accountId);
  return {
    state: codeLinkState(link),
    platform: account?.platform ?? "",
    waitMinutes: codeWaitMinutes(link.sourceId, account?.platform ?? ""),
    hint: clientHint(link.sourceId, account?.platform ?? ""),
    createdAt: sqliteDate(link.createdAt)?.toISOString() ?? null,
    expiresAt: sqliteDate(link.expiresAt)?.toISOString() ?? null,
    serverNow: new Date().toISOString(),
  };
}

codeLinkRoutes.get("/:token", (req, res) => {
  const link = findCodeLink(String(req.params.token));
  if (!link) return res.status(404).json({ message: "Este link no existe." });
  if (codeLinkState(link) === "active") markCodeLinkOpened(link.token);
  res.json(linkInfo(link));
});

codeLinkRoutes.post("/:token/check", async (req, res) => {
  const link = findCodeLink(String(req.params.token));
  if (!link) return res.status(404).json({ message: "Este link no existe." });
  if (codeLinkState(link) !== "active") return res.status(410).json(linkInfo(link));

  // 2FA: se calcula al momento (sin consultar a nadie), siempre vigente.
  if (link.sourceId === TOTP_SOURCE_ID) {
    const secret = getAccountTotpSecret(link.accountId);
    if (!secret) return res.json({ status: "advisor", ...linkInfo(link) });
    try {
      const totp = await getCurrentTotp(secret);
      return res.json({ status: "totp", value: totp.code, secondsRemaining: totp.secondsRemaining, ...linkInfo(link) });
    } catch (err: any) {
      console.error("⚠️ link 2FA:", err?.message);
      return res.json({ status: "advisor", ...linkInfo(link) });
    }
  }

  const cached = lastChecks.get(link.token);
  if (cached && Date.now() - cached.at < CHECK_MIN_INTERVAL_MS) return res.json(cached.body);

  const { result, problem } = await fetchOnce(link.sourceId, link.email, "cliente", link.accountId);
  const info = receivedInfo(result);
  const created = sqliteDate(link.createdAt);
  const when = info.receivedAtIso ? new Date(info.receivedAtIso) : null;
  const isOld = !!(when && created && when.getTime() < created.getTime() - OLD_EMAIL_MARGIN_MS) || !!result.expired;
  const platform = getAccountById(link.accountId)?.platform ?? "";

  // Qué le decimos al cliente mientras espera (lo que de verdad pasa).
  const wrongSource = !result.found && /no est[aá] vinculad|no registrad|no pertenece/i.test(result.providerMessage ?? "");
  const waitingNote = problem
    ? "La página del proveedor está lenta ahora mismo. Reintentamos solos, no tienes que hacer nada."
    : wrongSource
      ? "Estamos revisando un detalle de esta cuenta con un asesor."
      : result.found && isOld
        ? "El último código que llegó es anterior a tu pedido o ya venció. Pide uno nuevo y espera aquí."
        : `Todavía no llega el correo de ${platform || "la plataforma"}. Revisamos cada 30 segundos.`;
  const minutesWaiting = created ? Math.floor((Date.now() - created.getTime()) / 60000) : 0;
  const shouldEscalate = wrongSource || minutesWaiting >= escalateAfterMinutes(link.sourceId, platform);

  let body: Record<string, unknown>;
  if (!result.found || !result.value || isOld) {
    body = { status: "waiting", note: waitingNote, providerState: problem ? "problem" : wrongSource ? "account" : "no_email" };
    if (shouldEscalate) {
      alertClientWaiting({
        token: link.token, accountId: link.accountId, email: link.email, sourceId: link.sourceId,
        platform, clientPhone: link.clientPhone, minutes: minutesWaiting,
      });
      body.escalated = true;
    }
  } else if (isAccountChangeResult(result)) {
    // Cambio de contraseña/correo/teléfono: nunca al cliente. Sigue
    // esperando por si luego llega el de inicio de sesión.
    body = { status: "blocked" };
  } else if (isLoginCodeOnlySource(link.sourceId) && !isLoginCode(result)) {
    // Netflix: al cliente solo el código de 4 dígitos de inicio de sesión.
    body = { status: "waiting" };
  } else if (isAdminOnlyResult(link.sourceId, result)) {
    body = { status: "advisor" };
  } else {
    if (result.value) {
      saveIncomingCode({
        accountId: link.accountId, code: result.value,
        snippet: result.providerReceivedAt ? `Recibido: ${result.providerReceivedAt}` : "", source: "external",
      });
    }
    body = {
      status: "found",
      kind: result.kind,
      value: result.value,
      receivedAtLima: info.receivedAtLima,
      html: result.emailHtml ? sanitizeEmailHtml(result.emailHtml, true) : null,
    };
  }
  body = { ...body, ...linkInfo(link) };
  lastChecks.set(link.token, { at: Date.now(), body });
  if (lastChecks.size > 500) lastChecks.clear();
  res.json(body);
});

codeLinkRoutes.post("/:token/close", (req, res) => {
  const link = findCodeLink(String(req.params.token));
  if (!link) return res.status(404).json({ message: "Este link no existe." });
  closeCodeLink(link.token);
  lastChecks.delete(link.token);
  res.json({ ok: true });
});
