import fs from "fs";
import path from "path";
import crypto from "crypto";
import type Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import { env } from "../config/env";
import { getAdminSetting, setAdminSetting } from "../db/security.repository";
import { findCustomerById, findCustomerByPhone } from "../db/customer.repository";
import { normalizePeruPhone } from "../utils/phone.util";
import { createSystemIncident } from "../db/support-tickets.repository";
import { createCustomerNotification } from "../db/customer-notifications.repository";
import { findWholesalerByPhone } from "../db/wholesaler.repository";
import { isLocalMedia, mediaFilePath, MEDIA_PREFIX } from "./product-media.service";
import {
  addMessage, listMessages, logUsage, spentThisMonth, spentTodayByCustomer, getUpload,
  setSummary, pruneMessages, conversationsToCompact, conversationsOverLimit, oldUploads,
  deleteConversation, deleteUploadRows, getConversation, customerState, setMemory,
  bumpMessagesSinceMemory, registerPause, pausesToday, chatsSince, spentThisMonthByCustomer,
  wallet, setWindowStart, planSpentSince, creditsSpentSince, createAiPurchase, findAiPurchase, markAiPurchasePaid,
  giftAi, hasPaidAiPurchase, recentAiPurchases, outstandingBalance, cleanupPendingAiPurchases, avgCostPerMessage,
  spentByCredentialSince, subscribersSummary, salesThisMonth, walletsForNotices, setWalletNotice, countConversations,
  type AiMessage, type AiConversation, type UsageSource, type AiWallet,
} from "../db/manguito.repository";

// ─────────────────────────────────────────────────────────────
// MANGUITO PRO — chat con Claude (API de Anthropic) en liordark.com.
//
// · Solo para los celulares que el admin pone en el panel (prueba privada).
// · El cliente nunca elige modelo: un selector barato (Haiku) lee cada
//   pregunta y elige el más barato que la resuelva bien:
//     ⚡ Rápido (Haiku 5.5) · 🧠 Equilibrado (Sonnet 5.5) · 🏆 Experto (Opus 5.5).
//   Claude Fable no se usa nunca.
// · Ahorro de tokens: saludos cortos sin pasar por el selector, esfuerzo
//   bajo por defecto, respuestas cortas, NO se reenvía toda la conversación
//   (solo los últimos mensajes + un resumen de lo anterior + la memoria del
//   cliente), solo la imagen más reciente, caché (90 % más barato al
//   releer), imágenes achicadas en el navegador y topes de gasto por día,
//   por cliente al mes y total al mes. Con poco saldo baja de nivel.
// · Pausa de 1 hora (como Claude) si manda muchos mensajes seguidos;
//   máximo 2 pausas al día.
// La clave de la API se guarda en el panel (nunca en el código ni en git)
// y nunca sale hacia el navegador.
// ─────────────────────────────────────────────────────────────

export type Tier = "rapido" | "equilibrado" | "experto";
type Effort = "low" | "medium" | "high";

export const TIERS: Record<Tier, { model: string; label: string; maxTokens: number; fallback: string | null }> = {
  rapido:      { model: "claude-haiku-5-5",  label: "⚡ Rápido",      maxTokens: 2048,  fallback: null },
  equilibrado: { model: "claude-sonnet-5-5", label: "🧠 Equilibrado", maxTokens: 4096,  fallback: "claude-sonnet-5" },
  experto:     { model: "claude-opus-5-5",   label: "🏆 Experto",     maxTokens: 10000, fallback: "claude-opus-4-8" },
};
const ROUTER_MODEL = "claude-haiku-5-5";

// US$ por millón de tokens (entrada, salida, lectura de caché). Escribir en
// caché cuesta 1,25× la entrada. Un modelo desconocido se cobra como Opus
// 4.8 (lo más caro de esta lista) para no quedarse corto en los topes.
const PRICES: Record<string, { in: number; out: number; cacheRead: number }> = {
  "claude-haiku-5-5":  { in: 0.10, out: 0.50, cacheRead: 0.01 },
  "claude-sonnet-5-5": { in: 2,    out: 10,   cacheRead: 0.10 },
  "claude-opus-5-5":   { in: 4,    out: 20,   cacheRead: 0.20 },
  "claude-sonnet-5":   { in: 2,    out: 10,   cacheRead: 0.20 },
  "claude-opus-4-8":   { in: 5,    out: 25,   cacheRead: 0.50 },
};

type Usage = { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number };

export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model] ?? PRICES["claude-opus-4-8"]!;
  return (u.inputTokens * p.in + u.cacheWrite * p.in * 1.25 + u.cacheRead * p.cacheRead + u.outputTokens * p.out) / 1e6;
}

// El SDK se carga recién cuando se usa Manguito Pro: si algún día fallara al
// cargar, solo se cae Manguito Pro, nunca la tienda ni el panel.
let sdkModule: typeof Anthropic | null = null;
function sdk(): typeof Anthropic {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (!sdkModule) sdkModule = (require("@anthropic-ai/sdk") as { default: typeof Anthropic }).default;
  return sdkModule;
}

// ── Configuración (Configuración › 🥭 Manguito Pro) ──

const K = {
  creds: "ai_credentials", phones: "ai_allowed_phones", dailyCap: "ai_daily_cap_usd", monthlyCap: "ai_monthly_cap_usd",
  clientMonthlyCap: "ai_client_monthly_cap_usd", burstMessages: "ai_burst_messages", pausesPerDay: "ai_pauses_per_day",
  phoneCaps: "ai_phone_caps", // {celular: tope US$ al mes} — topes especiales (sin tope diario)
  freePaused: "ai_free_paused", // "1" = la lista gratis no tiene acceso (para ver la compra como cliente)
  // Versión anterior (una sola clave): se pasa sola a la lista.
  oldApiKey: "ai_api_key", oldAuthToken: "ai_auth_token", oldBaseUrl: "ai_base_url",
};
export const DEFAULT_DAILY_CAP = 2;
export const DEFAULT_MONTHLY_CAP = 50;
export const DEFAULT_CLIENT_MONTHLY_CAP = 10; // por cliente al mes
export const DEFAULT_BURST_MESSAGES = 30;     // tantos mensajes en 5 horas → pausa de 1 hora
export const DEFAULT_PAUSES_PER_DAY = 2;      // después de 2 pausas en el día ya no pausa (sigue el tope del día)
const BURST_WINDOW_H = 5;
const COOLDOWN_MIN = 60;

// ── Claves de API (varias, en orden) ──
// Se usan en el orden de la lista. Si una se queda sin saldo, la rechazan o
// llega al límite de uso, Manguito pasa sola a la siguiente y la deja en
// pausa un rato (sin saldo: 6 h; inválida: 24 h; límite: 1 min). Si vuelve
// a responder, se limpia sola. Así, cuando se acaba el saldo a fin de mes,
// basta con agregar otra clave y todo sigue.
export type FailKind = "billing" | "auth" | "rate";
export type AiCredential = {
  id: string; label: string; kind: "apiKey" | "authToken"; secret: string; baseUrl: string;
  enabled: boolean; failedAt: number | null; failKind: FailKind | ""; lastOkAt: number | null; addedAt: number;
  // Saldo que el admin dice que tiene la cuenta de la API (y desde cuándo):
  // lo que queda = ese saldo − lo gastado con esta clave desde entonces.
  budgetUsd?: number | null; budgetAt?: number | null;
};
const COOLDOWN_MS: Record<FailKind, number> = { billing: 6 * 3600e3, auth: 24 * 3600e3, rate: 60e3 };
export const FAIL_TEXT: Record<FailKind, string> = {
  billing: "sin saldo", auth: "clave inválida o sin permiso", rate: "límite de uso",
};

function num(v: string | null, def: number): number {
  const n = Number(v);
  return v !== null && v !== "" && isFinite(n) && n >= 0 ? n : def;
}

