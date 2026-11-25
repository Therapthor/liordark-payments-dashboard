import { Router } from "express";
import { env } from "../config/env";
import { emitDashboardEvent } from "../utils/live-events.util";
import {
  createCustomer,
  findCustomerByPhone,
  findCustomerById,
  findCustomerByEmail,
  setCustomerEmail,
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
import { isPhoneBlocked, isIpBlocked, countRegistrationsFromIp, logRegistration, ipLoginFailures, setIpLoginFailures, phoneHasAccounts, hasLoginPass, rememberLoginFailureIp } from "../db/security.repository";
import { checkLockout, nextCustomerLockoutState, lockoutDurationText } from "../services/login-lockout.service";
import { clientIp, isPublicIp } from "../services/security.service";
import { oneAtATime, phoneKey } from "../utils/one-at-a-time.util";
import { isSafeEmail } from "../utils/email.util";
import { createPinLink, PIN_EMAIL_LINK_MINUTES } from "../db/pin-links.repository";
import { sendEmail } from "../services/email.service";
import { sendWelcomeEmail, pinResetEmail } from "../services/customer-update-email.service";

const router = Router();
const pinLock = oneAtATime(phoneKey);

function setSessionCookie(res: import("express").Response, customerId: number): void {
  const { token, expires } = createCustomerSessionToken(customerId);
  res.cookie(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   env.NODE_ENV === "production",
    sameSite: "lax",
    expires,
  });
}

// Número bloqueado (baneo del admin) — no entra ni se vuelve a registrar.
const BLOCKED_MESSAGE = "Este número fue bloqueado por seguridad. Escríbenos por WhatsApp al +51 963 081 436.";
// Cuentas nuevas por IP en 24 h (evita crear números en serie).
const MAX_REGISTRATIONS_PER_IP = 3;
const WA_HELP = "Si necesitas ayuda escríbenos por WhatsApp al +51 963 081 436.";

function lockedMessage(retryAfterSeconds: number): string {
  return `Por seguridad tu acceso quedó bloqueado por ${lockoutDurationText(retryAfterSeconds)}. ${WA_HELP}`;
}

/** IP bloqueada por un ataque o por demasiados intentos fallidos. */
function ipLockedResponse(req: import("express").Request): { status: number; message: string } | null {
  const ip = clientIp(req);
  if (!isPublicIp(ip)) return null;
  if (isIpBlocked(ip)) return { status: 403, message: `Por seguridad, el acceso desde esta conexión está bloqueado. ${WA_HELP}` };
  const lock = checkLockout(ipLoginFailures(ip).lockedUntil);
  if (lock.locked) return { status: 429, message: lockedMessage(lock.retryAfterSeconds) };
  return null;
}

function recordIpFailure(req: import("express").Request, phone: string): void {
  const ip = clientIp(req);
  if (!isPublicIp(ip)) return;
  const { failedLoginCount, lockedUntil } = nextCustomerLockoutState(ipLoginFailures(ip).count);
  setIpLoginFailures(ip, failedLoginCount, lockedUntil);
  // Para que «Quitar bloqueo» en el panel limpie también esta conexión.
  rememberLoginFailureIp("cliente", phone, ip);
}

/** Tras un intento fallido: ¿quedó bloqueado el número o la IP? (con pase del admin, solo el número) */
function lockAfterFailure(req: import("express").Request, phone: string, pass: boolean): string | null {
  const byPhone = customerLockoutStatus(phone);
  if (byPhone.locked) return lockedMessage(byPhone.retryAfterSeconds);
  const ip = clientIp(req);
  if (!pass && isPublicIp(ip)) {
    const byIp = checkLockout(ipLoginFailures(ip).lockedUntil);
    if (byIp.locked) return lockedMessage(byIp.retryAfterSeconds);
  }
  return null;
}

