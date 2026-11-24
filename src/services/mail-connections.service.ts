import crypto from "crypto";
import axios from "axios";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { db } from "../db/db";
import { env } from "../config/env";

// ─────────────────────────────────────────────────────────────
// CORREOS CONECTADOS — buzones propios (Outlook/Hotmail y Gmail) de
// donde salen los códigos de inicio de sesión (Adobe, Netflix, ChatGPT…).
//  · Outlook/Hotmail: inicio de sesión oficial de Microsoft (código en
//    microsoft.com/devicelogin), permiso de SOLO LECTURA (Mail.Read). No
//    se guarda la contraseña: solo un «token» que se puede revocar.
//  · Gmail: IMAP con «contraseña de aplicación» de Google (16 letras).
// Solo se leen correos de código/inicio de sesión de las últimas horas;
// nunca se borra ni se envía nada. «Desconectar» borra el acceso guardado.
// Tokens y contraseñas se guardan cifrados (AES-256-GCM).
// ─────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS mail_connections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provider    TEXT    NOT NULL,              -- outlook | gmail
    email       TEXT    NOT NULL,
    secret_enc  TEXT    NOT NULL,              -- outlook: refresh token · gmail: contraseña de aplicación
    status      TEXT    NOT NULL DEFAULT 'ok', -- ok | error
    last_error  TEXT    NOT NULL DEFAULT '',
    last_ok_at  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider, email)
  );
  CREATE TABLE IF NOT EXISTS mail_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export type MailProvider = "outlook" | "gmail";
export type MailConnection = {
  id: number; provider: MailProvider; email: string; status: "ok" | "error";
  lastError: string; lastOkAt: string | null; createdAt: string;
};

function toConn(r: any): MailConnection {
  return {
    id: r.id, provider: r.provider === "gmail" ? "gmail" : "outlook", email: r.email,
    status: r.status === "error" ? "error" : "ok", lastError: r.last_error || "",
    lastOkAt: r.last_ok_at ?? null, createdAt: r.created_at,
  };
}

export function listMailConnections(): MailConnection[] {
  return (db.prepare(`SELECT * FROM mail_connections ORDER BY provider, email`).all() as any[]).map(toConn);
}

function getRow(id: number): any | undefined {
  return db.prepare(`SELECT * FROM mail_connections WHERE id = ?`).get(id);
}

export function deleteMailConnection(id: number): boolean {
  accessTokens.delete(id);
  return db.prepare(`DELETE FROM mail_connections WHERE id = ?`).run(id).changes > 0;
}

function saveConnection(provider: MailProvider, email: string, secret: string): MailConnection {
  const e = email.trim().toLowerCase();
  db.prepare(`
    INSERT INTO mail_connections (provider, email, secret_enc, status, last_error, last_ok_at)
    VALUES (?, ?, ?, 'ok', '', datetime('now'))
    ON CONFLICT(provider, email) DO UPDATE SET
      secret_enc = excluded.secret_enc, status = 'ok', last_error = '',
      last_ok_at = datetime('now'), updated_at = datetime('now')
  `).run(provider, e, seal(secret));
  return toConn(db.prepare(`SELECT * FROM mail_connections WHERE provider = ? AND email = ?`).get(provider, e));
}