export function listCredentials(): AiCredential[] {
  let list: AiCredential[] = [];
  try { list = JSON.parse(getAdminSetting(K.creds) || "[]"); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  const oldKey = (getAdminSetting(K.oldApiKey) || "").trim();
  const oldTok = (getAdminSetting(K.oldAuthToken) || "").trim();
  if (oldKey || oldTok) {
    list.push(newCredential("Principal", oldKey ? "apiKey" : "authToken", oldKey || oldTok, (getAdminSetting(K.oldBaseUrl) || "").trim()));
    saveCredentials(list);
    setAdminSetting(K.oldApiKey, ""); setAdminSetting(K.oldAuthToken, ""); setAdminSetting(K.oldBaseUrl, "");
  }
  return list;
}

function saveCredentials(list: AiCredential[]): void {
  setAdminSetting(K.creds, JSON.stringify(list));
}

function newCredential(label: string, kind: "apiKey" | "authToken", secret: string, baseUrl: string): AiCredential {
  return {
    id: crypto.randomBytes(4).toString("hex"), label: label.slice(0, 40) || "Clave", kind, secret, baseUrl,
    enabled: true, failedAt: null, failKind: "", lastOkAt: null, addedAt: Date.now(),
  };
}

function updateCredential(id: string, patch: Partial<AiCredential>): void {
  const list = listCredentials();
  const c = list.find(x => x.id === id);
  if (!c) return;
  Object.assign(c, patch);
  saveCredentials(list);
}

function isCoolingDown(c: AiCredential, now = Date.now()): boolean {
  return !!(c.failedAt && c.failKind && now - c.failedAt < COOLDOWN_MS[c.failKind]);
}

export function credentialState(c: AiCredential): { state: "ok" | "paused" | "off"; reason: string } {
  if (!c.enabled) return { state: "off", reason: "desactivada" };
  if (isCoolingDown(c) && c.failKind) return { state: "paused", reason: FAIL_TEXT[c.failKind] };
  return { state: "ok", reason: "" };
}

export type AiConfig = {
  phones: string[]; burstMessages: number; pausesPerDay: number; dailyCap: number; clientMonthlyCap: number; monthlyCap: number;
  phoneCaps: Record<string, number>; freePaused: boolean;
};

function readPhoneCaps(): Record<string, number> {
  try {
    const o = JSON.parse(getAdminSetting(K.phoneCaps) || "{}");
    const out: Record<string, number> = {};
    for (const [p, v] of Object.entries(o)) if (/^\d{9}$/.test(p) && typeof v === "number" && isFinite(v) && v >= 0) out[p] = v;
    return out;
  } catch { return {}; }
}

export function aiConfig(): AiConfig {
  return {
    phones:           (getAdminSetting(K.phones) || "").split(",").map(s => s.trim()).filter(Boolean),
    burstMessages:    Math.floor(num(getAdminSetting(K.burstMessages), DEFAULT_BURST_MESSAGES)),
    pausesPerDay:     Math.floor(num(getAdminSetting(K.pausesPerDay), DEFAULT_PAUSES_PER_DAY)),
    dailyCap:         num(getAdminSetting(K.dailyCap), DEFAULT_DAILY_CAP),
    clientMonthlyCap: num(getAdminSetting(K.clientMonthlyCap), DEFAULT_CLIENT_MONTHLY_CAP),
    monthlyCap:       num(getAdminSetting(K.monthlyCap), DEFAULT_MONTHLY_CAP),
    phoneCaps:        readPhoneCaps(),
    freePaused:       getAdminSetting(K.freePaused) === "1",
  };
}

export function isAiConfigured(): boolean {
  return listCredentials().some(c => c.enabled);
}

const last9 = (p: string) => String(p || "").replace(/\D/g, "").slice(-9);

export function isAiAllowedPhone(phone: string): boolean {
  const d = last9(phone);
  const cfg = aiConfig();
  return d.length === 9 && !cfg.freePaused && (cfg.phones.includes(d) || d in cfg.phoneCaps);
}

/** Topes de este cliente: el especial de su celular (al mes, sin tope
 *  diario) o los generales del panel. */
function capsFor(customerId: number, cfg = aiConfig()): { monthly: number; daily: number } {
  const special = cfg.phoneCaps[last9(findCustomerById(customerId)?.phone || "")];
  return special !== undefined ? { monthly: special, daily: Infinity } : { monthly: cfg.clientMonthlyCap, daily: cfg.dailyCap };
}

/** «9XXXXXXXX = 50» por línea → {"9XXXXXXXX": 50}. Devuelve un error legible o el objeto. */
function parsePhoneCaps(raw: string): Record<string, number> | string {
  const out: Record<string, number> = {};
  for (const line of raw.split(/[\n;]+/).map(l => l.trim()).filter(Boolean)) {
    const m = line.match(/^([+\d][\d\s-]*?)\s*(?:[=:]|\s)\s*(?:US)?\$?\s*(\d+(?:[.,]\d+)?)\s*$/i);
    const phone = m ? last9(m[1]!) : "";
    const cap = m ? Number(m[2]!.replace(",", ".")) : NaN;
    if (phone.length !== 9 || !isFinite(cap) || cap > 10000) return `Revisa «${line.slice(0, 40)}»: escribe el celular y el tope, por ejemplo 9XXXXXXXX = 50`;
    out[phone] = Math.round(cap * 100) / 100;
  }
  return out;
}

function cleanBaseUrl(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const v = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!v) return { ok: true, value: "" };
  let u: URL;
  try { u = new URL(v); } catch { return { ok: false, message: "La dirección (base URL) no es válida." }; }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return { ok: false, message: "La dirección (base URL) debe empezar con https://" };
  return { ok: true, value: v };
}

/** Agrega una clave al final de la lista. Devuelve un error legible o null. */
export function addCredential(body: any): string | null {
  const apiKey = String(body?.apiKey ?? "").trim();
  const token = String(body?.authToken ?? "").trim();
  if (!apiKey && !token) return "Pega la clave de la API (o el token).";
  const secret = apiKey || token;
  if (secret.length < 20 || secret.length > 2000 || /\s/.test(secret)) return apiKey ? "Esa clave de API no parece válida." : "Ese token no parece válido.";
  const base = cleanBaseUrl(body?.baseUrl);
  if (!base.ok) return base.message;
  const list = listCredentials();
  if (list.some(c => c.secret === secret)) return "Esa clave ya está en la lista.";
  if (list.length >= 20) return "Máximo 20 claves.";
  list.push(newCredential(String(body?.label ?? "").trim() || `Clave ${list.length + 1}`, apiKey ? "apiKey" : "authToken", secret, base.value));
  saveCredentials(list);
  return null;
}

/** Activar/desactivar, renombrar, subir/bajar en la lista o quitarle la pausa. */
export function editCredential(id: string, body: any): string | null {
  const list = listCredentials();
  const i = list.findIndex(c => c.id === id);
  if (i < 0) return "Esa clave ya no existe.";
  const c = list[i]!;
  if (typeof body?.enabled === "boolean") c.enabled = body.enabled;
  if (typeof body?.label === "string" && body.label.trim()) c.label = body.label.trim().slice(0, 40);
  if (body?.reset) { c.failedAt = null; c.failKind = ""; }
  if (body?.budgetUsd !== undefined) {
    const raw = String(body.budgetUsd ?? "").trim().replace(",", ".");
    if (raw === "") { c.budgetUsd = null; c.budgetAt = null; }
    else {
      const n = Number(raw);
      if (!isFinite(n) || n < 0 || n > 100000) return "El saldo debe ser un monto en US$.";
      c.budgetUsd = Math.round(n * 100) / 100; c.budgetAt = Date.now();
    }
  }
  if (body?.move === "up" && i > 0) [list[i - 1], list[i]] = [list[i]!, list[i - 1]!];
  if (body?.move === "down" && i < list.length - 1) [list[i + 1], list[i]] = [list[i]!, list[i + 1]!];
  saveCredentials(list);
  return null;
}

export function deleteCredential(id: string): boolean {
  const list = listCredentials();
  const next = list.filter(c => c.id !== id);
  if (next.length === list.length) return false;
  saveCredentials(next);
  return true;
}

/** Celulares con acceso y topes (los campos ausentes no se tocan). */
export function saveAiConfig(body: any): string | null {
  if (body?.apiKey || body?.authToken) {
    const err = addCredential(body);
    if (err) return err;
  }
  if (typeof body?.freePaused === "boolean") setAdminSetting(K.freePaused, body.freePaused ? "1" : "0");
  if (body?.phoneCaps !== undefined) {
    const caps = parsePhoneCaps(String(body.phoneCaps));
    if (typeof caps === "string") return caps;
    setAdminSetting(K.phoneCaps, JSON.stringify(caps));
  }
  if (body?.phones !== undefined) {
    const list = String(body.phones).split(/[\s,;]+/).map(last9).filter(p => p.length === 9);
    setAdminSetting(K.phones, [...new Set(list)].join(","));
  }
  for (const [field, key] of [["dailyCap", K.dailyCap], ["clientMonthlyCap", K.clientMonthlyCap], ["monthlyCap", K.monthlyCap]] as const) {
    if (body?.[field] === undefined) continue;
    const n = Number(body[field]);
    if (!isFinite(n) || n < 0 || n > 10000) return "El tope debe ser un monto entre 0 y 10000 dólares.";
    setAdminSetting(key, String(Math.round(n * 100) / 100));
  }
  for (const [field, key, max, label] of [
    ["burstMessages", K.burstMessages, 1000, "Los mensajes antes de la pausa deben ser un número entre 0 y 1000."],
    ["pausesPerDay", K.pausesPerDay, 24, "Las pausas al día deben ser un número entre 0 y 24."],
  ] as const) {
    if (body?.[field] === undefined) continue;
    const n = Number(body[field]);
    if (!Number.isInteger(n) || n < 0 || n > max) return label;
    setAdminSetting(key, String(n));
  }
  return null;
}

function clientFor(c: AiCredential): Anthropic {
  const Client = sdk();
  const base = c.baseUrl ? { baseURL: c.baseUrl } : {};
  return c.kind === "apiKey"
    ? new Client({ apiKey: c.secret, ...base, maxRetries: 1 })
    : new Client({ authToken: c.secret, ...base, maxRetries: 1 });
}

/** ¿Este error es de la clave (saldo, permiso, límite)? → probar con la siguiente. */
function credentialFailure(err: unknown): FailKind | null {
  let A: typeof Anthropic;
  try { A = sdk(); } catch { return null; }
  if (err instanceof A.AuthenticationError || err instanceof A.PermissionDeniedError) return "auth";
  if (err instanceof A.RateLimitError) return "rate";
  if (err instanceof A.APIError) {
    const m = String((err as any)?.message || "");
    if (err.status === 402 || /credit|balance|billing|payment|quota|insufficient/i.test(m)) return "billing";
  }
  return null;
}

class NoCredentialError extends Error {}

/**
 * Corre `fn` con la primera clave disponible de la lista; si falla por la
 * clave (saldo, permiso, límite) y `canSwitch()` lo permite (en un chat: si
 * todavía no se mostró texto), la pone en pausa y prueba con la siguiente.
 */
