import { Router } from "express";
import {
  listAllCustomers,
  suspendCustomer,
  deleteCustomer,
  isCustomerSuspended,
  findCustomerById,
  setCustomerPassword,
  countAllCustomers,
  dailyRegistrationsThisMonth,
} from "../db/customer.repository";
import { listAccessClientStats } from "../db/access.repository";
import { generatePassword, hashPassword } from "../services/customer-auth.service";
import { limaTodayISO } from "../services/access.service";

// ─────────────────────────────────────────────────────────────
// CLIENTES DE LA TIENDA WEB (panel admin) — muestra la contraseña de
// cada cuenta (guardada en texto plano, igual que las cuentas de
// streaming en Accesos) para poder reenviarla por WhatsApp, cuántas
// cuentas se le entregaron, y permite suspender (3 días) o banear
// (borra la cuenta de este panel; no toca las cuentas de streaming
// ya entregadas, esas viven en Accesos).
// ─────────────────────────────────────────────────────────────

const router = Router();

// Últimos 9 dígitos — mismo criterio que el resto del código para
// comparar celulares sin importar si quedaron guardados con o sin "51".
function last9(phone: string): string {
  return phone.replace(/\D/g, "").slice(-9);
}

// "Clientes > Registro" muestra DOS orígenes en una sola lista: quienes
// se registraron de verdad en liordark.com (tabla customers) Y quienes
// solo existen porque alguna vez les asignaron una cuenta en Accesos
// (compra por el bot, o asignación manual) sin pasar nunca por un
// registro web. Estos últimos no tienen contraseña ni se pueden
// suspender/banear desde acá (id: null) — son solo un registro, no una
// cuenta de login real.
router.get("/", (_req, res) => {
  const accessStats = listAccessClientStats();
  const registeredDigits = new Set(listAllCustomers().map(c => last9(c.phone)));

  const customers = listAllCustomers().map(c => {
    const stat = accessStats.find(s => last9(s.phone) === last9(c.phone));
    return {
      id:             c.id,
      phone:          c.phone,
      isGuest:        c.isGuest,
      password:       c.passwordPlain,
      purchaseCount:  stat?.purchaseCount ?? 0,
      suspended:      isCustomerSuspended(c),
      suspendedUntil: c.suspendedUntil,
      createdAt:      c.createdAt,
    };
  });

  const accessOnly = accessStats
    .filter(s => !registeredDigits.has(last9(s.phone)))
    .map(s => ({
      id:             null,
      phone:          s.phone,
      isGuest:        false,
      password:       null,
      purchaseCount:  s.purchaseCount,
      suspended:      false,
      suspendedUntil: null,
      createdAt:      s.firstSeenAt || "",
    }));

  res.json({ customers: [...customers, ...accessOnly] });
});

// GET /stats — total de clientes + registros por día del mes en curso,
// para el resumen y la curva de tráfico en el panel "Clientes web".
router.get("/stats", (_req, res) => {
  const today = limaTodayISO(); // "YYYY-MM-DD"
  const parts = today.split("-").map(Number);
  const year = parts[0] as number, month = parts[1] as number, dayOfMonth = parts[2] as number;

  const byDay = new Map(dailyRegistrationsThisMonth().map(r => [r.day, r.count]));
  const series: { date: string; count: number }[] = [];
  for (let d = 1; d <= dayOfMonth; d++) {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    series.push({ date, count: byDay.get(date) ?? 0 });
  }

  res.json({ totalCustomers: countAllCustomers(), registrationsThisMonth: series });
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
