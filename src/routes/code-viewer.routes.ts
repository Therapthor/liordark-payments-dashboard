import { Router } from "express";
import { getAccountById } from "../db/access.repository";
import { getAccountCodeSource, getAccountTotpSecret, saveIncomingCode } from "../db/codes.repository";
import {
  createCodeLink, findCodeLink, markCodeLinkOpened, closeCodeLink, codeLinkState, sqliteDate,
  type CodeLink,
} from "../db/code-links.repository";
import {
  lookupCodeAction, codeSourceLabel, isLoginCodeOnlySource, isLoginCode, isAdminOnlyResult,
  sanitizeEmailHtml, parseProviderDate, TOTP_SOURCE_ID, type CodeLookupResult,
} from "../services/codes-lookup.service";
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

function limaTime(d: Date): string {
  return d.toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "numeric", minute: "2-digit" });
}

async function fetchOnce(sourceId: string, email: string): Promise<CodeLookupResult> {
  const actionId = sourceId === "netflix_con_opciones" ? "codigo_login" : undefined;
  try {
    return await lookupCodeAction(sourceId, email, actionId);
  } catch (err: any) {
    console.error("⚠️ visor de códigos:", sourceId, err?.message);
    return { found: false, kind: null, value: null };
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

  const result = await fetchOnce(sourceId, account.email);
  if (result.found && result.value) {
    saveIncomingCode({
      accountId, code: result.value,
      snippet: result.providerReceivedAt ? `Recibido: ${result.providerReceivedAt}` : "", source: "external",
    });
  }
  res.json({
    ...base,
    found: result.found, kind: result.kind, value: result.value,
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
  if (!sourceId || sourceId === TOTP_SOURCE_ID) {
    return res.status(409).json({ message: "Esta cuenta no tiene una fuente de correo para compartir." });
  }
  const minutes = CODE_LINK_MINUTES.includes(Number(req.body?.minutes)) ? Number(req.body.minutes) : 5;
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

// Para no martillar al proveedor: como mucho una consulta cada 6 s por link.
const CHECK_MIN_INTERVAL_MS = 6000;
const lastChecks = new Map<string, { at: number; body: unknown }>();

// Un correo que llegó bastante antes de que se creara el link es el código
// viejo (el que ya se usó): se trata como «todavía no llega».
const OLD_EMAIL_MARGIN_MS = 10 * 60 * 1000;

/** Minutos que suele tardar el correo en llegar (Disney+ es lento). */
export function codeWaitMinutes(sourceId: string, platform: string): number {
  return /disney/i.test(sourceId) || /disney/i.test(platform) ? 4 : 1;
}

function linkInfo(link: CodeLink) {
  const account = getAccountById(link.accountId);
  return {
    state: codeLinkState(link),
    platform: account?.platform ?? "",
    waitMinutes: codeWaitMinutes(link.sourceId, account?.platform ?? ""),
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

  const cached = lastChecks.get(link.token);
  if (cached && Date.now() - cached.at < CHECK_MIN_INTERVAL_MS) return res.json(cached.body);

  const result = await fetchOnce(link.sourceId, link.email);
  const info = receivedInfo(result);
  const created = sqliteDate(link.createdAt);
  const when = info.receivedAtIso ? new Date(info.receivedAtIso) : null;
  const isOld = !!(when && created && when.getTime() < created.getTime() - OLD_EMAIL_MARGIN_MS);

  let body: Record<string, unknown>;
  if (!result.found || !result.value || isOld) {
    body = { status: "waiting" };
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