// Desde ahora toda cuenta nueva se crea con correo: ahí le llegan sus
// datos, los cambios de su cuenta y los recordatorios, y el admin lo puede
// encontrar por su correo. Un correo, una cuenta.
/** La tienda actual siempre manda «email» (aunque vaya vacío); una página
 *  vieja o la del curso no lo mandan porque no tienen dónde escribirlo. */
function formHasEmailField(body: unknown): boolean {
  return !!body && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "email");
}
const STALE_FORM_MESSAGE = "Para crear tu cuenta necesitamos tu correo: recarga la página (↻) y aparecerá dónde escribirlo.";

function newAccountEmailError(raw: unknown): string | null {
  const email = String(raw ?? "").trim();
  if (!email) return "Pon tu correo: ahí te llegan tus cuentas, los cambios y los recordatorios.";
  if (!isSafeEmail(email)) return "Ese correo no es válido. Revísalo.";
  if (findCustomerByEmail(email)) return "Ese correo ya tiene una cuenta. Ingresa con tu celular o con ese correo.";
  return null;
}

function registrationDenied(req: import("express").Request, phone: string): string | null {
  // Un número que ya tiene cuentas con nosotros (compró por WhatsApp) no se
  // puede "reclamar" registrándolo en la web: cualquiera podría poner el
  // número de otro cliente y ver sus cuentas. Se activa por WhatsApp.
  if (phoneHasAccounts(phone)) {
    return "Este número ya tiene cuentas con nosotros. Para activar tu acceso escríbenos por WhatsApp al +51 963 081 436 y te enviamos tu link.";
  }
  const ip = clientIp(req);
  if (!isPublicIp(ip)) return null; // sin IP real del cliente no se aplica regla por IP
  if (isIpBlocked(ip)) return `No se pueden crear cuentas nuevas desde esta conexión. ${WA_HELP}`;
  if (countRegistrationsFromIp(ip) >= MAX_REGISTRATIONS_PER_IP) return `Se crearon demasiadas cuentas desde esta conexión hoy. ${WA_HELP}`;
  return null;
}

