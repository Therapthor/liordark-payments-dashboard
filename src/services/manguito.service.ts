import fs from "fs";
import path from "path";
import crypto from "crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { getAdminSetting, setAdminSetting } from "../db/security.repository";
import {
  addMessage, listMessages, logUsage, spentThisMonth, spentTodayByCustomer, getUpload,
  type AiMessage,
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
//   bajo por defecto, historial recortado (solo los últimos mensajes y solo
//   las imágenes recientes), caché de la conversación (90 % más barato al
//   releer), imágenes achicadas en el navegador y topes de gasto por día
//   (por cliente) y por mes (total). Con poco saldo del día baja de nivel.
// La clave de la API se guarda en el panel (nunca en el código ni en git)
// y nunca sale hacia el navegador.
// ─────────────────────────────────────────────────────────────

export type Tier = "rapido" | "equilibrado" | "experto";
type Effort = "low" | "medium" | "high";

export const TIERS: Record<Tier, { model: string; label: string; maxTokens: number; fallback: string | null }> = {
  rapido:      { model: "claude-haiku-5-5",  label: "⚡ Rápido",      maxTokens: 4096,  fallback: null },
  equilibrado: { model: "claude-sonnet-5-5", label: "🧠 Equilibrado", maxTokens: 8192,  fallback: "claude-sonnet-5" },
  experto:     { model: "claude-opus-5-5",   label: "🏆 Experto",     maxTokens: 16000, fallback: "claude-opus-4-8" },
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
  apiKey: "ai_api_key", authToken: "ai_auth_token", baseUrl: "ai_base_url",
  phones: "ai_allowed_phones", dailyCap: "ai_daily_cap_usd", monthlyCap: "ai_monthly_cap_usd",
};
export const DEFAULT_DAILY_CAP = 3;
export const DEFAULT_MONTHLY_CAP = 50;

export type AiConfig = {
  apiKey: string; authToken: string; baseUrl: string; phones: string[]; dailyCap: number; monthlyCap: number;
};

function num(v: string | null, def: number): number {
  const n = Number(v);
  return v !== null && v !== "" && isFinite(n) && n >= 0 ? n : def;
}

export function aiConfig(): AiConfig {
  return {
    apiKey:     (getAdminSetting(K.apiKey) || "").trim(),
    authToken:  (getAdminSetting(K.authToken) || "").trim(),
    baseUrl:    (getAdminSetting(K.baseUrl) || "").trim(),
    phones:     (getAdminSetting(K.phones) || "").split(",").map(s => s.trim()).filter(Boolean),
    dailyCap:   num(getAdminSetting(K.dailyCap), DEFAULT_DAILY_CAP),
    monthlyCap: num(getAdminSetting(K.monthlyCap), DEFAULT_MONTHLY_CAP),
  };
}

export function isAiConfigured(): boolean {
  const c = aiConfig();
  return !!(c.apiKey || c.authToken);
}

const last9 = (p: string) => String(p || "").replace(/\D/g, "").slice(-9);

export function isAiAllowedPhone(phone: string): boolean {
  const d = last9(phone);
  return d.length === 9 && aiConfig().phones.includes(d);
}

/** Guarda lo que vino (campos ausentes no se tocan). Devuelve un error legible o null. */
export function saveAiConfig(body: any): string | null {
  const secret = (v: unknown) => String(v ?? "").trim();
  if (body?.clearCredentials) {
    setAdminSetting(K.apiKey, "");
    setAdminSetting(K.authToken, "");
  }
  if (body?.apiKey !== undefined && secret(body.apiKey)) {
    const v = secret(body.apiKey);
    if (v.length < 20 || v.length > 400 || /\s/.test(v)) return "Esa clave de API no parece válida.";
    setAdminSetting(K.apiKey, v);
    setAdminSetting(K.authToken, ""); // una sola forma de entrar: clave o token
  }
  if (body?.authToken !== undefined && secret(body.authToken)) {
    const v = secret(body.authToken);
    if (v.length < 20 || v.length > 2000 || /\s/.test(v)) return "Ese token no parece válido.";
    setAdminSetting(K.authToken, v);
    setAdminSetting(K.apiKey, "");
  }
  if (body?.baseUrl !== undefined) {
    const v = secret(body.baseUrl).replace(/\/+$/, "");
    if (v) {
      let u: URL;
      try { u = new URL(v); } catch { return "La dirección (base URL) no es válida."; }
      const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
      if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return "La dirección (base URL) debe empezar con https://";
    }
    setAdminSetting(K.baseUrl, v);
  }
  if (body?.phones !== undefined) {
    const list = String(body.phones).split(/[\s,;]+/).map(last9).filter(p => p.length === 9);
    setAdminSetting(K.phones, [...new Set(list)].join(","));
  }
  for (const [field, key] of [["dailyCap", K.dailyCap], ["monthlyCap", K.monthlyCap]] as const) {
    if (body?.[field] === undefined) continue;
    const n = Number(body[field]);
    if (!isFinite(n) || n < 0 || n > 10000) return "El tope debe ser un monto entre 0 y 10000 dólares.";
    setAdminSetting(key, String(Math.round(n * 100) / 100));
  }
  return null;
}

function makeClient(): Anthropic | null {
  const c = aiConfig();
  if (!c.apiKey && !c.authToken) return null;
  const Client = sdk();
  const base = c.baseUrl ? { baseURL: c.baseUrl } : {};
  return c.apiKey
    ? new Client({ apiKey: c.apiKey, ...base, maxRetries: 2 })
    : new Client({ authToken: c.authToken, ...base, maxRetries: 2 });
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
  let A: typeof Anthropic;
  try { A = sdk(); } catch { return "Manguito Pro no pudo iniciar (falta la librería de la API)."; }
  if (err instanceof A.AuthenticationError) return "La clave de la API no es válida (revisa Configuración › Manguito Pro).";
  if (err instanceof A.PermissionDeniedError) return "La cuenta de la API no tiene permiso para este modelo.";
  if (err instanceof A.RateLimitError) return "La API está ocupada (límite de uso). Intenta en un momento.";
  if (err instanceof A.BadRequestError) {
    const m = String((err as any)?.message || "");
    if (/credit|balance|billing/i.test(m)) return "La cuenta de la API se quedó sin saldo.";
    return "La API rechazó el pedido.";
  }
  if (err instanceof A.APIConnectionError) return "No se pudo conectar con la API.";
  if (err instanceof A.APIError) return "La API respondió con un error (" + (err.status ?? "?") + ").";
  return "Algo falló al responder.";
}

// ── Prueba de conexión (botón del panel) ──

export async function testAiConnection(): Promise<{ ok: true; model: string; ms: number } | { ok: false; message: string }> {
  const t0 = Date.now();
  let client: Anthropic | null;
  try { client = makeClient(); } catch (err) { return { ok: false, message: friendlyApiError(err) }; }
  if (!client) return { ok: false, message: "Primero guarda la clave de la API (o el token)." };
  try {
    const r = await client.messages.create({
      model: ROUTER_MODEL,
      max_tokens: 32,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Responde solo con la palabra: OK" }],
    });
    const u = usageOf(r.usage);
    logUsage({ customerId: 0, kind: "test", model: r.model, ...u, costUsd: costUsd(r.model, u) });
    return { ok: true, model: r.model, ms: Date.now() - t0 };
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
  client: Anthropic, customerId: number, text: string, imageCount: number, prevTier: Tier | null,
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
    const r = await client.messages.create({
      model: ROUTER_MODEL,
      max_tokens: 200,
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: ROUTER_SCHEMA } },
      system: ROUTER_SYSTEM,
      messages: [{ role: "user", content: summary }],
    });
    const u = usageOf(r.usage);
    logUsage({ customerId, kind: "router", model: r.model, ...u, costUsd: costUsd(r.model, u) });
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
const MAX_HISTORY_MESSAGES = 14;
const MAX_HISTORY_CHARS = 60_000;     // ~15 mil tokens de texto como máximo
const IMAGE_TURNS_KEPT = 2;           // solo las imágenes de los 2 últimos mensajes con imagen

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

function buildHistory(conversationId: number): Anthropic.MessageParam[] {
  let msgs = listMessages(conversationId).filter(m => m.text.trim() || m.images.length);
  msgs = msgs.slice(-MAX_HISTORY_MESSAGES);
  let chars = msgs.reduce((s, m) => s + m.text.length, 0);
  while (msgs.length > 1 && chars > MAX_HISTORY_CHARS) { chars -= msgs[0]!.text.length; msgs = msgs.slice(1); }
  while (msgs.length && msgs[0]!.role !== "user") msgs = msgs.slice(1);

  const withImages = msgs.filter(m => m.role === "user" && m.images.length).slice(-IMAGE_TURNS_KEPT);
  return msgs.map((m: AiMessage): Anthropic.MessageParam => {
    if (m.role === "assistant") return { role: "assistant", content: m.text || "(respuesta interrumpida)" };
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

function systemPrompt(): string {
  const today = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10).split("-").reverse().join("/");
  return [
    "Eres Manguito Pro, el asistente de inteligencia artificial de Manguitope (liordark.com). Funcionas con modelos Claude de Anthropic; si te preguntan, puedes decirlo.",
    "Responde en el idioma del cliente (normalmente español de Perú), claro, cálido y directo. Usa Markdown sencillo cuando ayude (listas, negritas, tablas cortas, bloques de código con su lenguaje).",
    "Sé breve por defecto: responde lo que se pidió, sin relleno; extiéndete solo si el cliente lo pide o el tema lo necesita.",
    "No puedes crear ni editar videos, audio ni imágenes: si te lo piden, dilo con amabilidad y ofrece una alternativa en texto (un guion, una descripción, un prompt).",
    "No tienes acceso a internet ni a archivos fuera de esta conversación. Si no sabes algo con certeza, dilo.",
    `Fecha de hoy: ${today}.`,
  ].join("\n");
}

// ── Chat (con streaming hacia el navegador) ──

const activeChats = new Set<number>();
const recentByCustomer = new Map<number, number[]>();
const MAX_PER_HOUR = 40;

export type ChatEvent =
  | { type: "meta"; conversationId: number; tier: Tier; label: string }
  | { type: "text"; text: string }
  | { type: "done"; status: "ok" | "stopped" | "refusal" | "error"; messageId: number; message?: string };

export type ChatGate = { ok: true } | { ok: false; status: number; message: string };

/** ¿Puede escribir ahora? (configuración, topes, ritmo, una respuesta a la vez). */
export function chatGate(customerId: number): ChatGate {
  if (!isAiConfigured()) return { ok: false, status: 503, message: "Manguito Pro todavía no está conectado." };
  const cfg = aiConfig();
  if (spentThisMonth() >= cfg.monthlyCap) return { ok: false, status: 429, message: "Manguito Pro llegó a su límite de este mes. Vuelve pronto 🥭" };
  if (spentTodayByCustomer(customerId) >= cfg.dailyCap) return { ok: false, status: 429, message: "Llegaste al límite de uso de hoy. Mañana se renueva 🥭" };
  if (activeChats.has(customerId)) return { ok: false, status: 409, message: "Espera a que termine la respuesta anterior." };
  const now = Date.now();
  const recent = (recentByCustomer.get(customerId) || []).filter(t => now - t < 3600e3);
  if (recent.length >= MAX_PER_HOUR) return { ok: false, status: 429, message: "Vas muy rápido: espera unos minutos y sigue." };
  return { ok: true };
}

/** Con poco saldo del día, baja de nivel para no pasarse. */
function capTierByBudget(tier: Tier, customerId: number): Tier {
  const left = aiConfig().dailyCap - spentTodayByCustomer(customerId);
  if (left < 0.10) return "rapido";
  if (left < 0.40 && tier === "experto") return "equilibrado";
  return tier;
}

export async function runChat(opts: {
  customerId: number; conversationId: number; text: string; imageCount: number;
  prevTier: Tier | null; signal: AbortSignal; emit: (e: ChatEvent) => void;
}): Promise<void> {
  const { customerId, conversationId, signal, emit } = opts;
  let client: Anthropic | null = null;
  try { client = makeClient(); } catch { client = null; }
  if (!client) {
    const id = addMessage({ conversationId, role: "assistant", text: "", status: "error" });
    emit({ type: "done", status: "error", messageId: id, message: "Manguito Pro todavía no está conectado." });
    return;
  }
  activeChats.add(customerId);
  recentByCustomer.set(customerId, [...(recentByCustomer.get(customerId) || []).filter(t => Date.now() - t < 3600e3), Date.now()]);

  let text = "";
  let tier: Tier = "rapido";
  let model = "";
  let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
  let status = "ok" as "ok" | "stopped" | "refusal" | "error";
  let errorMessage = "";
  try {
    const route = await chooseRoute(client, customerId, opts.text, opts.imageCount, opts.prevTier);
    tier = capTierByBudget(route.tier, customerId);
    const cfg = TIERS[tier];
    model = cfg.model;
    emit({ type: "meta", conversationId, tier, label: cfg.label });

    const base = {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      system: systemPrompt(),
      messages: buildHistory(conversationId),
      thinking: { type: "adaptive" as const },
      output_config: { effort: route.effort },
      cache_control: { type: "ephemeral" as const }, // la conversación queda en caché: releerla cuesta ~10 %
    };

    // Respaldo del lado de la API (si el modelo declina, sigue otro de su
    // misma familia, nunca Fable). Si el proveedor no lo acepta, se repite
    // sin él (un 400 no cobra tokens).
    const open = (withFallback: boolean) => withFallback && cfg.fallback
      ? client.beta.messages.stream({
          ...base,
          messages: base.messages as Anthropic.Beta.BetaMessageParam[],
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: [{ model: cfg.fallback }],
        }, { signal })
      : client.messages.stream(base, { signal });

    const consume = async (stream: ReturnType<typeof open>) => {
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
        }
      }
    };

    try {
      await consume(open(true));
    } catch (err) {
      if (!(err instanceof sdk().BadRequestError) || text || !cfg.fallback || signal.aborted) throw err;
      await consume(open(false));
    }
  } catch (err) {
    if (signal.aborted || err instanceof sdk().APIUserAbortError) status = "stopped";
    else { status = "error"; errorMessage = friendlyApiError(err); }
  } finally {
    activeChats.delete(customerId);
  }

  if (model && (usage.inputTokens || usage.outputTokens)) {
    logUsage({ customerId, kind: "chat", tier, model, ...usage, costUsd: costUsd(model, usage) });
  }
  if (status === "refusal" && !text.trim()) text = "Lo siento, con eso no puedo ayudarte. ¿Te ayudo con otra cosa?";
  const messageId = addMessage({ conversationId, role: "assistant", text, tier, model, status });
  emit({ type: "done", status, messageId, ...(errorMessage ? { message: errorMessage } : {}) });
}