async function withCredential<T>(
  fn: (client: Anthropic, cred: AiCredential) => Promise<T>,
  canSwitch: () => boolean = () => true,
  only?: string,
): Promise<{ value: T; cred: AiCredential }> {
  const all = listCredentials().filter(c => c.enabled && (!only || c.id === only));
  if (!all.length) throw new NoCredentialError("Manguito Pro todavía no tiene una clave de API activa.");
  const now = Date.now();
  let candidates = only ? all : all.filter(c => !isCoolingDown(c, now));
  // Todas en pausa: se reintenta la que lleva más tiempo en pausa (un 400/401 no cobra).
  if (!candidates.length) candidates = [...all].sort((a, b) => (a.failedAt ?? 0) - (b.failedAt ?? 0)).slice(0, 1);
  let lastErr: unknown = null;
  for (const cred of candidates) {
    try {
      const value = await fn(clientFor(cred), cred);
      if (cred.failedAt || !cred.lastOkAt || now - cred.lastOkAt > 3600e3) updateCredential(cred.id, { failedAt: null, failKind: "", lastOkAt: Date.now() });
      return { value, cred };
    } catch (err) {
      const kind = credentialFailure(err);
      if (!kind) throw err;
      updateCredential(cred.id, { failedAt: Date.now(), failKind: kind });
      console.warn(`⚠️ Manguito Pro: clave «${cred.label}» en pausa (${FAIL_TEXT[kind]})`);
      if (kind !== "rate") reportKeyProblem(cred, kind);
      lastErr = err;
      if (!canSwitch()) throw err;
    }
  }
  throw lastErr;
}

function usageOf(u: any): Usage {
  return {
    inputTokens:  Number(u?.input_tokens) || 0,
    outputTokens: Number(u?.output_tokens) || 0,
    cacheRead:    Number(u?.cache_read_input_tokens) || 0,
    cacheWrite:   Number(u?.cache_creation_input_tokens) || 0,
  };
}

/** Mensaje de error de la API apto para mostrar (sin claves ni detalles internos). */
export function friendlyApiError(err: unknown): string {
  if (err instanceof NoCredentialError) return err.message;
  let A: typeof Anthropic;
  try { A = sdk(); } catch { return "Manguito Pro no pudo iniciar (falta la librería de la API)."; }
  const kind = credentialFailure(err);
  if (kind === "billing") return "Las claves de la API se quedaron sin saldo (agrega otra en Configuración › Manguito Pro).";
  if (kind === "auth") return "La clave de la API no es válida o no tiene permiso.";
  if (kind === "rate") return "La API está ocupada (límite de uso). Intenta en un momento.";
  if (err instanceof A.BadRequestError) return "La API rechazó el pedido.";
  if (err instanceof A.APIConnectionError) return "No se pudo conectar con la API.";
  if (err instanceof A.APIError) return "La API respondió con un error (" + (err.status ?? "?") + ").";
  return "Algo falló al responder.";
}

// ── Prueba de conexión (botones del panel) ──

export async function testAiConnection(credId?: string): Promise<{ ok: true; model: string; ms: number; label: string } | { ok: false; message: string }> {
  const t0 = Date.now();
  try {
    const { value: r, cred } = await withCredential(client => client.messages.create({
      model: ROUTER_MODEL,
      max_tokens: 32,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Responde solo con la palabra: OK" }],
    }), () => !credId, credId);
    const u = usageOf(r.usage);
    logUsage({ customerId: 0, kind: "test", model: r.model, credId: cred.id, ...u, costUsd: costUsd(r.model, u) });
    return { ok: true, model: r.model, ms: Date.now() - t0, label: cred.label };
  } catch (err) {
    return { ok: false, message: friendlyApiError(err) };
  }
}

// ── Selector de modelo ──

const ROUTER_SYSTEM = [
  "Eres el selector de modelo de Manguito Pro. Lee el último mensaje del cliente y elige el modelo MÁS BARATO que lo resuelva bien.",
  "- rapido: saludos, charla, preguntas simples o de datos conocidos, traducciones o resúmenes de textos cortos, describir una imagen sencilla, continuar algo simple.",
  "- equilibrado: redactar textos largos, explicar temas a fondo, código normal, analizar imágenes o documentos con detalle, planes, matemáticas de colegio o universidad básica.",
  "- experto: razonamiento difícil de varios pasos, código complejo o depuración difícil, matemáticas o lógica avanzadas, análisis profundo donde un error cuesta caro.",
  "effort: low si es directo, medium si hay que pensar algo, high solo si es realmente difícil.",
  "Si el mensaje es una continuación corta de la charla (ej. «sigue», «y eso?», «dame otro»), mantén el modelo anterior.",
  "Ante la duda entre dos, elige el más barato.",
].join("\n");

const ROUTER_SCHEMA = {
  type: "object",
  properties: {
    tier:   { type: "string", enum: ["rapido", "equilibrado", "experto"] },
    effort: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["tier", "effort"],
  additionalProperties: false,
};

/** Sin llamar a la API: saludos y frases cortitas van directo al rápido. Lo que
 *  pide pensar (explicar, código, cálculos…) siempre pasa por el selector. */
const NEEDS_THOUGHT = /explica|analiza|c[oó]digo|program|calcul|resuelv|demuestr|compar|redact|escrib|traduc|resum|corrig|plan|estrategia|por\s*qu[eé]|c[oó]mo\s+(hago|funciona|se|puedo)/i;
const SMALL_TALK = /^(hola|holi|buen[oa]s|gracias|ok|okay|listo|chau|adi[oó]s|bye|perfecto|genial|excelente|s[ií]|no)\b/i;
function obviousRoute(text: string, imageCount: number, prevTier: Tier | null): { tier: Tier; effort: Effort } | null {
  const t = text.trim();
  if (imageCount > 0 || t.length > 30 || NEEDS_THOUGHT.test(t) || /[`{}<>=]|\d\s*[-+*/^]\s*\d/.test(t)) return null;
  // «dame otro», «y eso?» después de una respuesta difícil: que decida el
  // selector (mantiene el modelo); saludos y gracias siempre al rápido.
  if (prevTier && prevTier !== "rapido" && !SMALL_TALK.test(t)) return null;
  return { tier: "rapido", effort: "low" };
}

/** Si el selector falla: reglas simples. */
function fallbackRoute(text: string, imageCount: number): { tier: Tier; effort: Effort } {
  if (/```|function |class |def |SELECT |\bimport\b/.test(text) || text.length > 2500) return { tier: "equilibrado", effort: "medium" };
  if (imageCount > 0) return { tier: "equilibrado", effort: "low" };
  return { tier: "rapido", effort: "low" };
}

async function chooseRoute(
  customerId: number, text: string, imageCount: number, prevTier: Tier | null, source: UsageSource,
): Promise<{ tier: Tier; effort: Effort; how: "regla" | "selector" | "respaldo" }> {
  const quick = obviousRoute(text, imageCount, prevTier);
  if (quick) return { ...quick, how: "regla" };
  const summary = [
    prevTier ? `Modelo usado en el mensaje anterior: ${prevTier}.` : "Es el primer mensaje de la conversación.",
    imageCount ? `El cliente adjuntó ${imageCount} imagen(es).` : "",
    "Mensaje del cliente:",
    text.length > 1500 ? text.slice(0, 1500) + " […]" : text,
  ].filter(Boolean).join("\n");
  try {
    const { value: r, cred } = await withCredential(client => client.messages.create({
      model: ROUTER_MODEL,
      max_tokens: 200,
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: ROUTER_SCHEMA } },
      system: ROUTER_SYSTEM,
      messages: [{ role: "user", content: summary }],
    }));
    const u = usageOf(r.usage);
    logUsage({ customerId, kind: "router", model: r.model, credId: cred.id, ...u, costUsd: costUsd(r.model, u), source });
    const block = r.content.find(b => b.type === "text");
    const parsed = block && block.type === "text" ? JSON.parse(block.text) : null;
    if (parsed && parsed.tier in TIERS && ["low", "medium", "high"].includes(parsed.effort)) {
      return { tier: parsed.tier, effort: parsed.effort, how: "selector" };
    }
  } catch { /* sin selector: reglas simples */ }
  return { ...fallbackRoute(text, imageCount), how: "respaldo" };
}

// ── Historial que se manda (recortado para ahorrar) ──

export const UPLOAD_DIR = path.resolve(process.cwd(), "data", "ai-uploads");
// No se reenvía toda la conversación: solo lo que aún no está en el resumen
// (como mucho los 8 últimos mensajes). Lo anterior va en el resumen (corto)
// y lo duradero del cliente, en su memoria.
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS = 16_000;     // ~4 mil tokens de texto como máximo
const OLD_REPLY_CHARS = 1_500;        // respuestas anteriores a la última: recortadas
const IMAGE_TURNS_KEPT = 1;           // solo las imágenes del último mensaje con imagen

export function uploadPath(id: string, mediaType: string): string {
  const ext = mediaType === "image/png" ? "png" : mediaType === "image/webp" ? "webp" : mediaType === "image/gif" ? "gif" : "jpg";
  return path.join(UPLOAD_DIR, `${id}.${ext}`);
}

export function newUploadId(): string {
  return crypto.randomBytes(12).toString("hex");
}

function imageBlock(id: string): Anthropic.ImageBlockParam | null {
  const up = getUpload(id);
  if (!up) return null;
  try {
    const data = fs.readFileSync(uploadPath(id, up.mediaType)).toString("base64");
    return { type: "image", source: { type: "base64", media_type: up.mediaType as any, data } };
  } catch { return null; }
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n[…respuesta recortada para ahorrar]" : text;
}

