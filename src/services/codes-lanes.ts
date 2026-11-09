// ─────────────────────────────────────────────────────────────
// COLA POR PROVEEDOR — una consulta a la vez.
// Los proveedores (sobre todo Pally) bloquean cuando les llegan varias
// solicitudes seguidas: antes cada cliente, el panel y el vigilante
// consultaban por su cuenta y al mismo tiempo, y las respuestas se
// cortaban (timeout) o salían vacías. Ahora cada proveedor tiene su fila:
//  · una consulta a la vez, con una pausa mínima entre una y otra;
//  · si el proveedor bloquea o no responde, la fila espera sola (20 s,
//    40 s… hasta 2 min) antes de seguir;
//  · lo del cliente y del panel pasa antes que lo del vigilante;
//  · dos pedidos iguales (mismo correo y misma opción) comparten la
//    misma consulta en vez de hacer dos.
// ─────────────────────────────────────────────────────────────

export type LanePriority = 0 | 1; // 0 = cliente / panel · 1 = vigilante / búsqueda

type LaneConfig = { label: string; gapMs: number };

const LANES: Record<string, LaneConfig> = {
  pally:            { label: "Pally",             gapMs: 4000 },
  joseb:            { label: "José Streaming",    gapMs: 1500 },
  streaming_market: { label: "Streaming Market",  gapMs: 1500 },
  vegamig:          { label: "Vegamig",           gapMs: 1500 },
  latinocol_outlook:{ label: "Gralexander Outlook", gapMs: 1500 },
  latinocol_yurama: { label: "Gralexander Yurama",  gapMs: 1500 },
  otro:             { label: "Otro",              gapMs: 1500 },
};

export function laneIdOf(sourceId: string): string {
  if (/^(netflix_sin_opciones|netflix_con_opciones|disney_sin_opciones)$/.test(sourceId)) return "pally";
  if (sourceId.startsWith("joseb_")) return "joseb";
  if (sourceId === "streaming_market_web") return "streaming_market";
  if (sourceId === "vegamig_web") return "vegamig";
  if (sourceId === "latinocol_outlook" || sourceId === "latinocol_yurama") return sourceId;
  return "otro";
}

const COOLDOWN_FIRST_MS = 20_000;
const COOLDOWN_MAX_MS = 120_000;

/** El proveedor BLOQUEÓ (no solo tardó): la fila espera antes de seguir.
 *  Tardar no es bloquear — Pally a propósito se queda esperando el correo
 *  10–40 s; si eso pausara la fila, el código llegaría todavía más tarde. */
function isThrottle(err: any): boolean {
  const status = err?.response?.status;
  if (status === 429 || status === 403 || status === 503) return true;
  if (/timeout|ECONNABORTED|ETIMEDOUT/i.test(String(err?.code ?? "") + " " + String(err?.message ?? ""))) return false;
  return /l[ií]mite|demasiad|too many|bloquead|intenta (m[aá]s )?tarde/i.test(String(err?.message ?? ""));
}

type Job = { key: string; priority: LanePriority; at: number; run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };

export type LaneStatus = {
  id: string; label: string; queued: number; busy: boolean;
  cooldownUntil: string | null; lastError: string | null; lastOkAt: string | null; done: number;
};

class Lane {
  private queue: Job[] = [];
  private shared = new Map<string, Promise<unknown>>();
  private busy = false;
  private lastEndAt = 0;
  private cooldownUntil = 0;
  private cooldownMs = 0;
  private lastError: string | null = null;
  private lastOkAt: number | null = null;
  private done = 0;

  constructor(readonly id: string, private readonly cfg: LaneConfig) {}

  run<T>(key: string, priority: LanePriority, fn: () => Promise<T>): Promise<T> {
    const same = this.shared.get(key);
    if (same) return same as Promise<T>;
    const p = new Promise<unknown>((resolve, reject) => {
      this.queue.push({ key, priority, at: Date.now(), run: fn, resolve, reject });
      this.queue.sort((a, b) => a.priority - b.priority || a.at - b.at);
    });
    this.shared.set(key, p);
    const clear = () => { if (this.shared.get(key) === p) this.shared.delete(key); };
    p.then(clear, clear);
    void this.pump();
    return p as Promise<T>;
  }

  /** ¿Hay una consulta igual en la fila o en curso? */
  has(key: string): boolean { return this.shared.has(key); }

  private async pump(): Promise<void> {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    // Se espera la pausa ANTES de elegir: si en ese rato entra un pedido
    // de un cliente, pasa antes que uno del vigilante.
    const wait = Math.max(this.lastEndAt + this.cfg.gapMs, this.cooldownUntil) - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const job = this.queue.shift();
    if (!job) { this.busy = false; return; }
    try {
      const result = await job.run();
      this.cooldownMs = 0;
      this.lastOkAt = Date.now();
      job.resolve(result);
    } catch (err: any) {
      if (isThrottle(err)) {
        this.cooldownMs = Math.min(COOLDOWN_MAX_MS, this.cooldownMs ? this.cooldownMs * 2 : COOLDOWN_FIRST_MS);
        this.cooldownUntil = Date.now() + this.cooldownMs;
      }
      this.lastError = String(err?.message ?? err).slice(0, 200);
      job.reject(err);
    } finally {
      this.done++;
      this.lastEndAt = Date.now();
      this.busy = false;
      void this.pump();
    }
  }

  status(): LaneStatus {
    return {
      id: this.id, label: this.cfg.label, queued: this.queue.length, busy: this.busy,
      cooldownUntil: this.cooldownUntil > Date.now() ? new Date(this.cooldownUntil).toISOString() : null,
      lastError: this.lastError, lastOkAt: this.lastOkAt ? new Date(this.lastOkAt).toISOString() : null, done: this.done,
    };
  }
}

const lanes = new Map<string, Lane>();

export function laneFor(sourceId: string): Lane {
  const id = laneIdOf(sourceId);
  let lane = lanes.get(id);
  if (!lane) { lane = new Lane(id, LANES[id] ?? LANES.otro!); lanes.set(id, lane); }
  return lane;
}

export function lanesStatus(): LaneStatus[] {
  return [...lanes.values()].map(l => l.status());
}
