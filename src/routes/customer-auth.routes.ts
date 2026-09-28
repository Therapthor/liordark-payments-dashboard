import { randomInt } from "crypto";
import { Router } from "express";
import { env } from "../config/env";
import {
  createCustomer,
  findCustomerByPhone,
  findCustomerById,
  normalizeCustomerPhone,
} from "../db/customer.repository";
import {
  checkPassword,
  createCustomerSessionToken,
  CUSTOMER_SESSION_COOKIE,
  hashPassword,
  verifyCustomerSessionToken,
} from "../services/customer-auth.service";

const router = Router();

// Sin 0/O/1/I/l para que no se confundan al transcribirla desde la pantalla.
const GUEST_PASSWORD_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateGuestPassword(): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += GUEST_PASSWORD_CHARS[randomInt(GUEST_PASSWORD_CHARS.length)];
  return out;
}

function setSessionCookie(res: import("express").Response, customerId: number): void {
  const { token, expires } = createCustomerSessionToken(customerId);
  res.cookie(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   env.NODE_ENV === "production",
    sameSite: "lax",
    expires,
  });
}

router.post("/register", async (req, res) => {
  const phone    = String(req.body?.phone ?? "");
  const password = String(req.body?.password ?? "");

  if (normalizeCustomerPhone(phone).length < 9) {
    return res.status(400).json({ message: "Número de celular inválido." });
  }
  if (password.length < 6) {
    return res.status(400).json({ message: "La contraseña debe tener al menos 6 caracteres." });
  }
  if (findCustomerByPhone(phone)) {
    return res.status(409).json({ message: "Ya existe una cuenta con ese celular." });
  }

  const passwordHash = await hashPassword(password);
  const customer      = createCustomer(phone, passwordHash);

  setSessionCookie(res, customer.id);
  res.json({ ok: true, phone: customer.phone });
});

router.post("/login", async (req, res) => {
  const phone    = String(req.body?.phone ?? "");
  const password = String(req.body?.password ?? "");

  const customer = findCustomerByPhone(phone);
  if (!customer || !(await checkPassword(password, customer.passwordHash))) {
    return res.status(401).json({ message: "Celular o contraseña incorrectos." });
  }

  setSessionCookie(res, customer.id);
  res.json({ ok: true, phone: customer.phone });
});

// POST /guest — "Comprar sin cuenta": el cliente solo escribe su celular,
// el sistema genera una contraseña y crea la cuenta al toque (login
// automático), para que pueda comprar sin llenar el formulario de
// registro. La contraseña generada queda guardada (además del hash, que
// es lo que se usa para loguear) para que el panel admin la pueda ver y
// reenviar por WhatsApp si el cliente la pierde.
router.post("/guest", async (req, res) => {
  const phone = String(req.body?.phone ?? "");

  if (normalizeCustomerPhone(phone).length < 9) {
    return res.status(400).json({ message: "Número de celular inválido." });
  }
  if (findCustomerByPhone(phone)) {
    return res.status(409).json({ message: "Ya existe una cuenta con ese celular. Iniciá sesión." });
  }

  const generatedPassword = generateGuestPassword();
  const passwordHash      = await hashPassword(generatedPassword);
  const customer           = createCustomer(phone, passwordHash, { isGuest: true, generatedPassword });

  setSessionCookie(res, customer.id);
  res.json({ ok: true, phone: customer.phone, password: generatedPassword });
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
