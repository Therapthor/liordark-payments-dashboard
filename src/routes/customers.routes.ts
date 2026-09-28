import { Router } from "express";
import {
  listAllCustomers,
  suspendCustomer,
  deleteCustomer,
  isCustomerSuspended,
  findCustomerById,
  setCustomerPassword,
} from "../db/customer.repository";
import { countProfilesByPhone } from "../db/access.repository";
import { generatePassword, hashPassword } from "../services/customer-auth.service";

// ─────────────────────────────────────────────────────────────
// CLIENTES DE LA TIENDA WEB (panel admin) — muestra la contraseña de
// cada cuenta (guardada en texto plano, igual que las cuentas de
// streaming en Accesos) para poder reenviarla por WhatsApp, cuántas
// cuentas se le entregaron, y permite suspender (3 días) o banear
// (borra la cuenta de este panel; no toca las cuentas de streaming
// ya entregadas, esas viven en Accesos).
// ─────────────────────────────────────────────────────────────

const router = Router();

router.get("/", (_req, res) => {
  const purchaseCounts = countProfilesByPhone();
  const customers = listAllCustomers().map(c => ({
    id:             c.id,
    phone:          c.phone,
    isGuest:        c.isGuest,
    password:       c.passwordPlain,
    purchaseCount:  purchaseCounts[c.phone] ?? 0,
    suspended:      isCustomerSuspended(c),
    suspendedUntil: c.suspendedUntil,
    createdAt:      c.createdAt,
  }));
  res.json({ customers });
});

router.post("/:id/suspend", (req, res) => {
  const id = Number(req.params.id);
  if (!findCustomerById(id)) {
    return res.status(404).json({ message: "Cliente no encontrado." });
  }
  const customer = suspendCustomer(id, 3);
  res.json({ ok: true, suspendedUntil: customer?.suspendedUntil ?? null });
});

// Para cuentas registradas ANTES de guardar password_plain: su
// contraseña original quedó solo como hash (bcrypt, no reversible), así
// que no hay forma de "verla". Esto le genera una nueva que sí queda
// visible — cambia el login real del cliente, hay que avisarle la nueva.
router.post("/:id/reset-password", async (req, res) => {
  const id = Number(req.params.id);
  if (!findCustomerById(id)) {
    return res.status(404).json({ message: "Cliente no encontrado." });
  }
  const newPassword = generatePassword();
  const passwordHash = await hashPassword(newPassword);
  setCustomerPassword(id, passwordHash, newPassword);
  res.json({ ok: true, password: newPassword });
});

router.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!findCustomerById(id)) {
    return res.status(404).json({ message: "Cliente no encontrado." });
  }
  deleteCustomer(id);
  res.status(204).end();
});

export default router;