router.post("/login", pinLock(async (req, res) => {
  // Se entra con el celular o con el correo.
  const input    = String(req.body?.phone ?? "").trim();
  const password = String(req.body?.password ?? "");
  let phone = input;
  if (input.includes("@")) {
    const byEmail = findCustomerByEmail(input);
    if (!byEmail) {
      const ipLockEmail = ipLockedResponse(req);
      if (ipLockEmail) return res.status(ipLockEmail.status).json({ message: ipLockEmail.message });
      recordIpFailure(req, input);
      return res.status(401).json({ message: "Correo o contraseña incorrectos." });
    }
    phone = byEmail.phone;
  }
  if (isPhoneBlocked(phone)) return res.status(403).json({ message: BLOCKED_MESSAGE });
  // Pase del admin («Quitar bloqueo»): entra aunque su conexión esté bloqueada.
  const pass = hasLoginPass("cliente", phone);
  const ipLock = pass ? null : ipLockedResponse(req);
  if (ipLock) return res.status(ipLock.status).json({ message: ipLock.message });

  const lock = customerLockoutStatus(phone);
  if (lock.locked) {
    return res.status(429).json({ message: lockedMessage(lock.retryAfterSeconds), retryAfterSeconds: lock.retryAfterSeconds });
  }

  const customer = findCustomerByPhone(phone);
  if (!customer || !(await checkPassword(password, customer.passwordHash))) {
    recordCustomerLoginFailure(phone);
    recordIpFailure(req, phone);
    const lockedNow = lockAfterFailure(req, phone, pass);
    if (lockedNow) return res.status(429).json({ message: lockedNow });
    return res.status(401).json({ message: (input.includes("@") ? "Correo" : "Celular") + " o contraseña incorrectos. Te queda 1 intento antes de un bloqueo temporal." });
  }
  if (isCustomerSuspended(customer)) {
    return res.status(403).json({ message: "Tu cuenta está suspendida temporalmente. Contáctanos si es un error." });
  }

  recordCustomerLoginSuccess(phone);
  rememberCustomerPlain(customer.id, password);
  setSessionCookie(res, customer.id);
  res.json({ ok: true, phone: customer.phone });
}));

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
  const emailError = newAccountEmailError(req.body?.email);
  if (emailError) return res.status(400).json({ message: emailError, needEmail: true });
  const denied = registrationDenied(req, phone);
  if (denied) return res.status(403).json({ message: denied });

  const passwordHash = await hashPassword(pin);
  const customer      = createCustomer(phone, passwordHash, pin, true);
  const withEmail = setCustomerEmail(customer.id, String(req.body.email));
  if (withEmail) sendWelcomeEmail(withEmail);
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
router.post("/quick", pinLock(async (req, res) => {
  const phone = String(req.body?.phone ?? "");
  const pin   = String(req.body?.password ?? "");

  if (normalizeCustomerPhone(phone).length < 9) {
    return res.status(400).json({ message: "Número de celular inválido." });
  }
  if (isPhoneBlocked(phone)) return res.status(403).json({ message: BLOCKED_MESSAGE });
  // Pase del admin («Quitar bloqueo»): entra aunque su conexión esté bloqueada.
  const pass = hasLoginPass("cliente", phone);
  const ipLock = pass ? null : ipLockedResponse(req);
  if (ipLock) return res.status(ipLock.status).json({ message: ipLock.message });

  const existing = findCustomerByPhone(phone);
  if (existing) {
    const lock = customerLockoutStatus(phone);
    if (lock.locked) {
      return res.status(429).json({ message: lockedMessage(lock.retryAfterSeconds), retryAfterSeconds: lock.retryAfterSeconds });
    }
    if (!(await checkPassword(pin, existing.passwordHash))) {
      recordCustomerLoginFailure(phone);
      recordIpFailure(req, phone);
      const lockedNow = lockAfterFailure(req, phone, pass);
      if (lockedNow) return res.status(429).json({ message: lockedNow });
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
    // Cliente sin correo: sí o sí lo agrega aquí mismo, y queda unido a su
    // número (con él entra y recupera su PIN). El que ya tiene correo no
    // necesita escribirlo.
    // Formularios SIN campo de correo (la página del curso, o una tienda que
    // quedó abierta desde antes de este cambio): entra igual — la tienda le
    // pide el correo antes de pagar (withEmail) y, si su página es vieja, el
    // pago le dice que la recargue. Nunca se queda trabado sin dónde escribirlo.
    if (!existing.email && formHasEmailField(req.body)) {
      const typed = String(req.body?.email ?? "").trim();
      const emailError = newAccountEmailError(typed);
      if (emailError) {
        return res.status(400).json({
          message: typed ? emailError : "Agrega tu correo para continuar: queda unido a tu número y ahí te llegan tus cuentas y tu PIN si lo olvidas.",
          needEmail: true,
        });
      }
      setCustomerEmail(existing.id, typed);
    }
    setSessionCookie(res, existing.id);
    return res.json({ ok: true, phone: existing.phone, created: false });
  }

  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).json({ message: "Crea un PIN de 4 dígitos (solo números)." });
  }
  if (!formHasEmailField(req.body)) {
    return res.status(400).json({ message: STALE_FORM_MESSAGE, needEmail: true });
  }
  const emailError = newAccountEmailError(req.body?.email);
  if (emailError) return res.status(400).json({ message: emailError, needEmail: true });
  const denied = registrationDenied(req, phone);
  if (denied) return res.status(403).json({ message: denied });
  const passwordHash = await hashPassword(pin);
  const customer      = createCustomer(phone, passwordHash, pin, true);
  const withEmail = setCustomerEmail(customer.id, String(req.body.email));
  if (withEmail) sendWelcomeEmail(withEmail);
  logRegistration(clientIp(req));
  emitDashboardEvent({ type: "customer_registered", phone: customer.phone, isGuest: true });
  setSessionCookie(res, customer.id);
  res.json({ ok: true, phone: customer.phone, created: true });
}));

