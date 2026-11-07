import { Router } from "express";
import { listSupportTickets, countPendingSupportTickets, getSupportTicketById } from "../db/support-tickets.repository";
import {
  setTicketInReview, resolveTicketActive, replaceOptions, replaceTicketAccount,
  reviewMessage, activeMessage,
} from "../services/support-reports.service";

// ─────────────────────────────────────────────────────────────
// PANEL > SOPORTES — reportes «sin suscripción» de liordark.com.
// requireAuth se aplica al montar en index.ts. Cada acción devuelve el
// mensaje listo para mandarlo por WhatsApp (y avisa en la campanita).
// ─────────────────────────────────────────────────────────────

const router = Router();

router.get("/tickets", (_req, res) => {
  const tickets = listSupportTickets().map(t => ({
    ...t,
    messages: { review: reviewMessage(t.platform), active: activeMessage(t.platform) },
  }));
  res.json({ tickets, pendingCount: countPendingSupportTickets() });
});

router.get("/count", (_req, res) => {
  res.json({ pendingCount: countPendingSupportTickets() });
});

router.post("/tickets/:id/review", (req, res) => {
  const result = setTicketInReview(Number(req.params.id));
  if (!result) return res.status(404).json({ message: "Reporte no encontrado." });
  res.json(result);
});

router.post("/tickets/:id/active", (req, res) => {
  const result = resolveTicketActive(Number(req.params.id));
  if (!result) return res.status(404).json({ message: "Reporte no encontrado." });
  res.json(result);
});

router.get("/tickets/:id/replace-options", (req, res) => {
  const ticket = getSupportTicketById(Number(req.params.id));
  if (!ticket) return res.status(404).json({ message: "Reporte no encontrado." });
  res.json(replaceOptions(ticket));
});

router.post("/tickets/:id/replace", (req, res) => {
  const mode = req.body?.mode === "shared" ? "shared" : "fresh";
  const targetAccountId = Number(req.body?.targetAccountId);
  if (!targetAccountId) return res.status(400).json({ message: "Elige la cuenta de reemplazo." });
  const result = replaceTicketAccount(Number(req.params.id), mode, targetAccountId, String(req.body?.profileName ?? ""));
  if (!result.ok) return res.status(400).json({ message: result.message });
  res.json(result);
});

export default router;