function markOk(id: number): void {
  db.prepare(`UPDATE mail_connections SET status = 'ok', last_error = '', last_ok_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
}

function markError(id: number, message: string): void {
  db.prepare(`UPDATE mail_connections SET status = 'error', last_error = ?, updated_at = datetime('now') WHERE id = ?`).run(message.slice(0, 300), id);
}

// ─── Ajustes: el «ID de la aplicación» de Microsoft (no es secreto) ───

function getSetting(key: string): string {
  const r = db.prepare(`SELECT value FROM mail_settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return r?.value ?? "";
}
function setSetting(key: string, value: string): void {
  db.prepare(`INSERT INTO mail_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getMicrosoftClientId(): string { return getSetting("ms_client_id"); }
export function setMicrosoftClientId(raw: string): string {
  const id = String(raw ?? "").trim();
  if (id && !GUID_RE.test(id)) throw new Error("El «ID de la aplicación (cliente)» tiene este formato: 1a2b3c4d-1234-5678-9abc-1234567890ab.");
  setSetting("ms_client_id", id);
  return id;
}
function msTenant(): string { return getSetting("ms_tenant") || "common"; }

// ─── Cifrado de lo guardado ───

function key(): Buffer {
  return crypto.createHash("sha256").update("liordark-mail|" + env.SESSION_SECRET).digest();
}
function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}
function unseal(sealed: string): string {
  const [iv, tag, enc] = String(sealed).split(".");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv!, "base64"));
  d.setAuthTag(Buffer.from(tag!, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc!, "base64")), d.final()]).toString("utf8");
}

// ─────────────────────────────────────────────────────────────
// OUTLOOK / HOTMAIL — Microsoft Graph, flujo «código de dispositivo»
// ─────────────────────────────────────────────────────────────

const MS_SCOPE = "offline_access User.Read Mail.Read";
const msUrl = (path: string) => `https://login.microsoftonline.com/${msTenant()}/oauth2/v2.0/${path}`;
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };

type PendingLogin = {
  deviceCode: string; userCode: string; verificationUri: string;
  intervalMs: number; expiresAt: number;
  state: "waiting" | "done" | "error"; message: string; email?: string;
};
const pending = new Map<string, PendingLogin>();

function msErrorText(err: any): string {
  const d = err?.response?.data;
  const code = String(d?.error ?? "");
  const desc = String(d?.error_description ?? err?.message ?? "");
  if (/AADSTS700016|not found in the directory/i.test(desc)) return "Microsoft no reconoce ese «ID de la aplicación». Revísalo en Configuración › Correos.";
  if (/AADSTS7000218|client_assertion|client_secret/i.test(desc)) return "En Microsoft falta activar «Permitir flujos de clientes públicos» (Autenticación › Sí).";
  if (code === "invalid_grant") return "Microsoft cerró la conexión (se cambió la contraseña o se quitó el permiso). Vuelve a conectarlo.";
  return (desc.split(/\r?\n/)[0] || code || "Microsoft no respondió.").slice(0, 200);
}

/** Pide a Microsoft un código para iniciar sesión (lo escribe el dueño en microsoft.com/devicelogin). */
export async function startOutlookLogin(): Promise<{ pendingId: string; userCode: string; verificationUri: string; expiresIn: number }> {
  const clientId = getMicrosoftClientId();
  if (!clientId) throw new Error("Primero guarda el «ID de la aplicación» de Microsoft.");
  let data: any;
  try {
    data = (await axios.post(msUrl("devicecode"), form({ client_id: clientId, scope: MS_SCOPE }), { headers: FORM_HEADERS, timeout: 20_000 })).data;
  } catch (err: any) {
    // App registrada «solo cuentas personales»: Microsoft pide /consumers.
    if (msTenant() === "common" && /consumers/i.test(String(err?.response?.data?.error_description ?? ""))) {
      setSetting("ms_tenant", "consumers");
      return startOutlookLogin();
    }
    throw new Error(msErrorText(err));
  }
  const pendingId = crypto.randomBytes(9).toString("base64url");
  const p: PendingLogin = {
    deviceCode: data.device_code, userCode: data.user_code, verificationUri: data.verification_uri,
    intervalMs: Math.max(5, Number(data.interval) || 5) * 1000,
    expiresAt: Date.now() + (Number(data.expires_in) || 900) * 1000,
    state: "waiting", message: "",
  };
  pending.set(pendingId, p);
  pollDeviceLogin(pendingId, clientId);
  return { pendingId, userCode: p.userCode, verificationUri: p.verificationUri, expiresIn: Math.round((p.expiresAt - Date.now()) / 1000) };
}

function pollDeviceLogin(pendingId: string, clientId: string): void {
  const p = pending.get(pendingId);
  if (!p || p.state !== "waiting") return;
  if (Date.now() > p.expiresAt) { p.state = "error"; p.message = "El código venció. Toca «Conectar Outlook» otra vez."; return; }
  setTimeout(async () => {
    try {
      const tok = (await axios.post(msUrl("token"), form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: p.deviceCode,
      }), { headers: FORM_HEADERS, timeout: 20_000 })).data;
      const me = (await axios.get("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
        headers: { Authorization: "Bearer " + tok.access_token }, timeout: 20_000,
      })).data;
      const email = String(me?.mail || me?.userPrincipalName || "").trim().toLowerCase();
      if (!email || !tok.refresh_token) throw new Error("Microsoft no devolvió el correo o el permiso para seguir conectado.");
      const conn = saveConnection("outlook", email, tok.refresh_token);
      accessTokens.set(conn.id, { token: tok.access_token, exp: Date.now() + (Number(tok.expires_in) || 3600) * 1000 - 60_000 });
      p.state = "done"; p.email = email; p.message = "Conectado.";
      setTimeout(() => pending.delete(pendingId), 10 * 60_000);
    } catch (err: any) {
      const code = String(err?.response?.data?.error ?? "");
      if (code === "authorization_pending") { pollDeviceLogin(pendingId, clientId); return; }
      if (code === "slow_down") { p.intervalMs += 5000; pollDeviceLogin(pendingId, clientId); return; }
      p.state = "error";
      p.message = code === "authorization_declined" ? "Se rechazó el permiso en Microsoft."
        : code === "expired_token" ? "El código venció. Toca «Conectar Outlook» otra vez."
        : msErrorText(err);
    }
  }, p.intervalMs);
}

