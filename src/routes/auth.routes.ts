import { Router } from "express";
import {
  checkPassword, createSessionToken, SESSION_COOKIE, verifySessionToken, setPanelPassword,
} from "../services/auth.service";
import {
  listAdminSessions, revokeAdminSession, revokeAdminSessionById, revokeAllAdminSessions, currentSessionShortId,
} from "../db/security.repository";
import { requireAuth } from "../middleware/auth.middleware";
import { clientIp } from "../services/security.service";
import { env } from "../config/env";

const router = Router();

// Intentos fallidos por IP: 5 seguidos → 15 min sin poder intentar.
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const fails = new Map<string, { count: number; lockedUntil: number }>();

function setCookie(res: import("express").Response, token: string, expires: Date): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   env.NODE_ENV === "production",
    sameSite: "lax",
    expires,
  });
}

router.post("/login", (req, res) => {
  const ip = clientIp(req);
  const f = fails.get(ip);
  if (f && f.lockedUntil > Date.now()) {
    const min = Math.ceil((f.lockedUntil - Date.now()) / 60000);
    res.status(429).json({ message: `Demasiados intentos. Prueba de nuevo en ${min} min.` });
    return;
  }

  const password = req.body?.password;
  if (typeof password !== "string" || password.length > 200 || !checkPassword(password)) {
    const count = (f?.count ?? 0) + 1;
    fails.set(ip, { count, lockedUntil: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    console.warn(`⚠️ Intento fallido de acceso al panel desde ${ip || "?"} (${count})`);
    res.status(401).json({ message: "Contraseña incorrecta" });
    return;
  }

  fails.delete(ip);
  const { token, expires } = createSessionToken(ip, String(req.headers["user-agent"] ?? ""));
  setCookie(res, token, expires);
  res.json({ ok: true });
});

router.post("/logout", (req, res) => {
  revokeAdminSession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

router.get("/me", (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  res.json({ authenticated: verifySessionToken(token) });
});

// ── Seguridad: dispositivos con sesión abierta ──

router.get("/sessions", requireAuth, (req, res) => {
  const current = currentSessionShortId(req.cookies?.[SESSION_COOKIE]);
  res.json({ sessions: listAdminSessions().map(s => ({ ...s, current: s.id === current })) });
});

router.post("/sessions/:id/revoke", requireAuth, (req, res) => {
  revokeAdminSessionById(String(req.params.id));
  res.json({ ok: true });
});

router.post("/sessions/revoke-others", requireAuth, (req, res) => {
  const closed = revokeAllAdminSessions(req.cookies?.[SESSION_COOKIE]);
  res.json({ ok: true, closed });
});

// Cambiar la contraseña: pide la actual; cierra las demás sesiones.
router.post("/password", requireAuth, (req, res) => {
  const current = String(req.body?.current ?? "");
  const next    = String(req.body?.next ?? "");
  if (!checkPassword(current)) return res.status(400).json({ message: "La contraseña actual no es correcta." });
  if (next.length < 10 || next.length > 100) return res.status(400).json({ message: "La nueva contraseña debe tener al menos 10 caracteres." });
  if (!/[a-zA-Z]/.test(next) || !/\d/.test(next)) return res.status(400).json({ message: "Usa letras y números en la nueva contraseña." });
  setPanelPassword(next);
  const closed = revokeAllAdminSessions(req.cookies?.[SESSION_COOKIE]);
  res.json({ ok: true, closed });
});

export default router;
