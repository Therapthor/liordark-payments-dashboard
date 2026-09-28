import { Router } from "express";
import { listAllCustomers } from "../db/customer.repository";

// ─────────────────────────────────────────────────────────────
// CLIENTES DE LA TIENDA WEB (panel admin) — para las cuentas creadas
// con "Comprar sin cuenta" se expone la contraseña generada (guardada
// en texto plano solo para esas), así el admin la puede reenviar por
// WhatsApp si el cliente la pierde. Las cuentas que el cliente registró
// él mismo con su propia contraseña no la exponen (solo el hash).
// ─────────────────────────────────────────────────────────────

const router = Router();

router.get("/", (_req, res) => {
  const customers = listAllCustomers().map(c => ({
    id:        c.id,
    phone:     c.phone,
    isGuest:   c.isGuest,
    password:  c.isGuest ? c.generatedPassword : "",
    createdAt: c.createdAt,
  }));
  res.json({ customers });
});

export default router;
