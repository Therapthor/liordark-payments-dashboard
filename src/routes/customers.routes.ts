import { Router } from "express";
import {
  listAllCustomers,
  suspendCustomer,
  deleteCustomer,
  isCustomerSuspended,
  findCustomerById,
  setCustomerPassword,
  setCustomerEmail,
  countAllCustomers,
  countCustomersWithEmail,
  dailyRegistrationsThisMonth,
  resetCustomerPin,
  findCustomerByPhone,
  createCustomer,
} from "../db/customer.repository";
import { listAccessClientStats } from "../db/access.repository";
import { generatePassword, hashPassword } from "../services/customer-auth.service";
import { limaTodayISO } from "../services/access.service";
import { checkLockout } from "../services/login-lockout.service";
import { isSafeEmail, cleanEmail } from "../utils/email.util";
import { blockPhone, unblockPhone, unblockIp, listBlockedPhones, isPhoneBlocked } from "../db/security.repository";
import crypto from "crypto";
import { revokeCustomerSessions, listSecurityEvents, listBlockedIps, setIpLoginFailures, customerIpLocks, listIpFailureLocks } from "../db/security.repository";
import { banForFraud } from "../services/security.service";
import { unlockCustomerLogin, unlockWholesalerLogin } from "../services/login-unlock.service";
import { findWholesalerById, listLockedWholesalers } from "../db/wholesaler.repository";

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

/** Hasta cuándo no puede entrar: lo que dure más entre su número y sus conexiones. */
function lockedUntilOf(phoneLock: string | null, ipLock: string | undefined): string | null {
  const a = phoneLock && checkLockout(phoneLock).locked ? phoneLock : null;
  if (!ipLock) return a;
  if (!a) return ipLock;
  return new Date(ipLock).getTime() > new Date(a).getTime() ? ipLock : a;
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
  const ipLocks = customerIpLocks();

  const customers = listAllCustomers().map(c => {
    const stat = accessStats.find(s => last9(s.phone) === last9(c.phone));
    return {
      id:             c.id,
      phone:          c.phone,
      isGuest:        c.isGuest,
      password:       c.passwordPlain,
      email:          c.email,
      purchaseCount:  stat?.purchaseCount ?? 0,
      suspended:      isCustomerSuspended(c),
      suspendedUntil: c.suspendedUntil,
      lockedUntil:    lockedUntilOf(c.lockedUntil, ipLocks.get(last9(c.phone))),
      blocked:        isPhoneBlocked(c.phone),
      pinRecovery:    c.pinRecovery,
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

  res.json({
    totalCustomers: countAllCustomers(),
    customersWithEmail: countCustomersWithEmail(),
    registrationsThisMonth: series,
  });
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
  const updated = setCustomerPassword(id, passwordHash, newPassword);
  if (updated) unlockCustomerLogin(updated.phone); // con la nueva entra sin esperar
  res.json({ ok: true, password: newPassword });
});

// Quita el bloqueo para que el cliente entre YA: el de su número, el de las
// conexiones desde donde falló y 24 h sin bloqueos por conexión.
router.post("/:id/unlock", (req, res) => {
  const id = Number(req.params.id);
  const customer = findCustomerById(id);
  if (!customer) {
    return res.status(404).json({ message: "Cliente no encontrado." });
  }
  // Si además su número estaba baneado, también se libera (y la conexión del baneo).
  const ban = listBlockedPhones().find(b => b.phone.slice(-9) === last9(customer.phone));
  if (ban) unblockPhone(customer.phone);
  unlockCustomerLogin(customer.phone, ban?.ip ? [ban.ip] : []);
  res.json({ ok: true });
});

// Permite al admin poner/corregir el correo de aviso de vencimiento de un
// cliente a mano — útil para recuperar casos puntuales (ej. el cliente lo
// dio por WhatsApp) sin depender de que él mismo vuelva a entrar al banner.
router.post("/:id/email", (req, res) => {
  const id = Number(req.params.id);
  if (!findCustomerById(id)) {
    return res.status(404).json({ message: "Cliente no encontrado." });
  }
  const email = String(req.body?.email ?? "").trim();
  if (!isSafeEmail(email)) {
    return res.status(400).json({ message: "Ingresa un correo válido." });
  }
  const updated = setCustomerEmail(id, email);
  res.json({ ok: true, email: updated?.email ?? email });
});

router.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  const customer = findCustomerById(id);
  if (!customer) {
    return res.status(404).json({ message: "Cliente no encontrado." });
  }
  // Baneado = el número tampoco puede volver a registrarse.
  blockPhone({ phone: customer.phone, reason: "Baneado desde el panel", source: "admin" });
  deleteCustomer(id);
  res.status(204).end();
});

