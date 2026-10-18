import { Router } from "express";
import {
  listSupportTickets,
  getSupportTicketById,
  countPendingSupportTickets,
  countAttendedSupportTickets,
  markSupportTicketSeen,
  markSupportTicketAttended,
  markSupportTicketReplaced,
} from "../db/support-tickets.repository";
import { createCustomerNotification } from "../db/customer-notifications.repository";
import { createWholesalerNotification } from "../db/wholesaler-notifications.repository";
import { replaceClientAccount, replaceClientAccountManual } from "../db/access.repository";

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
  const resolutionMessage = String(req.body?.resolutionMessage || "");
  const ticket = markSupportTicketAttended(Number(req.params.id), resolutionMessage);
  if (!ticket) return res.status(404).json({ message: "Reporte no encontrado o ya estaba atendido." });
  // Al mayorista si lo reportó él (a nombre de un cliente suyo), al cliente si es de liordark.com.
  // replaced: si antes de atender se usó "Reemplazar" sobre este reporte — cambia el encabezado del mensaje.
  const replaced = !!ticket.replacedAt;
  if (ticket.wholesalerId) {
    createWholesalerNotification(ticket.wholesalerId, "support_resolved", ticket.platform, ticket.accountEmail, resolutionMessage, replaced);
  } else {
    createCustomerNotification(ticket.clientPhone, "support_resolved", ticket.platform, ticket.accountEmail, resolutionMessage, replaced);
  }
  res.json({ ticket });
});

// ─────────────────────────────────────────────────────────────
// REEMPLAZAR CUENTA — exclusivo de Soporte (ver access.repository.ts).
// El reporte NO se marca atendido solo; el admin usa "Marcar atendido"
// aparte una vez que ya avisó/resolvió con el cliente.
// ─────────────────────────────────────────────────────────────

router.post("/tickets/:id/replace", (req, res) => {
  const ticket = getSupportTicketById(Number(req.params.id));
  if (!ticket) return res.status(404).json({ message: "Reporte no encontrado." });
  const targetAccountId = Number(req.body?.targetAccountId);
  if (!targetAccountId) return res.status(400).json({ message: "Falta elegir la cuenta destino." });
  try {
    const result = replaceClientAccount({
      clientPhone: ticket.clientPhone, platform: ticket.platform, email: ticket.accountEmail,
      targetAccountId, wholesalerId: ticket.wholesalerId,
    });
    markSupportTicketReplaced(ticket.id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ message: err?.message || "No se pudo reemplazar la cuenta." });
  }
});

router.post("/tickets/:id/replace-manual", (req, res) => {
  const ticket = getSupportTicketById(Number(req.params.id));
  if (!ticket) return res.status(404).json({ message: "Reporte no encontrado." });
  const newEmail    = String(req.body?.newEmail || "").trim();
  const newPassword = String(req.body?.newPassword || "").trim();
  if (!newEmail) return res.status(400).json({ message: "Falta el correo de la cuenta nueva." });
  try {
    const result = replaceClientAccountManual({
      clientPhone: ticket.clientPhone, platform: ticket.platform, email: ticket.accountEmail,
      wholesalerId: ticket.wholesalerId,
      newEmail, newPassword,
      newProfileName: String(req.body?.newProfileName || "").trim(),
      newProvider:    String(req.body?.newProvider || "").trim(),
    });
    markSupportTicketReplaced(ticket.id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ message: err?.message || "No se pudo crear la cuenta de reemplazo." });
  }
});

export default router;