function buildHistory(conversationId: number, summaryUpto: number): Anthropic.MessageParam[] {
  let msgs = listMessages(conversationId).filter(m => m.id > summaryUpto && (m.text.trim() || m.images.length));
  msgs = msgs.slice(-MAX_HISTORY_MESSAGES);
  let chars = msgs.reduce((s, m) => s + m.text.length, 0);
  while (msgs.length > 1 && chars > MAX_HISTORY_CHARS) { chars -= msgs[0]!.text.length; msgs = msgs.slice(1); }
  while (msgs.length && msgs[0]!.role !== "user") msgs = msgs.slice(1);

  const withImages = msgs.filter(m => m.role === "user" && m.images.length).slice(-IMAGE_TURNS_KEPT);
  const lastReply = [...msgs].reverse().find(m => m.role === "assistant");
  return msgs.map((m: AiMessage): Anthropic.MessageParam => {
    if (m.role === "assistant") {
      const t = m === lastReply ? m.text : clip(m.text, OLD_REPLY_CHARS);
      return { role: "assistant", content: t || "(respuesta interrumpida)" };
    }
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (m.images.length && withImages.includes(m)) {
      for (const id of m.images) { const b = imageBlock(id); if (b) blocks.push(b); }
    } else if (m.images.length) {
      blocks.push({ type: "text", text: `[El cliente envió ${m.images.length} imagen(es) antes; ya no se reenvían para ahorrar.]` });
    }
    blocks.push({ type: "text", text: m.text.trim() || "(imagen)" });
    return { role: "user", content: blocks };
  });
}

function systemPrompt(customerId: number, conv: AiConversation | null): string {
  const today = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10).split("-").reverse().join("/");
  const memory = customerState(customerId).memory.trim();
  const summary = conv?.summary?.trim() || "";
  return [
    "Eres Manguito Pro, el asistente de inteligencia artificial de Manguitope (liordark.com). Funcionas con modelos Claude de Anthropic; si te preguntan, puedes decirlo.",
    "Responde en el idioma del cliente (normalmente español de Perú), claro, cálido y directo. Usa Markdown sencillo cuando ayude (listas, negritas, tablas cortas, bloques de código con su lenguaje).",
    "Sé conciso y directo: da la respuesta primero, sin introducciones, sin repetir la pregunta y sin despedidas ni «¿te ayudo con algo más?». Por defecto, unas 150 palabras como máximo; extiéndete solo si el cliente lo pide o la tarea lo necesita (código completo, un documento). Si dice «sigue», continúa donde quedaste.",
    "No puedes crear ni editar videos, audio ni imágenes: si te lo piden, dilo con amabilidad y ofrece una alternativa en texto (un guion, una descripción, un prompt).",
    "No tienes acceso a internet ni a archivos fuera de esta conversación, y no ejecutas código: solo lo escribes para que el cliente lo use. Si no sabes algo con certeza, dilo.",
    `Fecha de hoy: ${today}.`,
    ...(memory ? ["", "Lo que recuerdas de este cliente (de conversaciones anteriores; úsalo con naturalidad, sin recitarlo):", memory] : []),
    ...(summary ? ["", "Resumen de la parte anterior de esta conversación (esos mensajes ya no se te muestran):", summary] : []),
  ].join("\n");
}

// ── Chat (con streaming hacia el navegador) ──

const activeChats = new Set<number>();
const recentByCustomer = new Map<number, number[]>();
const MAX_PER_MINUTE = 10;            // antispam (nadie escribe más rápido)

export type ChatEvent =
  | { type: "meta"; conversationId: number; tier: Tier; label: string }
  | { type: "text"; text: string }
  | { type: "done"; status: "ok" | "stopped" | "refusal" | "error"; messageId: number; message?: string };

export type ChatGate = { ok: true; source: Source } | { ok: false; status: number; message: string; code?: string };

/** ¿Puede escribir ahora? (configuración, saldo o topes, ritmo, una respuesta a la vez). */
const limaTime = (ms: number) => new Date(ms - 5 * 3600e3).toISOString().slice(11, 16);
const limaDayTime = (ms: number) => {
  const d = new Date(ms - 5 * 3600e3).toISOString();
  return `${d.slice(8, 10)}/${d.slice(5, 7)} a las ${d.slice(11, 16)}`;
};

export function chatGate(customerId: number): ChatGate {
  if (!isAiConfigured()) return { ok: false, status: 503, message: "Manguito Pro todavía no está conectado." };
  const pick = pickSource(customerId);
  if (!pick.ok) return pick;
  if (activeChats.has(customerId)) return { ok: false, status: 409, message: "Espera a que termine la respuesta anterior." };
  const now = Date.now();
  const recent = (recentByCustomer.get(customerId) || []).filter(t => now - t < 60e3);
  if (recent.length >= MAX_PER_MINUTE) return { ok: false, status: 429, message: "Vas muy rápido: espera un minuto y sigue." };
  return pick;
}

/** Con poco saldo, baja de nivel para no pasarse. */
function capTierByBudget(tier: Tier, left: number): Tier {
  if (left < 0.10) return "rapido";
  if (left < 0.40 && tier === "experto") return "equilibrado";
  return tier;
}

export async function runChat(opts: {
  customerId: number; conversationId: number; text: string; imageCount: number; source: Source;
  prevTier: Tier | null; signal: AbortSignal; emit: (e: ChatEvent) => void;
}): Promise<void> {
  const { customerId, conversationId, signal, emit, source } = opts;
  // Plan: la ventana de 3 horas empieza con el primer mensaje.
  if (source.kind === "plan") {
    const w = wallet(customerId);
    if (!(w.windowStart > 0 && Date.now() < w.windowStart + WINDOW_MS)) setWindowStart(customerId, Date.now());
  }
  activeChats.add(customerId);
  recentByCustomer.set(customerId, [...(recentByCustomer.get(customerId) || []).filter(t => Date.now() - t < 60e3), Date.now()]);

  let text = "";
  let tier: Tier = "rapido";
  let model = "";
  let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
  let status = "ok" as "ok" | "stopped" | "refusal" | "error";
  let errorMessage = "";
  let credId = "";
  try {
    const route = await chooseRoute(customerId, opts.text, opts.imageCount, opts.prevTier, source.kind);
    tier = capTierByBudget(route.tier, source.left);
    const cfg = TIERS[tier];
    model = cfg.model;
    emit({ type: "meta", conversationId, tier, label: cfg.label });

    // Rápido: sin pensar. Equilibrado: como mucho esfuerzo medio. Solo el
    // Experto puede pensar a fondo (nunca xhigh ni max).
    const effort: Effort = tier === "rapido" ? "low" : tier === "equilibrado" && route.effort === "high" ? "medium" : route.effort;
    const conv = getConversation(customerId, conversationId);
    const base = {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      system: systemPrompt(customerId, conv),
      messages: buildHistory(conversationId, conv?.summaryUpto ?? 0),
      thinking: tier === "rapido" ? { type: "disabled" as const } : { type: "adaptive" as const },
      output_config: { effort },
      cache_control: { type: "ephemeral" as const }, // la conversación queda en caché: releerla cuesta ~10 %
    };

    // Respaldo del lado de la API (si el modelo declina, sigue otro de su
    // misma familia, nunca Fable). Si el proveedor no lo acepta, se repite
    // sin él (un 400 no cobra tokens).
    const open = (client: Anthropic, withFallback: boolean) => withFallback && cfg.fallback
      ? client.beta.messages.stream({
          ...base,
          messages: base.messages as Anthropic.Beta.BetaMessageParam[],
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: [{ model: cfg.fallback }],
        }, { signal })
      : client.messages.stream(base, { signal });

    const consume = async (stream: ReturnType<typeof open>) => {
      text = ""; // un intento fallido con otra clave no dejó texto
      for await (const ev of stream as AsyncIterable<any>) {
        if (ev.type === "message_start") {
          model = ev.message?.model || model;
          usage = usageOf(ev.message?.usage);
        } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          text += ev.delta.text;
          emit({ type: "text", text: ev.delta.text });
        } else if (ev.type === "message_delta") {
          const u = usageOf(ev.usage);
          usage = {
            inputTokens:  Math.max(usage.inputTokens, u.inputTokens),
            outputTokens: Math.max(usage.outputTokens, u.outputTokens),
            cacheRead:    Math.max(usage.cacheRead, u.cacheRead),
            cacheWrite:   Math.max(usage.cacheWrite, u.cacheWrite),
          };
          if (ev.delta?.stop_reason === "refusal") status = "refusal";
          if (ev.delta?.stop_reason === "max_tokens") {
            const note = "\n\n_(Se cortó por largo. Escribe «sigue» y continúo.)_";
            text += note;
            emit({ type: "text", text: note });
          }
        }
      }
    };

    // Con la primera clave disponible; si esa se quedó sin saldo (o la
    // rechazan) antes de escribir nada, sigue con la siguiente de la lista.
    const { cred } = await withCredential(async client => {
      try {
        await consume(open(client, true));
      } catch (err) {
        if (!(err instanceof sdk().BadRequestError) || credentialFailure(err) || text || !cfg.fallback || signal.aborted) throw err;
        await consume(open(client, false));
      }
    }, () => !text && !signal.aborted);
    credId = cred.id;
  } catch (err) {
    let aborted = signal.aborted;
    try { aborted = aborted || err instanceof sdk().APIUserAbortError; } catch { /* sin SDK */ }
    if (aborted) status = "stopped";
    else { status = "error"; errorMessage = friendlyApiError(err); noteChatError(err); }
  } finally {
    activeChats.delete(customerId);
  }

  if (model && (usage.inputTokens || usage.outputTokens)) {
    logUsage({ customerId, kind: "chat", tier, model, credId, ...usage, costUsd: costUsd(model, usage), source: source.kind });
  }
  if (status === "refusal" && !text.trim()) text = "Lo siento, con eso no puedo ayudarte. ¿Te ayudo con otra cosa?";
  const messageId = addMessage({ conversationId, role: "assistant", text, tier, model, status });
  emit({ type: "done", status, messageId, ...(errorMessage ? { message: errorMessage } : {}) });
  afterChat(customerId, conversationId, status === "ok", source.kind);
}

