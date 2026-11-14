import { listPlatforms } from "../db/access.repository";
import { emitDashboardEvent } from "../utils/live-events.util";

// STOCK EN VIVO: cada pocos segundos se mira cuántos perfiles vendibles
// tiene cada plataforma. Si algo cambió (venta del bot, cuenta nueva,
// asignación, cuenta borrada…), se avisa a las pestañas del panel por el
// stream en vivo y la lista «Sin stock» se actualiza sola, sin recargar.
const WATCH_MS = 4_000;
let last = "";
let timer: NodeJS.Timeout | null = null;

function signature(): string {
  return listPlatforms()
    .map(p => `${p.platform}:${p.sellableCount}`)
    .sort()
    .join("|");
}

export function checkStockNow(): void {
  try {
    const sig = signature();
    if (sig !== last) {
      const first = last === "";
      last = sig;
      if (!first) emitDashboardEvent({ type: "stock_changed" });
    }
  } catch (err: any) {
    console.error("⚠️ stock en vivo:", err?.message);
  }
}

export function startStockWatch(): void {
  if (timer) return;
  checkStockNow();
  timer = setInterval(checkStockNow, WATCH_MS);
  timer.unref?.();
}
