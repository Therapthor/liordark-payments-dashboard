import { Router } from "express";
import { getRecentPayments, searchByCode, hidePayment } from "../db/payments.repository";
import { getSummary } from "../services/stats.service";
import { onDashboardEvent, emitDashboardEvent } from "../utils/live-events.util";
import { getConnectionStatus } from "../services/sync.service";

const router = Router();

// Carga inicial al abrir el panel — últimos pagos + stats de una sola vez.
router.get("/initial", (_req, res) => {
  res.json({
    payments: getRecentPayments(50),
    stats:    getSummary(),
  });
});

// Estado de las integraciones externas — para el panel "Resumen".
// El bot se chequea solo (stream SSE). (Cloudinary se retiró: las imágenes
// viven en el servidor.)
router.get("/connectors", (_req, res) => {
  res.json({ bot: getConnectionStatus() });
});

// Buscar pagos por el código de seguridad de 3 dígitos que manda Yape.
router.get("/search", (req, res) => {
  const raw = String(req.query.code ?? "").replace(/\D/g, "");
  if (!raw) {
    res.status(400).json({ message: "Falta el código a buscar" });
    return;
  }
  // Mismo padding que usa el bot (yape.service.ts normalizeCode): 3 dígitos.
  const code = raw.padStart(3, "0").slice(0, 3);
  res.json({ code, payments: searchByCode(code) });
});

// Quitar un pago de la contabilidad y del historial (Yape de un familiar,
// error…). No toca al bot ni al cliente: solo deja de contarse en el panel.
router.delete("/payments/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ message: "Pago inválido" });
    return;
  }
  const removed = hidePayment(id);
  if (!removed) {
    res.status(404).json({ message: "Ese pago ya no está en la lista." });
    return;
  }
  console.log(`🗑️ Pago quitado de la contabilidad: #${id} · S/ ${removed.amount}`);
  const stats = getSummary();
  emitDashboardEvent({ type: "payment_removed", id });
  emitDashboardEvent({ type: "stats", stats });
  res.json({ ok: true, stats });
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

  // Estado actual de inmediato — si el backend ya está conectado al bot
  // desde antes de que esta pestaña se abriera, no hay que esperar a un
  // futuro cambio de estado para saberlo.
  res.write(`data: ${JSON.stringify({ type: "connection", status: getConnectionStatus() })}\n\n`);

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