// ── Pausa de 1 hora (como Claude) ──
// Si manda `burstMessages` mensajes en 5 horas, descansa 1 hora y luego
// sigue normal. Como mucho `pausesPerDay` pausas al día; después ya no
// pausa (solo queda el tope de gasto del día).

function burstCount(customerId: number): number {
  const since = Math.max(customerState(customerId).cooldownUntil, Date.now() - BURST_WINDOW_H * 3600e3);
  return chatsSince(customerId, since);
}

function maybePause(customerId: number): void {
  const cfg = aiConfig();
  if (!cfg.burstMessages || !cfg.pausesPerDay) return;
  if (burstCount(customerId) >= cfg.burstMessages) registerPause(customerId, Date.now() + COOLDOWN_MIN * 60e3, cfg.pausesPerDay);
}

/** Después de cada respuesta: ¿toca pausa?; resumen y memoria con el modelo
 *  más barato, en segundo plano (no hace esperar). */
function afterChat(customerId: number, conversationId: number, ok: boolean, source: UsageSource): void {
  if (source === "free") maybePause(customerId); // los planes tienen su ventana de 3 h; los créditos, sin límite
  if (!ok) return;
  const pending = bumpMessagesSinceMemory(customerId);
  void (async () => {
    await compactConversation(customerId, conversationId, source).catch(() => {});
    if (pending >= MEMORY_EVERY) await updateMemory(customerId, conversationId, source).catch(() => {});
  })();
}

// ── Compactación: lo viejo de cada conversación pasa a un resumen ──
// 1) Resumen (ahorra tokens): cuando hay más de SUMMARIZE_AT mensajes que
//    el resumen aún no cubre, todos menos los CONTEXT_KEEP últimos se suman
//    al resumen (con Haiku, el más barato). Esos ya no se mandan a la API.
// 2) Limpieza (ahorra espacio): con más de PRUNE_AT mensajes guardados, se
//    borran del servidor los ya resumidos y quedan a la vista los últimos
//    KEEP_VISIBLE. No llama a la API.
const SUMMARIZE_AT = 8;
const CONTEXT_KEEP = 4;
const PRUNE_AT = 24;
const KEEP_VISIBLE = 10;
const SUMMARY_MAX = 1500;
const MEMORY_MAX = 1200;
const MEMORY_EVERY = 6;          // la memoria se actualiza cada 6 mensajes del cliente
const MAX_CONVERSATIONS = 40;    // por cliente (las más viejas se borran)
const UPLOAD_DAYS = 14;          // las imágenes se borran a los 14 días
const compacting = new Set<number>();

function transcript(msgs: AiMessage[], maxChars: number): string {
  const lines = msgs.map(m => `${m.role === "user" ? "Cliente" : "Manguito"}: ${m.text.replace(/\s+/g, " ").trim()}${m.images.length ? ` [${m.images.length} imagen(es)]` : ""}`);
  let out = lines.join("\n");
  if (out.length > maxChars) out = "…" + out.slice(-maxChars);
  return out;
}

async function cheapText(customerId: number, kind: "compact" | "memory", source: UsageSource, system: string, user: string, maxTokens: number): Promise<string> {
  const { value: r, cred } = await withCredential(client => client.messages.create({
    model: ROUTER_MODEL,
    max_tokens: maxTokens,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system,
    messages: [{ role: "user", content: user }],
  }));
  const u = usageOf(r.usage);
  logUsage({ customerId, kind, model: r.model, credId: cred.id, ...u, costUsd: costUsd(r.model, u), source });
  const b = r.content.find(x => x.type === "text");
  return b && b.type === "text" ? b.text.trim() : "";
}

async function summarizeConversation(customerId: number, conversationId: number, source: UsageSource): Promise<void> {
  const conv = getConversation(customerId, conversationId);
  if (!conv) return;
  const fresh = listMessages(conversationId).filter(m => m.id > conv.summaryUpto);
  if (fresh.length <= SUMMARIZE_AT) return;
  // Quedan fuera del resumen los últimos CONTEXT_KEEP, empezando por un mensaje del cliente.
  let cut = fresh.length - CONTEXT_KEEP;
  while (cut < fresh.length && fresh[cut]!.role !== "user") cut++;
  const old = fresh.slice(0, cut);
  if (!old.length) return;
  const summary = await cheapText(customerId, "compact", source,
    "Resumes conversaciones para poder continuarlas sin releerlas. Escribe en español, en viñetas breves: el tema, datos y decisiones importantes, lo que el cliente pidió, lo que ya se le respondió (lo esencial, incluido código clave si hace falta para seguir) y lo que quedó pendiente. Nada de relleno. Nunca incluyas contraseñas, PIN, códigos de verificación ni números de tarjeta. Máximo 1200 caracteres.",
    (conv.summary ? `Resumen anterior:\n${conv.summary}\n\n` : "") + `Mensajes nuevos a resumir:\n${transcript(old, 24_000)}`,
    700);
  if (summary) setSummary(conversationId, old[old.length - 1]!.id, summary.slice(0, SUMMARY_MAX));
}

function pruneConversation(customerId: number, conversationId: number): void {
  const conv = getConversation(customerId, conversationId);
  const msgs = listMessages(conversationId);
  if (!conv || msgs.length <= PRUNE_AT) return;
  let cut = msgs.length - KEEP_VISIBLE;
  while (cut < msgs.length && msgs[cut]!.role !== "user") cut++;
  // Solo se borra lo que ya está en el resumen.
  const upto = Math.min(conv.summaryUpto, msgs[cut - 1]!.id);
  const gone = msgs.filter(m => m.id <= upto);
  if (!gone.length) return;
  pruneMessages(conversationId, upto);
  // Las imágenes de los mensajes borrados ya no se usan.
  const imgs = gone.flatMap(m => m.images);
  for (const id of imgs) { const up = getUpload(id); if (up) fs.promises.unlink(uploadPath(id, up.mediaType)).catch(() => {}); }
  deleteUploadRows(imgs);
}

export async function compactConversation(customerId: number, conversationId: number, source?: UsageSource): Promise<void> {
  if (compacting.has(conversationId)) return;
  compacting.add(conversationId);
  try {
    await summarizeConversation(customerId, conversationId, source ?? currentSourceKind(customerId));
    pruneConversation(customerId, conversationId);
  } finally {
    compacting.delete(conversationId);
  }
}

// ── Memoria («cerebro»): lo que Manguito recuerda de cada cliente ──

export async function updateMemory(customerId: number, conversationId: number, source: UsageSource): Promise<void> {
  const recent = listMessages(conversationId).slice(-12);
  if (!recent.some(m => m.role === "user" && m.text.trim())) return;
  const prev = customerState(customerId).memory;
  const next = await cheapText(customerId, "memory", source,
    [
      "Mantienes la memoria de un asistente sobre UN cliente: datos útiles y duraderos para ayudarlo mejor en el futuro (cómo prefiere que le respondan, su negocio o trabajo, proyectos en curso, temas que le interesan, su nombre si lo dijo).",
      "Devuelve SOLO la memoria actualizada, en viñetas cortas en español, máximo 1200 caracteres. Junta lo anterior con lo nuevo, quita lo repetido u obsoleto.",
      "NUNCA guardes contraseñas, PIN, códigos de verificación, números de tarjeta o de documento, direcciones exactas ni datos de terceros.",
      "Si no hay nada nuevo que valga la pena recordar, devuelve la memoria anterior tal cual.",
    ].join("\n"),
    `Memoria actual:\n${prev || "(vacía)"}\n\nConversación reciente:\n${transcript(recent, 12_000)}`,
    600);
  if (next) setMemory(customerId, next.slice(0, MEMORY_MAX));
}

export function getMemory(customerId: number): string {
  return customerState(customerId).memory;
}

export function clearMemory(customerId: number): void {
  setMemory(customerId, "");
}

/** Uso gratis (celulares de la lista del panel): % del mes, pausa y
 *  mensajes que le quedan antes de una pausa (null si hoy ya no pausa). */
function freeUsage(customerId: number): { monthPct: number; cooldownUntil: number; burstLeft: number | null } {
  const cfg = aiConfig();
  const monthly = capsFor(customerId, cfg).monthly;
  const pct = monthly > 0 ? Math.min(100, Math.round(spentThisMonthByCustomer(customerId) / monthly * 100)) : 100;
  const pause = customerState(customerId).cooldownUntil;
  const canPause = cfg.burstMessages > 0 && pausesToday(customerId) < cfg.pausesPerDay;
  return {
    monthPct: pct,
    cooldownUntil: pause > Date.now() ? pause : 0,
    burstLeft: canPause ? Math.max(0, cfg.burstMessages - burstCount(customerId)) : null,
  };
}

