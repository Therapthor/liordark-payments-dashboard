import { Router } from "express";
import { checkPassword, createSessionToken, SESSION_COOKIE, verifySessionToken } from "../services/auth.service";
import { env } from "../config/env";

const router = Router();

router.post("/login", (req, res) => {
  const password = req.body?.password;

  if (typeof password !== "string" || !checkPassword(password)) {
    res.status(401).json({ message: "Contraseña incorrecta" });
    return;
  }

  const { token, expires } = createSessionToken();
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   env.NODE_ENV === "production",
    sameSite: "lax",
    expires,
  });
  res.json({ ok: true });
});

router.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

router.get("/me", (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  res.json({ authenticated: verifySessionToken(token) });
});

export default router;
