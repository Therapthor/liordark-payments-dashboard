import { EventEmitter } from "events";

// Pub/sub en memoria hacia el FRONTEND del panel (distinto del que nos
// conecta al bot) — cada pestaña abierta se suscribe acá.
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export type DashboardLiveEvent =
  | { type: "payment"; payment: unknown }
  | { type: "stats"; stats: unknown }
  | { type: "connection"; status: "connected" | "reconnecting" }
  | { type: "status_update"; id: number; status: string };

export function onDashboardEvent(listener: (evt: DashboardLiveEvent) => void): () => void {
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}

export function emitDashboardEvent(evt: DashboardLiveEvent): void {
  emitter.emit("event", evt);
}