// ── Mantenimiento cada 3 horas: compactar, límite de conversaciones e imágenes ──

export async function manguitoMaintenance(): Promise<void> {
  try { await maintenanceSteps(); }
  catch (err: any) { incident("Manguito Pro: falló el mantenimiento automático", `Error: ${safeErr(err)}`); }
}

async function maintenanceSteps(): Promise<void> {
  if (!isAiConfigured()) return;
  cleanupPendingAiPurchases();
  try { sendWalletNotices(); } catch (err: any) { incident("Manguito Pro: no se pudieron mandar los avisos de vencimiento", `Error: ${safeErr(err)}`); }
  checkApiBalance();
  for (const c of conversationsToCompact(SUMMARIZE_AT)) {
    await compactConversation(c.customerId, c.id).catch(() => {});
  }
  for (const c of conversationsOverLimit(MAX_CONVERSATIONS)) {
    const imgs = deleteConversation(c.customerId, c.id) || [];
    for (const id of imgs) { const up = getUpload(id); if (up) fs.promises.unlink(uploadPath(id, up.mediaType)).catch(() => {}); }
    deleteUploadRows(imgs);
  }
  const old = oldUploads(UPLOAD_DAYS);
  for (const u of old) fs.promises.unlink(uploadPath(u.id, u.mediaType)).catch(() => {});
  deleteUploadRows(old.map(u => u.id));
}

let maintenanceTimer: NodeJS.Timeout | null = null;
export function startManguitoMaintenance(): void {
  if (maintenanceTimer) return;
  setTimeout(() => { manguitoMaintenance().catch(() => {}); }, 90_000);
  maintenanceTimer = setInterval(() => { manguitoMaintenance().catch(() => {}); }, 3 * 3600e3);
}

// ═════════════════════════════════════════════════════════════
// VENTA DE MANGUITO PRO — plan mensual o créditos (se pagan por Yape)
//
// · Plan mensual: un saldo en US$ por cada 30 días, con límites como
//   Claude para que no se gaste todo de golpe: cada 3 horas (ventana que
//   empieza con el primer mensaje) y por semana (% del saldo del mes).
// · Créditos: saldo en US$ sin límites de tiempo: se puede gastar en un día
//   y recargar. Se descuenta lo que cuesta cada respuesta.
// · Si el plan llegó a su límite y tiene créditos, sigue con los créditos.
// · Los celulares de la lista del panel siguen gratis con sus topes.
// El pago es un pedido web del bot (mismo Yape automático que el curso:
// courseId «manguito-…»); al confirmarse, el bot avisa a
// /api/stock/course-paid → onAiPurchasePaid.
// ═════════════════════════════════════════════════════════════

export type Source = { kind: UsageSource; left: number };
export const WINDOW_HOURS = 3;
const WINDOW_MS = WINDOW_HOURS * 3600e3;
const WEEK_MS = 7 * 24 * 3600e3;
const CYCLE_MS = 30 * 24 * 3600e3;
const MIN_CREDITS = 0.003;

const SK = { enabled: "ai_store_enabled", monthly: "ai_plan_monthly", packs: "ai_credit_packs", rate: "ai_exchange_rate", name: "ai_store_name", image: "ai_store_image" };
export type MonthlyPlan = { enabled: boolean; priceSoles: number; usd: number; weekPct: number; windowPct: number };
export type CreditPack = { priceSoles: number; usd: number };
export type StoreConfig = { enabled: boolean; rate: number; monthly: MonthlyPlan; packs: CreditPack[]; name: string; imageUrl: string };
// Cómo sale en el catálogo de la tienda y de mayoristas (Configuración → Catálogo).
export const DEFAULT_PRODUCT_NAME = "Manguito Pro · IA con Claude";
const DEFAULT_MONTHLY: MonthlyPlan = { enabled: true, priceSoles: 20, usd: 50, weekPct: 25, windowPct: 4 };
const DEFAULT_PACKS: CreditPack[] = [{ priceSoles: 20, usd: 50 }, { priceSoles: 45, usd: 100 }];

function readJson<T>(key: string, def: T): T {
  try { const v = getAdminSetting(key); return v ? JSON.parse(v) as T : def; } catch { return def; }
}

export function storeConfig(): StoreConfig {
  const m = { ...DEFAULT_MONTHLY, ...readJson<Partial<MonthlyPlan>>(SK.monthly, {}) };
  const packs = readJson<CreditPack[]>(SK.packs, DEFAULT_PACKS).filter(p => p && p.priceSoles > 0 && p.usd > 0).slice(0, 4);
  const image = getAdminSetting(SK.image) || "";
  return {
    enabled: getAdminSetting(SK.enabled) === "1", rate: num(getAdminSetting(SK.rate), 3.75), monthly: m, packs,
    name: (getAdminSetting(SK.name) || "").trim() || DEFAULT_PRODUCT_NAME,
    imageUrl: isLocalMedia(image) && mediaFilePath(image.slice(MEDIA_PREFIX.length)) ? image : "",
  };
}

/** Guarda la venta (panel). Devuelve un error legible o null. */
export function saveStoreConfig(body: any): string | null {
  const n = (v: unknown) => Number(String(v ?? "").replace(",", "."));
  if (body?.monthly) {
    const m = body.monthly;
    const plan: MonthlyPlan = {
      enabled: !!m.enabled, priceSoles: n(m.priceSoles), usd: n(m.usd), weekPct: n(m.weekPct), windowPct: n(m.windowPct),
    };
    if (!(plan.priceSoles > 0 && plan.priceSoles <= 5000)) return "Precio del plan mensual inválido.";
    if (!(plan.usd > 0 && plan.usd <= 1000)) return "Saldo del plan mensual inválido (US$ 0.01 a 1000).";
    if (!(plan.weekPct > 0 && plan.weekPct <= 100)) return "El límite semanal debe ser de 1 a 100 %.";
    if (!(plan.windowPct > 0 && plan.windowPct <= 100)) return "El límite de 3 horas debe ser de 1 a 100 %.";
    setAdminSetting(SK.monthly, JSON.stringify(plan));
  }
  if (Array.isArray(body?.packs)) {
    const packs: CreditPack[] = [];
    for (const p of body.packs.slice(0, 4)) {
      const price = n(p?.priceSoles), usd = n(p?.usd);
      if (!price && !usd) continue;
      if (!(price > 0 && price <= 5000 && usd > 0 && usd <= 1000)) return "Revisa los paquetes de créditos (precio en S/ y saldo en US$).";
      packs.push({ priceSoles: Math.round(price * 100) / 100, usd: Math.round(usd * 100) / 100 });
    }
    setAdminSetting(SK.packs, JSON.stringify(packs));
  }
  if (body?.rate !== undefined) {
    const r = n(body.rate);
    if (!(r > 1 && r < 10)) return "Tipo de cambio inválido.";
    setAdminSetting(SK.rate, String(r));
  }
  if (body?.enabled !== undefined) setAdminSetting(SK.enabled, body.enabled ? "1" : "0");
  if (body?.name !== undefined) {
    const name = String(body.name ?? "").replace(/\s+/g, " ").trim();
    if (name.length > 60) return "El nombre puede tener hasta 60 letras.";
    setAdminSetting(SK.name, name);
  }
  if (body?.imageUrl !== undefined) {
    // Solo imágenes subidas con «📷 Subir imagen» (guardadas en el servidor).
    const url = String(body.imageUrl ?? "").trim();
    if (url && !(isLocalMedia(url) && mediaFilePath(url.slice(MEDIA_PREFIX.length)))) return "Sube la imagen con «📷 Subir imagen».";
    setAdminSetting(SK.image, url);
  }
  return null;
}

// ── Estado del plan ──

export type Limit = { used: number; limit: number; resetsAt: number };
export type PlanStatus = { endsAt: number; usd: number; cycle: Limit; week: Limit; window: Limit };

function planStatus(customerId: number, w: AiWallet = wallet(customerId), now = Date.now()): PlanStatus | null {
  if (!(w.planEnd > now) || w.planUsd <= 0) return null;
  const cfg = storeConfig().monthly;
  const cycleStart = w.planStart + Math.floor((now - w.planStart) / CYCLE_MS) * CYCLE_MS;
  const cycleEnd = Math.min(cycleStart + CYCLE_MS, w.planEnd);
  const weekStart = cycleStart + Math.floor((now - cycleStart) / WEEK_MS) * WEEK_MS;
  const weekEnd = Math.min(weekStart + WEEK_MS, cycleEnd);
  const windowOpen = w.windowStart > 0 && now < w.windowStart + WINDOW_MS;
  const r2 = (x: number) => Math.round(x * 10000) / 10000;
  return {
    endsAt: w.planEnd,
    usd: w.planUsd,
    cycle: { used: r2(planSpentSince(customerId, cycleStart)), limit: w.planUsd, resetsAt: cycleEnd },
    week: { used: r2(planSpentSince(customerId, weekStart)), limit: r2(w.planUsd * cfg.weekPct / 100), resetsAt: weekEnd },
    window: windowOpen
      ? { used: r2(planSpentSince(customerId, Math.max(w.windowStart, cycleStart))), limit: r2(w.planUsd * cfg.windowPct / 100), resetsAt: w.windowStart + WINDOW_MS }
      : { used: 0, limit: r2(w.planUsd * cfg.windowPct / 100), resetsAt: 0 },
  };
}

