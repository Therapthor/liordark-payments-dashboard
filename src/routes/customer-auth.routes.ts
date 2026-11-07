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
  rememberCustomerPlain,
} from "../db/customer.repository";
import {
  checkPassword,
  createCustomerSessionToken,
  CUSTOMER_SESSION_COOKIE,
  hashPassword,
  verifyCustomerSessionToken,
} from "../services/customer-auth.service";
import { isPhoneBlocked, isIpBlocked, countRegistrationsFromIp, logRegistration } from "../db/security.repository";
import { clientIp, isPublicIp } from "../services/security.service";

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

// Número bloqueado (baneo del admin o automático por enlaces/código en el
// chat): no entra ni puede volver a registrarse con ese número.
const BLOCKED_MESSAGE = "Este número fue bloqueado por seguridad.";
// Cuentas nuevas por IP en 24 h (evita crear números en serie).
const MAX_REGISTRATIONS_PER_IP = 3;

function registrationDenied(req: import("express").Request): string | null {
  const ip = clientIp(req);
  if (!isPublicIp(ip)) return null; // sin IP real del cliente no se aplica regla por IP
  if (isIpBlocked(ip)) return "No se pueden crear cuentas nuevas desde esta conexión. Escríbenos por WhatsApp.";
  if (countRegistrationsFromIp(ip) >= MAX_REGISTRATIONS_PER_IP) return "Se crearon demasiadas cuentas desde esta conexión hoy. Intenta mañana o escríbenos por WhatsApp.";
  return null;
}

router.post("/login", async (req, res) => {
  const phone    = String(req.body?.phone ?? "");
  const password = String(req.body?.password ?? "");
  if (isPhoneBlocked(phone)) return res.status(403).json({ message: BLOCKED_MESSAGE });

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
  rememberCustomerPlain(customer.id, password);
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
  if (isPhoneBlocked(phone)) return res.status(403).json({ message: BLOCKED_MESSAGE });
  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).json({ message: "El PIN debe ser de 4 dígitos." });
  }
  if (findCustomerByPhone(phone)) {
    return res.status(409).json({ message: "Ya existe una cuenta con ese celular. Iniciá sesión." });
  }
  const denied = registrationDenied(req);
  if (denied) return res.status(429).json({ message: denied });

  const passwordHash = await hashPassword(pin);
  const customer      = createCustomer(phone, passwordHash, pin, true);
  logRegistration(clientIp(req));

  emitDashboardEvent({ type: "customer_registered", phone: customer.phone, isGuest: true });
  setSessionCookie(res, customer.id);
  res.json({ ok: true, phone: customer.phone });
});

// POST /quick — registro rápido al tocar "Comprar" (la tienda ya muestra
// precios sin sesión). Un solo paso con celular + PIN:
//   - si el celular ya tiene cuenta → inicia sesión con su PIN/contraseña
//     (mismo bloqueo por intentos fallidos que /login);
//   - si es nuevo → crea la cuenta con ese PIN de 4 dígitos (igual que /guest).
router.post("/quick", async (req, res) => {
  const phone = String(req.body?.phone ?? "");
  const pin   = String(req.body?.password ?? "");

  if (normalizeCustomerPhone(phone).length < 9) {
    return res.status(400).json({ message: "Número de celular inválido." });
  }
  if (isPhoneBlocked(phone)) return res.status(403).json({ message: BLOCKED_MESSAGE });

  const existing = findCustomerByPhone(phone);
  if (existing) {
    const lock = customerLockoutStatus(phone);
    if (lock.locked) {
      return res.status(429).json({
        message: `Demasiados intentos fallidos. Prueba de nuevo en ${Math.ceil(lock.retryAfterSeconds / 60)} min.`,
        retryAfterSeconds: lock.retryAfterSeconds,
      });
    }
    if (!(await checkPassword(pin, existing.passwordHash))) {
      recordCustomerLoginFailure(phone);
      return res.status(401).json({
        message: "Ese celular ya tiene cuenta y el PIN no coincide. Usa el PIN que creaste en tu primera compra.",
        existing: true,
      });
    }
    if (isCustomerSuspended(existing)) {
      return res.status(403).json({ message: "Tu cuenta está suspendida temporalmente. Contáctanos si es un error." });
    }
    recordCustomerLoginSuccess(phone);
    rememberCustomerPlain(existing.id, pin);
    setSessionCookie(res, existing.id);
    return res.json({ ok: true, phone: existing.phone, created: false });
  }

  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).json({ message: "Crea un PIN de 4 dígitos (solo números)." });
  }
  const denied = registrationDenied(req);
  if (denied) return res.status(429).json({ message: denied });
  const passwordHash = await hashPassword(pin);
  const customer      = createCustomer(phone, passwordHash, pin, true);
  logRegistration(clientIp(req));
  emitDashboardEvent({ type: "customer_registered", phone: customer.phone, isGuest: true });
  setSessionCookie(res, customer.id);
  res.json({ ok: true, phone: customer.phone, created: true });
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
  res.json({ authenticated: true, phone: customer.phone, hasEmail: !!customer.email });
});

export default router;
