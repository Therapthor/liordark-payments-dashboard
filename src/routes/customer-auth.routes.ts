import { Router } from "express";
import { env } from "../config/env";
import { emitDashboardEvent } from "../utils/live-events.util";
import {
  createCustomer,
  findCustomerByPhone,
  findCustomerById,
  isCustomerSuspended,
  normalizeCustomerPhone,
  customerLockoutStatus,
  recordCustomerLoginFailure,
  recordCustomerLoginSuccess,
} from "../db/customer.repository";
import {
  checkPassword,
  createCustomerSessionToken,
  CUSTOMER_SESSION_COOKIE,
  hashPassword,
  verifyCustomerSessionToken,
} from "../services/customer-auth.service";

const router = Router();

function setSessionCookie(res: import("express").Response, customerId: number): void {
  const { token, expires } = createCustomerSessionToken(customerId);
  res.cookie(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   env.NODE_ENV === "production",
    sameSite: "lax",
    expires,
  });
}

router.post("/login", async (req, res) => {
  const phone    = String(req.body?.phone ?? "");
  const password = String(req.body?.password ?? "");

  const lock = customerLockoutStatus(phone);
  if (lock.locked) {
    return res.status(429).json({
      message: `Demasiados intentos fallidos. Probá de nuevo en ${Math.ceil(lock.retryAfterSeconds / 60)} min.`,
      retryAfterSeconds: lock.retryAfterSeconds,
    });
  }

  const customer = findCustomerByPhone(phone);
  if (!customer || !(await checkPassword(password, customer.passwordHash))) {
    recordCustomerLoginFailure(phone);
    return res.status(401).json({ message: "Celular o contraseña incorrectos." });
  }
  if (isCustomerSuspended(customer)) {
    return res.status(403).json({ message: "Tu cuenta está suspendida temporalmente. Contáctanos si es un error." });
  }

  recordCustomerLoginSuccess(phone);
  setSessionCookie(res, customer.id);
  res.json({ ok: true, phone: customer.phone });
});

// POST /guest — "Comprar sin cuenta": única forma de crear cuenta ahora
// (ya no hay registro aparte) — el cliente pone su celular y crea su
// propio PIN de 4 dígitos para poder volver a entrar. Se guarda igual
// que antes (hash + texto plano) para que el panel admin lo pueda
// reenviar por WhatsApp si el cliente lo pierde.
router.post("/guest", async (req, res) => {
  const phone = String(req.body?.phone ?? "");
  const pin   = String(req.body?.password ?? "");

  if (normalizeCustomerPhone(phone).length < 9) {
    return res.status(400).json({ message: "Número de celular inválido." });
  }
  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).json({ message: "El PIN debe ser de 4 dígitos." });
  }
  if (findCustomerByPhone(phone)) {
    return res.status(409).json({ message: "Ya existe una cuenta con ese celular. Iniciá sesión." });
  }

  const passwordHash = await hashPassword(pin);
  const customer      = createCustomer(phone, passwordHash, pin, true);

  emitDashboardEvent({ type: "customer_registered", phone: customer.phone, isGuest: true });
  setSessionCookie(res, customer.id);
  res.json({ ok: true, phone: customer.phone });
});

router.post("/logout", (_req, res) => {
  res.clearCookie(CUSTOMER_SESSION_COOKIE);
  res.json({ ok: true });
});

router.get("/me", (req, res) => {
  const customerId = verifyCustomerSessionToken(req.cookies?.[CUSTOMER_SESSION_COOKIE]);
  const customer   = customerId ? findCustomerById(customerId) : null;

  if (!customer) {
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, phone: customer.phone });
});

export default router;
