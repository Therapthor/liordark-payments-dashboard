import { Router } from "express";
import { getAccountById } from "../db/access.repository";
import { getAccountCodeSource, getAccountTotpSecret, saveIncomingCode } from "../db/codes.repository";
import {
  createCodeLink, findCodeLink, markCodeLinkOpened, closeCodeLink, codeLinkState, sqliteDate,
  type CodeLink,
} from "../db/code-links.repository";
import {
  lookupCodeAction, codeSourceLabel, isAccountChangeResult, deliversEverything,
  sanitizeEmailHtml, parseProviderDate, describeLookupError, withLookupContext, TOTP_SOURCE_ID,
  type CodeLookupResult, type LookupOrigin,
} from "../services/codes-lookup.service";
import {
  codeWaitMinutes, ensureCodeRequest, markClientSeen, rushRequest, searchAgain, closeCodeRequest, isChecking, foundHtml,
} from "../services/code-requests.service";
import { getCurrentTotp } from "../utils/totp.util";

// ─────────────────────────────────────────────────────────────
// VISOR DE CÓDIGOS — muestra el correo tal cual llegó al proveedor.
//  · Admin (requireAuth): /api/code-viewer/...
//  · Cliente (link temporal, sin sesión): /api/code-link/<token>
// Panel: una consulta puntual (en la fila del proveedor). Cliente: lee su
// pedido, que el buscador de pedidos atiende por turnos.
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
  sourceId: string, email: string, origin: LookupOrigin, accountId: number, wanted?: string
): Promise<{ result: CodeLookupResult; problem: Problem }> {
  const actionId = sourceId === "netflix_con_opciones" ? (wanted === "link_login" ? "link_login" : "codigo_login") : undefined;
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

  const { result, problem } = await fetchOnce(sourceId, account.email, "panel", accountId, req.body?.actionId);
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
    // Vegamig: todo se le entrega al cliente, no se avisa «cambio de datos».
    accountChange: !deliversEverything(sourceId) && isAccountChangeResult(result),
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
// La página del cliente solo LEE el pedido: el buscador de pedidos
// (code-requests.service) consulta al proveedor por turnos, en su fila.

export const codeLinkRoutes = Router();

export { codeWaitMinutes };

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
  let link = findCodeLink(String(req.params.token));
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

  ensureCodeRequest(link);
  markClientSeen(link.token);
  if (req.body?.again) searchAgain(link.token);
  else if (req.body?.now) rushRequest(link.token);

  const r = ensureCodeRequest(link);
  link = findCodeLink(link.token) ?? link; // el buscador pudo alargarlo
  let body: Record<string, unknown>;
  if (r.status === "found" || r.status === "delivered") {
    const when = parseProviderDate(r.foundReceivedAt);
    body = {
      status: "found", kind: r.foundKind, value: r.foundValue,
      receivedAtLima: when ? limaTime(when) : null,
      html: foundHtml(link.token),
    };
  } else {
    body = { status: "waiting", note: r.note, checking: isChecking(link.token) || !r.lastCheckAt };
  }
  res.json({ ...body, ...linkInfo(link) });
});

codeLinkRoutes.post("/:token/close", (req, res) => {
  const link = findCodeLink(String(req.params.token));
  if (!link) return res.status(404).json({ message: "Este link no existe." });
  closeCodeLink(link.token);
  closeCodeRequest(link.token);
  res.json({ ok: true });
});
