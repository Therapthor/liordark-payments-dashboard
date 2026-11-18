import { Router } from "express";
import { env } from "../config/env";
import {
  createWholesaler,
  findWholesalerByPhone,
  findWholesalerById,
  wholesalerLockoutStatus,
  recordWholesalerLoginFailure,
  recordWholesalerLoginSuccess,
} from "../db/wholesaler.repository";
import {
  checkWholesalerPassword,
  hashWholesalerPassword,
  createWholesalerSessionToken,
  WHOLESALER_SESSION_COOKIE,
  verifyWholesalerSessionToken,
} from "../services/wholesaler-auth.service";
import { oneAtATime, phoneKey } from "../utils/one-at-a-time.util";
import { getMembershipStatus } from "../db/wholesaler-membership.repository";
import { emitDashboardEvent } from "../utils/live-events.util";

// La cuenta la crea el admin (Mayoristas) o el mismo mayorista con /register.
// Recién creada no tiene membresía: solo puede pagarla (ver wholesaler.routes.ts).
const router = Router();
const passwordLock = oneAtATime(phoneKey);

function setSessionCookie(res: import("express").Response, wholesalerId: number): void {
  const { token, expires } = createWholesalerSessionToken(wholesalerId);
  res.cookie(WHOLESALER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   env.NODE_ENV === "production",
    sameSite: "lax",
    expires,
  });
}

router.post("/login", passwordLock(async (req, res) => {
  const phone    = String(req.body?.phone ?? "");
  const password = String(req.body?.password ?? "");

  const lock = wholesalerLockoutStatus(phone);
  if (lock.locked) {
    return res.status(429).json({
      message: `Demasiados intentos fallidos. Prueba de nuevo en ${Math.ceil(lock.retryAfterSeconds / 60)} min o escríbenos al WhatsApp 963 081 436 para desbloquearte.`,
      retryAfterSeconds: lock.retryAfterSeconds,
    });
  }

  const wholesaler = findWholesalerByPhone(phone);
  if (!wholesaler || !(await checkWholesalerPassword(password, wholesaler.passwordHash))) {
    recordWholesalerLoginFailure(phone);
    return res.status(401).json({ message: "Celular o contraseña incorrectos." });
  }
  if (wholesaler.status === "disabled") {
    return res.status(403).json({ message: "Tu cuenta está deshabilitada. Tu saldo sigue guardado: escríbenos al WhatsApp 963 081 436 para reactivarla." });
  }

  recordWholesalerLoginSuccess(wholesaler.id);
  setSessionCookie(res, wholesaler.id);
  res.json({ ok: true, phone: wholesaler.phone, displayName: wholesaler.displayName, membership: getMembershipStatus(wholesaler.id) });
}));

// POST /register — { name, phone, password } — cuenta nueva de mayorista.
// La contraseña la elige él (no se guarda en texto: si la olvida, el admin
// le da una nueva desde Mayoristas).
router.post("/register", passwordLock(async (req, res) => {
  const name     = String(req.body?.name ?? "").trim().replace(/\s+/g, " ");
  const digits   = String(req.body?.phone ?? "").replace(/\D/g, "").replace(/^51(?=9\d{8}$)/, "");
  const password = String(req.body?.password ?? "");

  if (name.length < 2 || name.length > 40) {
    return res.status(400).json({ message: "Escribe tu nombre (2 a 40 letras)." });
  }
  if (!/^9\d{8}$/.test(digits)) {
    return res.status(400).json({ message: "Escribe tu celular de 9 dígitos (empieza con 9)." });
  }
  if (password.length < 6 || password.length > 72) {
    return res.status(400).json({ message: "La contraseña debe tener al menos 6 caracteres." });
  }
  if (findWholesalerByPhone(digits)) {
    return res.status(409).json({ message: "Ese celular ya tiene cuenta de mayorista. Inicia sesión." });
  }

  const wholesaler = createWholesaler(digits, await hashWholesalerPassword(password), "", name);
  setSessionCookie(res, wholesaler.id);
  emitDashboardEvent({ type: "wholesaler_registered", phone: wholesaler.phone, name: wholesaler.displayName });
  res.status(201).json({ ok: true, phone: wholesaler.phone, displayName: wholesaler.displayName, membership: getMembershipStatus(wholesaler.id) });
}));

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
  res.json({ authenticated: true, phone: wholesaler.phone, displayName: wholesaler.displayName, membership: getMembershipStatus(wholesaler.id) });
});

export default router;
