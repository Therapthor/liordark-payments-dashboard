import { Router } from "express";
import {
  listSupportTickets,
  countPendingSupportTickets,
  countAttendedSupportTickets,
  markSupportTicketSeen,
  markSupportTicketAttended,
} from "../db/support-tickets.repository";

// ─────────────────────────────────────────────────────────────
// PANEL ADMIN > SOPORTES — requireAuth se aplica al montar en index.ts.
// ─────────────────────────────────────────────────────────────

const router = Router();

router.get("/tickets", (_req, res) => {
  res.json({
    tickets:       listSupportTickets(),
    pendingCount:  countPendingSupportTickets(),
    attendedCount: countAttendedSupportTickets(),
  });
});

// El admin abrió el modal "Atender" — avisa al cliente que ya lo vieron.
router.post("/tickets/:id/seen", (req, res) => {
  const ticket = markSupportTicketSeen(Number(req.params.id));
  res.json({ ticket });
});

router.post("/tickets/:id/attend", (req, res) => {
  const ticket = markSupportTicketAttended(Number(req.params.id));
  if (!ticket) return res.status(404).json({ message: "Reporte no encontrado o ya estaba atendido." });
  res.json({ ticket });
});

export default router;