export function outlookLoginStatus(pendingId: string): { state: string; message: string; email?: string } | null {
  const p = pending.get(pendingId);
  return p ? { state: p.state, message: p.message, ...(p.email ? { email: p.email } : {}) } : null;
}

const accessTokens = new Map<number, { token: string; exp: number }>();

async function outlookToken(row: any): Promise<string> {
  const cached = accessTokens.get(row.id);
  if (cached && cached.exp > Date.now()) return cached.token;
  const clientId = getMicrosoftClientId();
  if (!clientId) throw new Error("Falta el «ID de la aplicación» de Microsoft en Configuración › Correos.");
  let tok: any;
  try {
    tok = (await axios.post(msUrl("token"), form({
      grant_type: "refresh_token", client_id: clientId, refresh_token: unseal(row.secret_enc), scope: MS_SCOPE,
    }), { headers: FORM_HEADERS, timeout: 20_000 })).data;
  } catch (err: any) {
    throw new Error(msErrorText(err));
  }
  if (tok.refresh_token) {
    db.prepare(`UPDATE mail_connections SET secret_enc = ?, updated_at = datetime('now') WHERE id = ?`).run(seal(tok.refresh_token), row.id);
  }
  accessTokens.set(row.id, { token: tok.access_token, exp: Date.now() + (Number(tok.expires_in) || 3600) * 1000 - 60_000 });
  return tok.access_token;
}

// ─────────────────────────────────────────────────────────────
// Correos recientes de código (los dos tipos de buzón)
// ─────────────────────────────────────────────────────────────

export type ConnectedMail = {
  ref: string; subject: string; from: string; to: string[]; receivedAt: string; mailbox: string;
  /** Texto del correo en minúsculas (solo los de código de Gmail): para reconocer
   *  a qué dirección iba un correo REENVIADO (la original va citada en el cuerpo). */
  text?: string;
};

// Cuerpos ya bajados (un correo que llegó no cambia).
const bodyCache = new Map<string, string>();
function remember(ref: string, html: string): void {
  bodyCache.set(ref, html);
  if (bodyCache.size > 300) bodyCache.delete(bodyCache.keys().next().value!);
}
const ADDR_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

