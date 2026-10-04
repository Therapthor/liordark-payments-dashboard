import { Router } from "express";
import { env } from "../config/env";
import {
  findWholesalerByPhone,
  findWholesalerById,
  wholesalerLockoutStatus,
  recordWholesalerLoginFailure,
  recordWholesalerLoginSuccess,
} from "../db/wholesaler.repository";
import {
  checkWholesalerPassword,
  createWholesalerSessionToken,
  WHOLESALER_SESSION_COOKIE,
  verifyWholesalerSessionToken,
} from "../services/wholesaler-auth.service";

// Sin /register acá — la cuenta la crea siempre el admin desde el panel
// (ver src/routes/wholesalers-admin.routes.ts), nunca self-registro.
const router = Router();

function setSessionCookie(res: import("express").Response, wholesalerId: number): void {
  const { token, expires } = createWholesalerSessionToken(wholesalerId);
  res.cookie(WHOLESALER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   env.NODE_ENV === "production",
    sameSite: "lax",
    expires,
  });
}

router.post("/login", async (req, res) => {
  const phone    = String(req.body?.phone ?? "");
  const password = String(req.body?.password ?? "");

  const lock = wholesalerLockoutStatus(phone);
  if (lock.locked) {
    return res.status(429).json({
      message: `Demasiados intentos fallidos. Probá de nuevo en ${Math.ceil(lock.retryAfterSeconds / 60)} min.`,
      retryAfterSeconds: lock.retryAfterSeconds,
    });
  }

  const wholesaler = findWholesalerByPhone(phone);
  if (!wholesaler || !(await checkWholesalerPassword(password, wholesaler.passwordHash))) {
    recordWholesalerLoginFailure(phone);
    return res.status(401).json({ message: "Celular o contraseña incorrectos." });
  }
  if (wholesaler.status === "disabled") {
    return res.status(403).json({ message: "Tu cuenta está deshabilitada. Contáctanos si crees que es un error." });
  }

  recordWholesalerLoginSuccess(wholesaler.id);
  setSessionCookie(res, wholesaler.id);
  res.json({ ok: true, phone: wholesaler.phone, displayName: wholesaler.displayName });
});

router.post("/logout", (_req, res) => {
  res.clearCookie(WHOLESALER_SESSION_COOKIE);
  res.json({ ok: true });
});

router.get("/me", (req, res) => {
  const wholesalerId = verifyWholesalerSessionToken(req.cookies?.[WHOLESALER_SESSION_COOKIE]);
  const wholesaler    = wholesalerId ? findWholesalerById(wholesalerId) : null;

  if (!wholesaler) {
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, phone: wholesaler.phone, displayName: wholesaler.displayName });
});

export default router;
