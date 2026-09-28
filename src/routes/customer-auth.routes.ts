import { Router } from "express";
import { env } from "../config/env";
import {
  createCustomer,
  findCustomerByEmail,
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

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

router.post("/register", async (req, res) => {
  const email    = String(req.body?.email ?? "").trim();
  const password = String(req.body?.password ?? "");
  const phone    = String(req.body?.phone ?? "");

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: "Correo inválido." });
  }
  if (password.length < 6) {
    return res.status(400).json({ message: "La contraseña debe tener al menos 6 caracteres." });
  }
  if (normalizeCustomerPhone(phone).length < 9) {
    return res.status(400).json({ message: "Número de celular inválido." });
  }

  if (findCustomerByEmail(email)) {
    return res.status(409).json({ message: "Ya existe una cuenta con ese correo." });
  }

  const passwordHash = await hashPassword(password);
  const customer      = createCustomer(email, passwordHash, phone);

  const { token, expires } = createCustomerSessionToken(customer.id);
  res.cookie(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   env.NODE_ENV === "production",
    sameSite: "lax",
    expires,
  });
  res.json({ ok: true, email: customer.email });
});

router.post("/login", async (req, res) => {
  const email    = String(req.body?.email ?? "").trim();
  const password = String(req.body?.password ?? "");

  const customer = findCustomerByEmail(email);
  if (!customer || !(await checkPassword(password, customer.passwordHash))) {
    return res.status(401).json({ message: "Correo o contraseña incorrectos." });
  }

  const { token, expires } = createCustomerSessionToken(customer.id);
  res.cookie(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   env.NODE_ENV === "production",
    sameSite: "lax",
    expires,
  });
  res.json({ ok: true, email: customer.email });
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
  res.json({ authenticated: true, email: customer.email, phone: customer.phone });
});

export default router;