// POST /phone-status — apenas el cliente escribe su celular en «Entrar»,
// la tienda sabe qué pedirle: solo el PIN (ya tiene correo), correo + PIN
// (cliente sin correo o número nuevo) o activar por WhatsApp (compró por
// WhatsApp y todavía no tiene acceso web). No devuelve el correo ni ningún
// dato; es lo mismo que ya responde /quick al enviar. Con límite por conexión.
const PHONE_STATUS_MAX = 40;               // consultas por conexión…
const PHONE_STATUS_WINDOW_MS = 10 * 60_000; // …cada 10 minutos
const phoneStatusHits = new Map<string, number[]>();

router.post("/phone-status", (req, res) => {
  const ip = clientIp(req);
  const now = Date.now();
  const hits = (phoneStatusHits.get(ip) ?? []).filter(t => now - t < PHONE_STATUS_WINDOW_MS);
  if (hits.length >= PHONE_STATUS_MAX) return res.status(429).json({ message: "Espera unos minutos." });
  hits.push(now);
  phoneStatusHits.set(ip, hits);
  if (phoneStatusHits.size > 5000) {
    for (const [k, v] of phoneStatusHits) if (!v.some(t => now - t < PHONE_STATUS_WINDOW_MS)) phoneStatusHits.delete(k);
  }

  const phone = String(req.body?.phone ?? "");
  if (normalizeCustomerPhone(phone).length < 9) return res.status(400).json({ message: "Número de celular inválido." });
  const customer = findCustomerByPhone(phone);
  if (customer) return res.json({ state: customer.email ? "has_email" : "need_email" });
  res.json({ state: phoneHasAccounts(phone) ? "activate" : "new" });
});

// POST /forgot — «¿Olvidaste tu PIN?»: con su correo (o celular) se le
// manda a SU correo registrado un enlace de un solo uso para crear un PIN
// nuevo (liordark.com/cambiar-pin/<token>, 30 min). Siempre responde lo
// mismo, exista o no la cuenta, para no revelar quién es cliente.
const resetRequests = new Map<number, number[]>(); // por cliente: máx. 3 por hora
const RESET_GENERIC = "Si tu cuenta tiene un correo registrado, te enviamos un enlace para crear tu PIN nuevo. Revisa también la carpeta de spam.";

router.post("/forgot", async (req, res) => {
  const input = String(req.body?.login ?? "").trim().slice(0, 200);
  if (!input) return res.status(400).json({ message: "Escribe tu correo o tu celular." });
  const ipLock = ipLockedResponse(req);
  if (ipLock) return res.status(ipLock.status).json({ message: ipLock.message });

  const customer = input.includes("@")
    ? findCustomerByEmail(input)
    : (normalizeCustomerPhone(input).length >= 9 ? findCustomerByPhone(input) : null);
  if (!customer || !customer.email || isCustomerSuspended(customer) || isPhoneBlocked(customer.phone)) {
    return res.json({ ok: true, message: RESET_GENERIC });
  }
  const now = Date.now();
  const hits = (resetRequests.get(customer.id) || []).filter(t => now - t < 3600_000);
  if (hits.length >= 3) return res.json({ ok: true, message: RESET_GENERIC });
  hits.push(now);
  resetRequests.set(customer.id, hits);

  const link = createPinLink(customer.id, PIN_EMAIL_LINK_MINUTES);
  const { subject, html } = pinResetEmail("https://liordark.com/cambiar-pin/" + link.token, PIN_EMAIL_LINK_MINUTES);
  sendEmail(customer.email, subject, html).catch(() => { /* sendEmail ya registra el error */ });
  res.json({ ok: true, message: RESET_GENERIC });
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
