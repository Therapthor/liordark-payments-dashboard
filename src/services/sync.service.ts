import axios from "axios";
import { env } from "../config/env";
import { upsertPayment } from "../db/payments.repository";
import { emitDashboardEvent } from "../utils/live-events.util";
import { getSummary } from "./stats.service";

// ─────────────────────────────────────────────────────────────
// SINCRONIZACIÓN CON EL BOT
//
// Dos mecanismos, ambos necesarios:
//   1. Backfill — GET /api/yape/payments, al arrancar y cada 5 min
//      como red de seguridad (por si la conexión SSE se corta un
//      momento y se pierde algún evento).
//   2. Stream en vivo — SSE a /api/dashboard/stream, para que la
//      notificación llegue apenas ocurre el pago, no cada 5 min.
//
// El bot borra pagos de más de 7 días — por eso este panel guarda
// todo permanentemente en su propia base de datos (payments.repository).
// ─────────────────────────────────────────────────────────────

const RECONNECT_DELAY_MS  = 5_000;
const BACKFILL_INTERVAL_MS = 5 * 60 * 1000;

type BotPaymentRow = {
  id:           number;
  orderName:    string;
  senderName:   string;
  amount:       string;
  securityCode: string;
  hasCode:      boolean;
  status:       string;
  createdAt:    string;
};

async function backfill(): Promise<void> {
  try {
    const res = await axios.get(env.BOT_BASE_URL + "/api/yape/payments", {
      params: { limit: 500 },
      timeout: 15_000,
    });
    const rows = (res.data?.data ?? []) as BotPaymentRow[];

    for (const row of rows) {
      upsertPayment({
        id:           row.id,
        senderName:   row.senderName,
        amount:       row.amount,
        securityCode: row.securityCode,
        hasCode:      row.hasCode,
        status:       mapBotStatus(row.status),
        orderName:    row.orderName,
        // El endpoint de historial del bot devuelve la fecha ya convertida a
        // hora Lima como texto "YYYY-MM-DD HH:MM:SS" (ver yape.controller.ts
        // tolimaTime) — hay que revertirla a UTC real para guardarla en el
        // mismo formato que usan los eventos en vivo (ISO 8601 UTC), y así
        // las consultas de "día/mes en Lima" den el mismo resultado sin
        // importar si el dato llegó por backfill o por el stream.
        createdAt:    limaStringToUtcIso(row.createdAt),
      });
    }

    console.log("🔄 Backfill: " + rows.length + " pagos sincronizados desde el bot");
  } catch (err: any) {
    console.error("⚠️ Backfill falló:", err?.response?.status || err?.message);
  }
}

// El endpoint de historial usa nombres de status distintos (pending/matched/
// unmatched/expired/no_code) — normalizamos a los mismos que usa el stream.
function mapBotStatus(status: string): string {
  if (status === "matched") return "matched";
  if (status === "no_code") return "no_code";
  return "pending";
}

/** Revierte "YYYY-MM-DD HH:MM:SS" en hora Lima (UTC-5) a un ISO 8601 en UTC real. */
function limaStringToUtcIso(limaStr: string): string {
  const normalized = limaStr.replace(" ", "T") + "Z"; // se interpreta el wall-clock como si fuera UTC
  const asIfUtc = new Date(normalized);
  const realUtc = new Date(asIfUtc.getTime() + 5 * 60 * 60 * 1000); // Lima = UTC-5 → sumar 5h
  return realUtc.toISOString();
}

let sseAbort: AbortController | null = null;

async function connectStream(): Promise<void> {
  sseAbort = new AbortController();

  try {
    const response = await axios.get(env.BOT_BASE_URL + "/api/dashboard/stream", {
      headers: { "x-dashboard-key": env.DASHBOARD_API_KEY },
      responseType: "stream",
      signal: sseAbort.signal,
      timeout: 0,
    });

    console.log("✅ Conectado al stream en vivo del bot");
    emitDashboardEvent({ type: "connection", status: "connected" });

    let buffer = "";

    response.data.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const line = part.split("\n").find(l => l.startsWith("data:"));
        if (!line) continue;

        const json = line.slice(5).trim();
        try {
          const evt = JSON.parse(json);
          handleBotEvent(evt);
        } catch {
          // línea de ping u otro formato — se ignora
        }
      }
    });

    response.data.on("end", () => {
      console.warn("⚠️ Stream del bot cerrado — reintentando en " + RECONNECT_DELAY_MS / 1000 + "s");
      scheduleReconnect();
    });

    response.data.on("error", (err: any) => {
      console.error("❌ Error en stream del bot:", err?.message);
      scheduleReconnect();
    });

  } catch (err: any) {
    console.error("❌ No se pudo conectar al stream del bot:", err?.response?.status || err?.message);
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  emitDashboardEvent({ type: "connection", status: "reconnecting" });
  setTimeout(connectStream, RECONNECT_DELAY_MS);
}

function handleBotEvent(evt: any): void {
  if (evt?.type !== "new_payment") return;

  upsertPayment({
    id:           evt.id,
    senderName:   evt.senderName,
    amount:       evt.amount,
    securityCode: evt.securityCode,
    hasCode:      evt.hasCode,
    status:       evt.status,
    orderName:    evt.orderName,
    createdAt:    evt.createdAt,
  });

  emitDashboardEvent({ type: "payment", payment: evt });
  emitDashboardEvent({ type: "stats", stats: getSummary() });
}

export function startSync(): void {
  backfill().then(connectStream);
  setInterval(backfill, BACKFILL_INTERVAL_MS);
}

export function stopSync(): void {
  sseAbort?.abort();
}