// Solo correos que parecen de código / inicio de sesión: nunca se leen los demás.
const CODEISH_RE = /c[oó]digo|\bcode\b|verific|inicio de sesi[oó]n|iniciar sesi[oó]n|sign[- ]?in|log[- ]?in|acceso|access|one[- ]time|\botp\b|contrase[ñn]a|password|hogar|household|seguridad|security|aprobar|approve|confirm|enlace seguro|secure link|magic[- ]?link|anthropic|claude/i;
const isCodeish = (m: { subject: string; from: string }) => CODEISH_RE.test(m.subject) || CODEISH_RE.test(m.from);

const WINDOW_MS = 3 * 60 * 60 * 1000; // últimas 3 horas

async function outlookRecent(row: any): Promise<ConnectedMail[]> {
  const token = await outlookToken(row);
  const since = new Date(Date.now() - WINDOW_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const url = "https://graph.microsoft.com/v1.0/me/messages"
    + `?$top=30&$select=id,subject,from,toRecipients,receivedDateTime`
    + `&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}&$orderby=${encodeURIComponent("receivedDateTime desc")}`;
  let data: any;
  try {
    data = (await axios.get(url, { headers: { Authorization: "Bearer " + token }, timeout: 20_000 })).data;
  } catch (err: any) {
    if (err?.response?.status === 401) accessTokens.delete(row.id);
    throw new Error(msErrorText(err));
  }
  return (Array.isArray(data?.value) ? data.value : []).map((m: any) => ({
    ref: `${row.id}:${m.id}`,
    subject: String(m.subject ?? ""),
    from: [m.from?.emailAddress?.name, m.from?.emailAddress?.address].filter(Boolean).join(" "),
    to: (m.toRecipients || []).map((r: any) => String(r?.emailAddress?.address ?? "").toLowerCase()).filter(Boolean),
    receivedAt: String(m.receivedDateTime ?? ""),
    mailbox: row.email,
  }));
}

async function outlookBody(row: any, messageId: string): Promise<string> {
  const token = await outlookToken(row);
  const data = (await axios.get(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}?$select=body`, {
    headers: { Authorization: "Bearer " + token, Prefer: 'outlook.body-content-type="html"' }, timeout: 20_000,
  })).data;
  return String(data?.body?.content ?? "");
}

function gmailClient(email: string, appPassword: string): ImapFlow {
  return new ImapFlow({
    host: "imap.gmail.com", port: 993, secure: true,
    auth: { user: email, pass: appPassword.replace(/\s+/g, "") },
    logger: false,
  });
}

/** Carpetas donde puede caer un código: «Todos» (All Mail: Recibidos más lo
 *  que un filtro archivó o mandó a una etiqueta, ej. los de Claude) y Spam.
 *  Si la cuenta no muestra «Todos» por IMAP, Recibidos. */
async function gmailFolders(client: ImapFlow): Promise<string[]> {
  let all: string | null = null;
  const junk: string[] = [];
  try {
    for (const box of await client.list()) {
      if (box.specialUse === "\\All") all = box.path;
      else if (box.specialUse === "\\Junk") junk.push(box.path);
    }
  } catch { /* solo Recibidos */ }
  return [all ?? "INBOX", ...junk];
}

/** Gmail ignora los puntos y lo que va después de «+»: j.uan+x@gmail.com
 *  es juan@gmail.com. Así un correo reenviado calza con la cuenta aunque se
 *  haya escrito distinto al registrarla. */
export function sameMailbox(a: string, b: string): boolean {
  return normalizeAddress(a) === normalizeAddress(b);
}
function normalizeAddress(raw: string): string {
  const s = String(raw ?? "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 0) return s;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.split("+")[0]!.replace(/\./g, "");
  return local + "@" + domain;
}

async function gmailRecent(row: any): Promise<ConnectedMail[]> {
  const client = gmailClient(row.email, unseal(row.secret_enc));
  const out: ConnectedMail[] = [];
  try {
    await client.connect();
    for (const folder of await gmailFolders(client)) {
      const lock = await client.getMailboxLock(folder);
      try {
        const uids = (await client.search({ since: new Date(Date.now() - WINDOW_MS) }, { uid: true })) || [];
        const last = uids.slice(-60);
        if (!last.length) continue;
        const found: ConnectedMail[] = [];
        const uidOf = new Map<string, number>();
        for await (const msg of client.fetch(last, {
          envelope: true, internalDate: true, uid: true,
          headers: ["delivered-to", "x-original-to", "x-forwarded-to", "x-forwarded-for"],
        }, { uid: true })) {
          const env2 = msg.envelope;
          const date = msg.internalDate ? new Date(msg.internalDate as any) : env2?.date ? new Date(env2.date) : null;
          if (!date || Date.now() - date.getTime() > WINDOW_MS) continue;
          // Redirigido: la dirección original queda en «Para» o en estos encabezados.
          const extra = (String(msg.headers ?? "").match(ADDR_RE) || []).map(x => x.toLowerCase());
          const m: ConnectedMail = {
            ref: `${row.id}:${folder}|${msg.uid}`,
            subject: String(env2?.subject ?? ""),
            from: (env2?.from || []).map((a: any) => [a.name, a.address].filter(Boolean).join(" ")).join(", "),
            to: [...new Set([...(env2?.to || []).map((a: any) => String(a.address ?? "").toLowerCase()).filter(Boolean), ...extra])],
            receivedAt: date.toISOString(),
            mailbox: row.email,
          };
          found.push(m);
          uidOf.set(m.ref, Number(msg.uid));
        }
        // Reenviado («RV:»/«FW:»): la dirección original va citada en el cuerpo.
        // Solo se bajan los de código (los más nuevos), nunca los demás.
        const codeish = found.filter(isCodeish).slice(-8);
        const need = codeish.filter(m => !bodyCache.has(m.ref)).map(m => uidOf.get(m.ref)!).filter(Boolean);
        if (need.length) {
          for await (const msg of client.fetch(need, { source: true, uid: true }, { uid: true })) {
            if (!msg.source) continue;
            try {
              const parsed = await simpleParser(msg.source as Buffer);
              remember(`${row.id}:${folder}|${msg.uid}`, String(parsed.html || parsed.textAsHtml || ""));
            } catch { /* correo raro: se lee después, al pedir su cuerpo */ }
          }
        }
        for (const m of codeish) {
          const html = bodyCache.get(m.ref);
          if (html) m.text = html.replace(/<[^>]+>/g, " ").toLowerCase();
        }
        out.push(...found);
      } finally { lock.release(); }
    }
  } catch (err: any) {
    throw new Error(gmailErrorText(err));
  } finally {
    await client.logout().catch(() => {});
  }
  return out;
}

async function gmailBody(row: any, ref: string): Promise<string> {
  const [folder, uid] = ref.split("|");
  const client = gmailClient(row.email, unseal(row.secret_enc));
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder!);
    try {
      const msg = await client.fetchOne(uid!, { source: true }, { uid: true });
      if (!msg || !msg.source) return "";
      const parsed = await simpleParser(msg.source as Buffer);
      return String(parsed.html || parsed.textAsHtml || "");
    } finally { lock.release(); }
  } finally {
    await client.logout().catch(() => {});
  }
}

function gmailErrorText(err: any): string {
  const s = String(err?.responseText || err?.message || err || "");
  if (/AUTHENTICATIONFAILED|Invalid credentials|authentication failed/i.test(s)) {
    return "Google rechazó la contraseña de aplicación (revisa que sea la de 16 letras y que la verificación en 2 pasos siga activa).";
  }
  return (s.split(/\r?\n/)[0] || "Gmail no respondió.").slice(0, 200);
}

/** Conecta un Gmail con su contraseña de aplicación (prueba que entra antes de guardar). */
export async function connectGmail(emailRaw: string, appPasswordRaw: string): Promise<MailConnection> {
  const email = String(emailRaw ?? "").trim().toLowerCase();
  const pass = String(appPasswordRaw ?? "").replace(/\s+/g, "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Escribe el correo de Gmail completo.");
  if (!/^[a-z]{16}$/i.test(pass)) throw new Error("La contraseña de aplicación son 16 letras (Google la muestra en 4 grupos de 4).");
  const client = gmailClient(email, pass);
  try { await client.connect(); } catch (err: any) { throw new Error(gmailErrorText(err)); }
  finally { await client.logout().catch(() => {}); }
  return saveConnection("gmail", email, pass);
}

// ─── Lo que usa el buscador de códigos ───

/**
 * Correos de código recientes para esa dirección (más nuevo primero):
 * del buzón que ES esa dirección y, si no hay, de cualquier buzón
 * conectado donde llegaron dirigidos a ella (alias o reenvío).
 */
export async function recentCodeMailFor(address: string): Promise<{ mails: ConnectedMail[]; connected: number; errors: string[] }> {
  const a = String(address ?? "").trim().toLowerCase();
  const rows = db.prepare(`SELECT * FROM mail_connections`).all() as any[];
  if (!rows.length) return { mails: [], connected: 0, errors: [] };
  const own = rows.filter(r => sameMailbox(r.email, a));
  const targets = own.length ? own : rows;
  const errors: string[] = [];
  const mails: ConnectedMail[] = [];
  for (const row of targets) {
    try {
      const list = row.provider === "gmail" ? await gmailRecent(row) : await outlookRecent(row);
      markOk(row.id);
      for (const m of list) {
        if (!isCodeish(m)) continue;
        if (!own.length && !m.to.some(t => sameMailbox(t, a)) && !(m.text && m.text.includes(a))) continue;
        mails.push(m);
      }
    } catch (err: any) {
      const msg = String(err?.message || err);
      markError(row.id, msg);
      errors.push(`${row.email}: ${msg}`);
    }
  }
  mails.sort((x, y) => Date.parse(y.receivedAt) - Date.parse(x.receivedAt));
  return { mails, connected: targets.length, errors };
}

/** Diagnóstico (solo lectura): los correos «de código» de las últimas horas
 *  de cada buzón conectado — solo carpeta, fecha, asunto, remitente y
 *  destinatarios; nunca el contenido. */
export async function inspectRecentCodeMail(): Promise<{ mailbox: string; mails: Omit<ConnectedMail, "text">[]; error?: string }[]> {
  const rows = db.prepare(`SELECT * FROM mail_connections`).all() as any[];
  const out: { mailbox: string; mails: Omit<ConnectedMail, "text">[]; error?: string }[] = [];
  for (const row of rows) {
    try {
      const list = (row.provider === "gmail" ? await gmailRecent(row) : await outlookRecent(row)).filter(isCodeish);
      out.push({ mailbox: row.email, mails: list.map(({ text: _t, ...m }) => m) });
    } catch (err: any) {
      out.push({ mailbox: row.email, mails: [], error: String(err?.message || err) });
    }
  }
  return out;
}

/** Cuerpo HTML de un correo (ref = "<idConexión>:<id del correo>"). */
export async function connectedMailBody(ref: string): Promise<string> {
  const cached = bodyCache.get(ref);
  if (cached !== undefined) return cached;
  const i = ref.indexOf(":");
  const row = getRow(Number(ref.slice(0, i)));
  if (!row) return "";
  const id = ref.slice(i + 1);
  return row.provider === "gmail" ? gmailBody(row, id) : outlookBody(row, id);
}

/** «Probar»: el último correo de código que se ve en ese buzón. */
export async function testMailConnection(id: number): Promise<{ ok: boolean; message: string }> {
  const row = getRow(id);
  if (!row) return { ok: false, message: "No existe esa conexión." };
  try {
    const list = (row.provider === "gmail" ? await gmailRecent(row) : await outlookRecent(row)).filter(isCodeish);
    markOk(id);
    return { ok: true, message: list.length
      ? `Funciona. Último correo de código: «${list.sort((x, y) => Date.parse(y.receivedAt) - Date.parse(x.receivedAt))[0]!.subject}».`
      : "Funciona. No hay correos de código en las últimas 3 horas." };
  } catch (err: any) {
    markError(id, String(err?.message || err));
    return { ok: false, message: String(err?.message || err) };
  }
}