function planBlock(p: PlanStatus): string | null {
  const plural = p.cycle.resetsAt >= p.endsAt ? "Tu plan vence" : "Se renueva";
  if (p.cycle.used >= p.cycle.limit) return `Usaste todo el saldo de este mes. ${plural} el ${limaDayTime(p.cycle.resetsAt)}.`;
  if (p.week.used >= p.week.limit) return `Llegaste al límite de esta semana. Se renueva el ${limaDayTime(p.week.resetsAt)}.`;
  if (p.window.resetsAt && p.window.used >= p.window.limit) return `☕ Llegaste al límite de estas ${WINDOW_HOURS} horas. Vuelve a las ${limaTime(p.window.resetsAt)} y sigues sin problema.`;
  return null;
}

function planLeft(p: PlanStatus): number {
  return Math.min(p.cycle.limit - p.cycle.used, p.week.limit - p.week.used, p.window.limit - p.window.used);
}

// ── ¿De dónde sale el próximo mensaje? plan → créditos → gratis ──

type FreeCheck = { ok: true; source: Source } | { ok: false; listed: boolean; status: number; message: string };

function freeSource(customerId: number): FreeCheck {
  const c = findCustomerById(customerId);
  if (!c || !isAiAllowedPhone(c.phone)) return { ok: false, listed: false, status: 402, message: "" };
  const cfg = aiConfig();
  const pause = customerState(customerId).cooldownUntil;
  if (pause > Date.now()) return { ok: false, listed: true, status: 429, message: `☕ Manguito está descansando después de mucho uso seguido. Vuelve a las ${limaTime(pause)} y sigues sin problema.` };
  if (spentThisMonth() >= cfg.monthlyCap) return { ok: false, listed: true, status: 429, message: "Manguito Pro llegó a su límite de este mes. Vuelve pronto 🥭" };
  const caps = capsFor(customerId, cfg);
  const month = spentThisMonthByCustomer(customerId), today = spentTodayByCustomer(customerId);
  if (month >= caps.monthly) return { ok: false, listed: true, status: 429, message: "Usaste todo tu Manguito Pro de este mes. El 1 del próximo mes se renueva 🥭" };
  if (today >= caps.daily) return { ok: false, listed: true, status: 429, message: "Llegaste al límite de uso de hoy. Mañana se renueva 🥭" };
  return { ok: true, source: { kind: "free", left: Math.min(caps.monthly - month, caps.daily - today, cfg.monthlyCap - spentThisMonth()) } };
}

type Pick = { ok: true; source: Source } | { ok: false; status: number; message: string; code: string };

export function pickSource(customerId: number): Pick {
  const w = wallet(customerId);
  const plan = planStatus(customerId, w);
  const blocked = plan ? planBlock(plan) : null;
  if (plan && !blocked) return { ok: true, source: { kind: "plan", left: planLeft(plan) } };
  if (w.credits > MIN_CREDITS) return { ok: true, source: { kind: "credits", left: w.credits } };
  const free = freeSource(customerId);
  if (free.ok) return free;
  const store = storeConfig();
  const canRecharge = store.enabled && store.packs.length > 0;
  if (blocked) return { ok: false, status: 429, code: "plan_limit", message: blocked + (canRecharge ? " Si no quieres esperar, puedes recargar créditos." : "") };
  if (free.listed) return { ok: false, status: free.status, code: "free_limit", message: free.message };
  if (hasPaidAiPurchase(customerId)) return { ok: false, status: 402, code: "no_balance", message: "Te quedaste sin saldo. Recarga para seguir conversando 🥭" };
  return { ok: false, status: 402, code: "no_access", message: "Para usar Manguito Pro elige un plan 🥭" };
}

function currentSourceKind(customerId: number): UsageSource {
  const p = pickSource(customerId);
  return p.ok ? p.source.kind : "free";
}

/** ¿Puede entrar al chat? Lista gratis del panel, plan vigente o créditos.
 *  Si no renueva, pierde el acceso pero sus conversaciones quedan guardadas
 *  (vuelven apenas paga). */
export function hasAiAccess(customer: { id: number; phone: string }): boolean {
  if (isAiAllowedPhone(customer.phone)) return true;
  const w = wallet(customer.id);
  return w.credits > MIN_CREDITS || w.planEnd > Date.now();
}

/** Cliente que pagó antes y ya no tiene saldo: para el aviso «renueva». */
export function lapsedInfo(customerId: number): { planEnd: number; conversations: number } | null {
  if (!hasPaidAiPurchase(customerId)) return null;
  return { planEnd: wallet(customerId).planEnd || 0, conversations: countConversations(customerId) };
}

// ── Medidor para el cliente ──

export function customerMeter(customerId: number) {
  const w = wallet(customerId);
  const now = Date.now();
  const plan = planStatus(customerId, w, now);
  const c = findCustomerById(customerId);
  const listed = !!c && isAiAllowedPhone(c.phone);
  const day = creditsSpentSince(customerId, now - 24 * 3600e3);
  const avg = avgCostPerMessage(customerId) || 0.02;
  const pick = pickSource(customerId);
  return {
    plan,
    credits: (w.credits > 0 || hasPaidAiPurchase(customerId)) ? {
      balance: Math.round(w.credits * 10000) / 10000,
      spent24h: Math.round(day.usd * 10000) / 10000,
      messages24h: day.messages,
      estMessages: Math.floor(w.credits / avg),
      hoursLeft: w.credits > MIN_CREDITS && day.usd > 0.001 ? Math.round(w.credits / (day.usd / 24) * 10) / 10 : null,
    } : null,
    free: listed ? freeUsage(customerId) : null,
    canChat: pick.ok,
    source: pick.ok ? pick.source.kind : null,
    block: pick.ok ? null : { code: pick.code, message: pick.message },
  };
}

/** Lo que la tienda y la página de planes muestran (sin sesión también). */
export function publicStoreInfo(phone?: string) {
  const s = storeConfig();
  const discount = aiDiscountFor(phone);
  return {
    enabled: s.enabled && isAiConfigured(),
    name: s.name,
    imageUrl: s.imageUrl,
    windowHours: WINDOW_HOURS,
    discount, // mayoristas: S/ 5 menos (precios ya descontados)
    monthly: s.monthly.enabled ? { priceSoles: discounted(s.monthly.priceSoles, discount), basePrice: s.monthly.priceSoles, usd: s.monthly.usd, weekPct: s.monthly.weekPct, windowPct: s.monthly.windowPct } : null,
    packs: s.packs.map(p => ({ priceSoles: discounted(p.priceSoles, discount), basePrice: p.priceSoles, usd: p.usd })),
  };
}

// ── Compra ──

export async function startAiPurchase(customer: { id: number; phone: string }, kind: "plan" | "credits", pack: number):
  Promise<{ ok: true; orderName: string; amount: string } | { ok: false; status: number; message: string }> {
  const s = storeConfig();
  if (!s.enabled || !isAiConfigured()) return { ok: false, status: 403, message: "Manguito Pro todavía no está a la venta." };
  let price: number, usd: number, label: string;
  if (kind === "plan") {
    if (!s.monthly.enabled) return { ok: false, status: 400, message: "El plan mensual no está disponible." };
    price = s.monthly.priceSoles; usd = s.monthly.usd; label = "Manguito Pro — Plan mensual";
  } else {
    const p = s.packs[pack];
    if (!p) return { ok: false, status: 400, message: "Ese paquete ya no existe. Recarga la página." };
    price = p.priceSoles; usd = p.usd; label = `Manguito Pro — Créditos US$ ${p.usd}`;
  }
  const discount = aiDiscountFor(customer.phone);
  if (discount) { price = discounted(price, discount); label += " (mayorista)"; }
  try {
    const r = await axios.post(
      env.BOT_BASE_URL + "/api/web-orders",
      { phone: normalizePeruPhone(customer.phone), course: { courseId: kind === "plan" ? "manguito-plan" : "manguito-creditos", price, label } },
      { headers: { "x-dashboard-key": env.DASHBOARD_API_KEY }, timeout: 15_000 },
    );
    const { orderName, amount } = r.data as { orderName: string; amount: string };
    if (!orderName) throw new Error("sin pedido");
    createAiPurchase({ customerId: customer.id, orderName, kind, amountSoles: String(amount ?? price), usd });
    return { ok: true, orderName, amount: String(amount) };
  } catch (err: any) {
    return { ok: false, status: err?.response?.status || 502, message: err?.response?.data?.message || "No se pudo crear el pago. Intenta de nuevo." };
  }
}

export function aiPurchaseStatus(customerId: number, orderName: string): { found: boolean; paid: boolean } {
  const p = findAiPurchase(orderName);
  if (!p || p.customerId !== customerId) return { found: false, paid: false };
  return { found: true, paid: p.status === "paid" };
}

/** El bot confirmó el Yape. null si no es una compra de Manguito Pro. */
export function onAiPurchasePaid(orderName: string, amount?: string): { ok: boolean; alreadyPaid?: boolean; label?: string } | null {
  if (!findAiPurchase(orderName)) return null;
  const r = markAiPurchasePaid(orderName, amount);
  const p = r.purchase;
  if (r.ok && !r.alreadyPaid) setImmediate(() => { try { checkApiBalance(); } catch { /* no crítico */ } });
  return { ok: r.ok, alreadyPaid: !!r.alreadyPaid, label: p ? (p.kind === "plan" ? "Plan mensual" : `Créditos US$ ${p.usd}`) : "" };
}

// ── Panel ──

