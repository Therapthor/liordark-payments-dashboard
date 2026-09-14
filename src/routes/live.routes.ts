import { Router } from "express";
import { getRecentPayments } from "../db/payments.repository";
import { getSummary } from "../services/stats.service";
import { onDashboardEvent } from "../utils/live-events.util";

const router = Router();

// Carga inicial al abrir el panel — últimos pagos + stats de una sola vez.
router.get("/initial", (_req, res) => {
  res.json({
    payments: getRecentPayments(50),
    stats:    getSummary(),
  });
});

// SSE hacia el navegador — reenvía lo que llega del bot en vivo.
router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  const unsubscribe = onDashboardEvent((evt) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  });

  const ping = setInterval(() => res.write(":ping\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});

export default router;