// Resetear PIN y cerrar todas sus sesiones (cuenta tomada, cliente lo pide…).
router.post("/:id/reset-pin", async (req, res) => {
  const id = Number(req.params.id);
  if (!findCustomerById(id)) return res.status(404).json({ message: "Cliente no encontrado." });
  const pin = String(crypto.randomInt(10000)).padStart(4, "0");
  resetCustomerPin(id, await hashPassword(pin), pin);
  revokeCustomerSessions(id);
  const customer = findCustomerById(id);
  if (customer) unlockCustomerLogin(customer.phone); // con el PIN nuevo entra sin esperar
  res.json({ ok: true, pin });
});

// Crear acceso web para un número que ya compró (Registro): se crea con un
// PIN al azar y el admin le manda el link de cambio de PIN por WhatsApp —
// así solo el dueño real del número puede entrar.
router.post("/create-access", async (req, res) => {
  const phone = String(req.body?.phone ?? "").replace(/\D/g, "");
  if (phone.length < 9) return res.status(400).json({ message: "Celular inválido." });
  const existing = findCustomerByPhone(phone);
  if (existing) {
    unlockCustomerLogin(existing.phone);
    return res.json({ ok: true, id: existing.id, phone: existing.phone, existed: true });
  }
  const pin = String(crypto.randomInt(10000)).padStart(4, "0");
  const customer = createCustomer(phone, await hashPassword(pin), pin, true);
  unlockCustomerLogin(customer.phone);
  res.json({ ok: true, id: customer.id, phone: customer.phone, existed: false });
});

// 🚨 Fraude: borra la cuenta, bloquea el número y libera todos sus perfiles.
router.post("/fraud", (req, res) => {
  const phone = String(req.body?.phone ?? "").replace(/\D/g, "");
  if (phone.length < 9) return res.status(400).json({ message: "Celular inválido." });
  const reason = String(req.body?.reason ?? "").trim().slice(0, 200) || "Fraude (marcado por el admin)";
  try { res.json({ ok: true, ...banForFraud(phone, reason) }); }
  catch (err: any) { res.status(400).json({ message: err?.message || "No se pudo completar." }); }
});

// Intentos de ataque detectados e IPs bloqueadas.
router.get("/security/events", (_req, res) => {
  // Además de las de 7 días por ataque, las bloqueadas por intentos fallidos.
  const ips: { ip: string; reason: string; expiresAt: string }[] = listBlockedIps();
  const seen = new Set(ips.map(b => b.ip));
  for (const f of listIpFailureLocks()) {
    if (seen.has(f.ip)) continue;
    ips.push({ ip: f.ip, reason: `${f.count} intentos fallidos de PIN`, expiresAt: f.lockedUntil });
  }
  res.json({ events: listSecurityEvents(), ips });
});

router.post("/security/ips/unblock", (req, res) => {
  const ip = String(req.body?.ip ?? "").trim();
  if (!ip) return res.status(400).json({ message: "Falta la IP." });
  unblockIp(ip);
  setIpLoginFailures(ip, 0, null);
  res.json({ ok: true });
});

// Números bloqueados (baneo del admin o automático por enlaces/código en el chat).
router.get("/blocked/list", (_req, res) => {
  res.json({ blocked: listBlockedPhones() });
});

router.post("/blocked/:phone/unblock", async (req, res) => {
  const phone = String(req.params.phone).replace(/\D/g, "");
  if (phone.length < 9) return res.status(400).json({ message: "Celular inválido." });
  const entry = listBlockedPhones().find(b => b.phone.slice(-9) === phone.slice(-9));
  unblockPhone(phone);
  // Al banear se borra su acceso web: sin esto, aunque se desbloquee no
  // tiene con qué entrar (y no puede registrarse porque ya compró). Se le
  // crea de nuevo con un PIN al azar para que le mandes su link de PIN.
  const fullPhone = entry?.phone || phone;
  let createdPin: string | null = null;
  if (entry && !findCustomerByPhone(fullPhone)) {
    createdPin = String(crypto.randomInt(10000)).padStart(4, "0");
    createCustomer(fullPhone, await hashPassword(createdPin), createdPin, true);
  }
  unlockCustomerLogin(fullPhone, entry?.ip ? [entry.ip] : []);
  res.json({ ok: true, ...(createdPin ? { createdPin } : {}) });
});

// Mayoristas que no pueden entrar a mayorista.liordark.com por intentos fallidos.
router.get("/wholesalers/locked", (_req, res) => {
  res.json({ wholesalers: listLockedWholesalers() });
});

router.post("/wholesalers/:id/unlock", (req, res) => {
  const w = findWholesalerById(Number(req.params.id));
  if (!w) return res.status(404).json({ message: "Mayorista no encontrado." });
  unlockWholesalerLogin(w);
  res.json({ ok: true });
});

export default router;