export function storeAdminView() {
  const s = storeConfig();
  const now = Date.now();
  return {
    store: s,
    outstanding: outstandingBalance(),
    apiBalance: apiBalance(),
    month: salesThisMonth(),
    purchases: recentAiPurchases(30),
    subscribers: subscribersSummary().map(r => ({
      phone: r.phone, planActive: r.planEnd > now, planEnd: r.planEnd, planUsd: r.planUsd,
      credits: Math.round(r.credits * 100) / 100, paidSoles: r.paidSoles, giftsUsd: r.giftsUsd,
      spentUsd: Math.round(r.spentUsd * 10000) / 10000, monthUsd: Math.round(r.monthUsd * 10000) / 10000,
      lastAt: r.lastAt, wholesaler: aiDiscountFor(r.phone) > 0,
    })),
  };
}

/** Regalar créditos o 30 días de plan a un cliente (por celular). */
export function giftToPhone(phoneRaw: string, kind: "plan" | "credits", usdRaw: unknown): string | null {
  const phone = normalizePeruPhone(String(phoneRaw || ""));
  const c = findCustomerByPhone(phone);
  if (!c) return "No hay un cliente con ese celular en la tienda.";
  const usd = Number(String(usdRaw ?? "").replace(",", "."));
  const amount = kind === "plan" ? (usd > 0 ? usd : storeConfig().monthly.usd) : usd;
  if (!(amount > 0 && amount <= 1000)) return "Monto inválido (US$ 0.01 a 1000).";
  giftAi(c.id, kind, Math.round(amount * 100) / 100);
  return null;
}

// ═════════════════════════════════════════════════════════════
// INCIDENCIAS AUTOMÁTICAS (panel › Soportes) y AVISOS
// Si Manguito Pro se rompe (claves sin saldo o inválidas, errores
// seguidos al responder, mantenimiento que falla, pago sin compra), queda
// una incidencia en Soportes con QUÉ pasó. Solo texto: nunca la clave,
// nunca lo que escribió un cliente. No se repite mientras siga abierta.
// ═════════════════════════════════════════════════════════════

const limaStamp = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 16).replace("T", " ");

export function safeErr(err: unknown): string {
  const e = err as any;
  const status = e?.status ? `HTTP ${e.status} · ` : "";
  // Sin claves ni datos: solo el tipo y el mensaje del proveedor, recortado.
  const msg = String(e?.error?.error?.message || e?.message || e || "desconocido")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-…").replace(/\s+/g, " ").slice(0, 300);
  return status + msg;
}

function incident(title: string, details: string): void {
  try { createSystemIncident(title, `${details}\n\n🕒 ${limaStamp()} (hora Lima)`); }
  catch (err: any) { console.error("⚠️ No se pudo crear la incidencia:", err?.message); }
}

function keyStates(): string {
  return listCredentials().map((c, i) => {
    const st = credentialState(c);
    return `${i + 1}. ${c.label}: ${st.state === "ok" ? "activa" : st.state === "off" ? "desactivada" : "en pausa (" + st.reason + ")"}`;
  }).join("\n") || "(sin claves)";
}

function reportKeyProblem(cred: AiCredential, kind: FailKind): void {
  const usable = listCredentials().filter(c => c.enabled && !isCoolingDown(c)).length;
  if (kind === "billing") {
    incident(`Manguito Pro: la clave «${cred.label}» se quedó sin saldo`,
      `Recarga saldo en esa cuenta de la API o agrega otra clave en Configuración › 🥭 Manguito Pro.\n` +
      (usable ? `Mientras tanto sigue con las otras claves (${usable} activa/s).` : `⚠️ No queda ninguna clave activa: Manguito Pro NO está respondiendo.`) +
      `\n\nClaves:\n${keyStates()}`);
  } else {
    incident(`Manguito Pro: la clave «${cred.label}» fue rechazada`,
      `La API dijo que la clave es inválida o no tiene permiso (¿la borraron o la cambiaron?). Revísala o agrega otra en Configuración › 🥭 Manguito Pro.\n` +
      (usable ? `Sigue con las otras claves (${usable} activa/s).` : `⚠️ No queda ninguna clave activa: Manguito Pro NO está respondiendo.`) +
      `\n\nClaves:\n${keyStates()}`);
  }
}

// Errores al responder: 3 o más en 10 minutos → incidencia.
const chatErrors: { at: number; kind: string }[] = [];
function noteChatError(err: unknown): void {
  if (err instanceof NoCredentialError) {
    incident("Manguito Pro: no hay claves activas", "Nadie puede usar el chat. Agrega o activa una clave en Configuración › 🥭 Manguito Pro.");
    return;
  }
  const now = Date.now();
  chatErrors.push({ at: now, kind: safeErr(err) });
  while (chatErrors.length && now - chatErrors[0]!.at > 10 * 60e3) chatErrors.shift();
  if (chatErrors.length >= 3) {
    const counts = new Map<string, number>();
    for (const e of chatErrors) counts.set(e.kind, (counts.get(e.kind) || 0) + 1);
    incident("Manguito Pro: errores seguidos al responder",
      `${chatErrors.length} respuestas fallaron en los últimos 10 minutos.\n\n` +
      [...counts].map(([k, n]) => `• ${n}× ${k}`).join("\n") + `\n\nClaves:\n${keyStates()}`);
    chatErrors.length = 0;
  }
}

/** El bot confirmó un Yape de Manguito Pro pero la compra no existe en el panel. */
export function reportOrphanAiPayment(orderName: string, amount: string): void {
  incident("Manguito Pro: pago confirmado sin compra",
    `El bot confirmó el Yape del pedido ${orderName} (S/ ${amount || "?"}) pero no se encontró la compra en el panel, así que no se acreditó nada.\n` +
    `El celular va al inicio del pedido (web-<celular>-…). Dale su saldo con «Regalar saldo» en Configuración › 🥭 Manguito Pro.`);
}

// ── Saldo de la API («stock»): pedir recarga a tiempo ──

export function apiBalance(): { known: boolean; remaining: number; keys: number } {
  let remaining = 0, keys = 0;
  for (const c of listCredentials()) {
    if (!c.enabled || c.budgetUsd === null || c.budgetUsd === undefined || !c.budgetAt) continue;
    keys++;
    remaining += Math.max(0, c.budgetUsd - spentByCredentialSince(c.id, c.budgetAt));
  }
  return { known: keys > 0, remaining: Math.round(remaining * 100) / 100, keys };
}

export function checkApiBalance(): void {
  const bal = apiBalance();
  if (!bal.known) return;
  const o = outstandingBalance();
  const owed = Math.round((o.credits + o.plans) * 100) / 100;
  if (bal.remaining < 10 || bal.remaining < owed) {
    incident("Manguito Pro: pide más saldo para la API",
      `Queda ≈ US$ ${bal.remaining.toFixed(2)} en las claves (según el saldo que anotaste en el panel y lo gastado desde entonces).\n` +
      `Saldo vendido a clientes aún sin usar: US$ ${owed.toFixed(2)} (créditos US$ ${o.credits.toFixed(2)} + planes US$ ${o.plans.toFixed(2)}).\n\n` +
      `Recarga la cuenta de la API (o crea otra clave) y anota el saldo nuevo en Configuración › 🥭 Manguito Pro › Claves.`);
  }
}

// ── Avisos al cliente (campanita): plan por vencer / vencido, créditos ──

function sendWalletNotices(): void {
  const now = Date.now();
  for (const w of walletsForNotices()) {
    if (!w.phone) continue;
    const notify = (msg: string) => createCustomerNotification(w.phone, "manguito", "MANGUITO PRO", "", msg);
    if (w.planEnd > now && w.planEnd - now < 3 * 864e5 && w.noticeExpiring !== w.planEnd) {
      notify(`⏰ Tu plan de Manguito Pro vence el ${limaDayTime(w.planEnd)}. Renuévalo con Yape desde Manguito Pro › Planes y recargas.`);
      setWalletNotice(w.customerId, "notice_expiring", w.planEnd);
    }
    if (w.planEnd > 0 && w.planEnd <= now && now - w.planEnd < 7 * 864e5 && w.noticeExpired !== w.planEnd) {
      notify("Tu plan de Manguito Pro venció. Tus conversaciones siguen guardadas: renuévalo con Yape y continúas donde lo dejaste 🥭");
      setWalletNotice(w.customerId, "notice_expired", w.planEnd);
    }
    const ref = w.lastCreditsUsd || 0;
    if (ref > 0 && w.credits > MIN_CREDITS && w.credits < ref * 0.1 && !w.noticeLow) {
      notify(`🔋 Te queda poco saldo de créditos en Manguito Pro (US$ ${w.credits.toFixed(2)}). Recarga cuando quieras.`);
      setWalletNotice(w.customerId, "notice_low", 1);
    }
    if (ref > 0 && w.credits <= MIN_CREDITS && !w.noticeOut && w.planEnd <= now) {
      notify("Se acabaron tus créditos de Manguito Pro. Recarga con Yape para seguir conversando 🥭");
      setWalletNotice(w.customerId, "notice_out", 1);
    }
  }
}

// ── Mayoristas: S/ 5 menos ──

export const WHOLESALE_DISCOUNT = 5;
export function aiDiscountFor(phone: string | undefined): number {
  if (!phone) return 0;
  const w = findWholesalerByPhone(phone);
  return w && w.status === "active" ? WHOLESALE_DISCOUNT : 0;
}
export const discounted = (price: number, discount: number) => Math.max(1, Math.round((price - discount) * 100) / 100);
