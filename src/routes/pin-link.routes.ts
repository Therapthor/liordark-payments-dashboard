import { Router } from "express";
import { findCustomerById, setCustomerPassword, isCustomerSuspended } from "../db/customer.repository";
import {
  createPinLink, findPinLink, markPinLinkOpened, usePinLink, pinLinkState, PIN_LINK_MINUTES,
} from "../db/pin-links.repository";
import { sqliteDate } from "../db/code-links.repository";
import { hashPassword } from "../services/customer-auth.service";

// ─────────────────────────────────────────────────────────────
// CAMBIO DE PIN POR LINK
//  · Admin (requireAuth): POST /api/customers/:id/pin-link
//  · Cliente (sin sesión): /api/pin-link/<token>
// El link vale 10 min y deja de servir apenas se cambia el PIN.
// ─────────────────────────────────────────────────────────────

function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, "").slice(-9);
  return d.length < 6 ? "***" : d.slice(0, 3) + " *** " + d.slice(-3);
}

function linkInfo(token: string) {
  const link = findPinLink(token);
  if (!link) return null;
  const customer = findCustomerById(link.customerId);
  return {
    link,
    customer,
    body: {
      state: customer ? pinLinkState(link) : "expired",
      phone: customer ? maskPhone(customer.phone) : "",
      expiresAt: sqliteDate(link.expiresAt)?.toISOString() ?? null,
      openedAt: sqliteDate(link.openedAt)?.toISOString() ?? null,
      usedAt: sqliteDate(link.usedAt)?.toISOString() ?? null,
      serverNow: new Date().toISOString(),
    },
  };
}

// ═════════ ADMIN (se monta dentro de /api/customers) ═════════

export const pinLinkAdminRoutes = Router();

pinLinkAdminRoutes.post("/:id/pin-link", (req, res) => {
  const id = Number(req.params.id);
  if (!findCustomerById(id)) return res.status(404).json({ message: "Cliente no encontrado." });
  const link = createPinLink(id);
  res.json({
    token: link.token,
    url: "https://liordark.com/cambiar-pin/" + link.token,
    minutes: PIN_LINK_MINUTES,
    expiresAt: sqliteDate(link.expiresAt)?.toISOString() ?? null,
  });
});

pinLinkAdminRoutes.get("/pin-link/:token", (req, res) => {
  const info = linkInfo(String(req.params.token));
  if (!info) return res.status(404).json({ message: "Link no encontrado." });
  res.json(info.body);
});

// ═════════ CLIENTE ═════════

export const pinLinkRoutes = Router();

pinLinkRoutes.get("/:token", (req, res) => {
  const info = linkInfo(String(req.params.token));
  if (!info) return res.status(404).json({ state: "expired", message: "Este link no existe." });
  if (info.body.state === "active") markPinLinkOpened(info.link.token);
  res.json(info.body);
});

pinLinkRoutes.post("/:token", async (req, res) => {
  const info = linkInfo(String(req.params.token));
  if (!info || !info.customer) return res.status(404).json({ state: "expired", message: "Este link no existe." });
  if (info.body.state !== "active") return res.status(410).json(info.body);

  const pin = String(req.body?.pin ?? "");
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ message: "El PIN debe ser de 4 números." });
  if (isCustomerSuspended(info.customer)) {
    return res.status(403).json({ message: "Tu cuenta está suspendida. Escríbenos por WhatsApp." });
  }
  if (!usePinLink(info.link.token)) return res.status(410).json({ ...info.body, state: "used" });

  setCustomerPassword(info.customer.id, await hashPassword(pin), pin);
  res.json({ ok: true, phone: info.body.phone });
});
