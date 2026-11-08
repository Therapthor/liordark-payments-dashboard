import { Router } from "express";
import {
  checkPassword, createSessionToken, SESSION_COOKIE, verifySessionToken, setPanelPassword,
  TRUSTED_COOKIE, isTrustedDevice, setTrustedDeviceCookie, resetTrustedDevices,
} from "../services/auth.service";
import {
  listAdminSessions, revokeAdminSession, revokeAdminSessionById, revokeAllAdminSessions, currentSessionShortId,
  logSecurityEvent, isPanelIpBlocked, blockPanelIp, unblockPanelIp, listPanelBlockedIps, countPanelBlockedIps,
  listPasskeys, deletePasskey,
} from "../db/security.repository";
import { requireAuth } from "../middleware/auth.middleware";
import { clientIp, ipHeadersSummary, isPublicIp } from "../services/security.service";
import { registrationOptions, registerPasskey, loginOptions, verifyPasskeyLogin } from "../services/passkey.service";
import { env } from "../config/env";
import axios from "axios";

const router = Router();

// Contraseña incorrecta:
//  · desde un dispositivo nuevo: a la 2.ª, esa IP queda bloqueada PARA
//    SIEMPRE en el login del panel (se desbloquea en Configuración >
//    Seguridad). Solo el panel: la tienda no se toca.
//  · desde un dispositivo de confianza (ya entró antes): 5 seguidas → 15 min.
// La llave de acceso (Face ID) entra siempre, aunque la IP esté bloqueada.
const MAX_FAILS_NEW = 2;
const MAX_FAILS_TRUSTED = 5;
const LOCK_MS = 15 * 60 * 1000;
const fails = new Map<string, { count: number; lockedUntil: number }>();
const BLOCKED_MSG = "Esta conexión quedó bloqueada por contraseñas incorrectas. Entra con tu llave de acceso o desde un dispositivo donde ya iniciaste sesión.";

// Intentos fallidos de TODAS las IPs juntas. El 8-nov alguien probó
// contraseñas con una IP distinta (inventada) en cada intento, así el
// bloqueo por IP no lo frenaba. Con 10 fallos en 15 min el login queda
// abierto solo para dispositivos donde ya se entró antes (cookie firmada);
// mientras sigan llegando intentos, sigue cerrado para los demás.
const SHIELD_FAILS = 10;
const SHIELD_WINDOW_MS = 15 * 60 * 1000;
let recentFails: number[] = [];
let shieldLoggedAt = 0;
let headerSamples = 0;

function countRecentFails(now: number): number {
  recentFails = recentFails.filter(t => now - t < SHIELD_WINDOW_MS).slice(-200);
  return recentFails.length;
}

function noteFailure(now: number, ip: string): void {
  recentFails.push(now);
  if (fails.size > 5000) {
    for (const [k, v] of fails) if (v.lockedUntil < now) fails.delete(k);
    if (fails.size > 5000) fails.clear();
  }
  const n = countRecentFails(now);
  if (n >= SHIELD_FAILS && now - shieldLoggedAt > SHIELD_WINDOW_MS) {
    shieldLoggedAt = now;
    console.warn(`🛡️ Panel: ${n} contraseñas fallidas en 15 min — el login queda solo para dispositivos de confianza`);
    logSecurityEvent({
      phone: "", ip, reason: "Panel: prueban contraseñas en masa",
      evidence: `${n} intentos fallidos en 15 min desde IPs distintas`,
      action: "Login del panel solo desde dispositivos donde ya entraste",
    });
  }
}

function setCookie(res: import("express").Response, token: string, expires: Date): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   env.NODE_ENV === "production",
    sameSite: "lax",
    expires,
  });
}

function openSession(req: import("express").Request, res: import("express").Response, ip: string): void {
  const { token, expires } = createSessionToken(ip, String(req.headers["user-agent"] ?? ""));
  setCookie(res, token, expires);
  if (!isTrustedDevice(req.cookies?.[TRUSTED_COOKIE])) setTrustedDeviceCookie(res);
}

router.post("/login", (req, res) => {
  const now = Date.now();
  const ip = clientIp(req);
  const trusted = isTrustedDevice(req.cookies?.[TRUSTED_COOKIE]);
  const realIp = isPublicIp(ip);

  if (!trusted && realIp && isPanelIpBlocked(ip)) {
    noteFailure(now, ip);
    res.status(403).json({ message: BLOCKED_MSG, blocked: true, ip });
    return;
  }

  if (!trusted && countRecentFails(now) >= SHIELD_FAILS) {
    noteFailure(now, ip); // mientras sigan probando, sigue cerrado
    res.status(429).json({
      message: "Por seguridad, ahora solo se puede entrar con tu llave de acceso o desde un dispositivo donde ya iniciaste sesión. Prueba de nuevo en 15 min.",
    });
    return;
  }

  const key = (trusted ? "t:" : "n:") + ip;
  const f = fails.get(key);
  if (f && f.lockedUntil > now) {
    const min = Math.ceil((f.lockedUntil - now) / 60000);
    res.status(429).json({ message: `Demasiados intentos. Prueba de nuevo en ${min} min.` });
    return;
  }

  const password = req.body?.password;
  if (typeof password !== "string" || password.length > 200 || !checkPassword(password)) {
    const count = (f?.count ?? 0) + 1;
    console.warn(`⚠️ Intento fallido de acceso al panel desde ${ip || "?"} (${count})${trusted ? " — dispositivo de confianza" : ""}`);
    if (headerSamples < 5) { headerSamples++; console.warn(`🔎 Origen: ${ipHeadersSummary(req)}`); }

    if (trusted) {
      fails.set(key, { count, lockedUntil: count >= MAX_FAILS_TRUSTED ? now + LOCK_MS : 0 });
      res.status(401).json({ message: "Contraseña incorrecta" });
      return;
    }

    noteFailure(now, ip);
    if (count >= MAX_FAILS_NEW && realIp) {
      fails.delete(key);
      blockPanelIp(ip, `${count} contraseñas incorrectas`);
      console.warn(`⛔ Panel: IP ${ip} bloqueada para siempre (${count} contraseñas incorrectas)`);
      res.status(403).json({ message: BLOCKED_MSG, blocked: true, ip });
      return;
    }
    // Sin IP real (no debería pasar detrás de nginx): solo espera de 15 min.
    fails.set(key, { count, lockedUntil: count >= MAX_FAILS_NEW ? now + LOCK_MS : 0 });
    res.status(401).json({ message: "Contraseña incorrecta. Un intento más y esta conexión queda bloqueada." });
    return;
  }

  fails.delete(key);
  openSession(req, res, ip);
  res.json({ ok: true });
});

// ── Llave de acceso (Face ID / huella) ──

router.post("/passkey/login/options", async (_req, res) => {
  try { res.json(await loginOptions(res)); }
  catch (err: any) { res.status(400).json({ message: err?.message || "No disponible" }); }
});

router.post("/passkey/login/verify", async (req, res) => {
  const ip = clientIp(req);
  const name = await verifyPasskeyLogin(req, res, req.body?.response);
  if (!name) {
    console.warn(`⚠️ Llave de acceso no válida desde ${ip || "?"}`);
    res.status(401).json({ message: "No se pudo verificar la llave de acceso. Vuelve a intentarlo." });
    return;
  }
  for (const k of ["n:" + ip, "t:" + ip]) fails.delete(k);
  openSession(req, res, ip);
  console.log(`🔑 Panel: entrada con llave de acceso «${name}» desde ${ip || "?"}`);
  res.json({ ok: true });
});

// Agregar una llave pide la contraseña: una sesión robada no puede
// dejarse una llave propia para volver a entrar.
let regFails: number[] = [];

router.post("/passkey/register/options", requireAuth, async (req, res) => {
  const now = Date.now();
  regFails = regFails.filter(t => now - t < LOCK_MS);
  if (regFails.length >= 5) {
    res.status(429).json({ message: "Demasiados intentos. Prueba de nuevo en 15 min." });
    return;
  }
  const password = req.body?.password;
  if (typeof password !== "string" || password.length > 200 || !checkPassword(password)) {
    regFails.push(now);
    res.status(400).json({ message: "La contraseña no es correcta." });
    return;
  }
  try { res.json(await registrationOptions(res)); }
  catch (err: any) { res.status(400).json({ message: err?.message || "No se pudo empezar" }); }
});

router.post("/passkey/register/verify", requireAuth, async (req, res) => {
  try {
    await registerPasskey(req, res, req.body?.response, String(req.body?.name ?? ""));
    console.log(`🔑 Panel: llave de acceso nueva registrada desde ${clientIp(req) || "?"}`);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ message: err?.message || "No se pudo registrar la llave." });
  }
});

router.get("/passkeys", requireAuth, (_req, res) => {
  res.json({
    passkeys: listPasskeys().map(p => ({ id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })),
  });
});

router.post("/passkeys/:id/delete", requireAuth, (req, res) => {
  deletePasskey(String(req.params.id));
  res.json({ ok: true });
});

// ── IPs bloqueadas en el login del panel ──

router.get("/panel-blocked-ips", requireAuth, (_req, res) => {
  res.json({ total: countPanelBlockedIps(), ips: listPanelBlockedIps().slice(0, 100) });
});

router.post("/panel-blocked-ips/unblock", requireAuth, (req, res) => {
  const ip = String(req.body?.ip ?? "").slice(0, 64);
  unblockPanelIp(ip);
  for (const k of ["n:" + ip, "t:" + ip]) fails.delete(k);
  res.json({ ok: true });
});

router.post("/logout", (req, res) => {
  revokeAdminSession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

// ¿Esta conexión está bloqueada en el login? (para mostrar el GAME OVER
// apenas abre la página). Los dispositivos de confianza nunca lo ven.
router.get("/login-status", (req, res) => {
  const ip = clientIp(req);
  const blocked = !isTrustedDevice(req.cookies?.[TRUSTED_COOKIE]) && isPublicIp(ip) && isPanelIpBlocked(ip);
  res.json(blocked ? { blocked: true, ip } : { blocked: false });
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
  resetTrustedDevices();
  setTrustedDeviceCookie(res); // este dispositivo sigue siendo de confianza
  res.json({ ok: true, closed });
});

// Cambiar la contraseña: pide la actual; cierra las demás sesiones.
// Enlace con clave para la app que reenvía las notificaciones de Yape al
// bot. Sin la clave, el bot ya no confirma pedidos solo (ver bot:
// yape-key.service.ts).
async function yapeLink(path: string, method: "get" | "post") {
  const r = await axios.request({
    url: env.BOT_BASE_URL + "/api/dashboard/" + path, method,
    headers: { "x-dashboard-key": env.DASHBOARD_API_KEY }, timeout: 10_000,
  });
  const { key, required, publicBase } = r.data as { key: string; required: boolean; publicBase: string };
  const base = String(publicBase || "").replace(/\/+$/, "");
  return { key, required, url: base ? `${base}/api/yape/payment?key=${key}` : "" };
}

router.get("/yape-link", requireAuth, async (_req, res) => {
  try { res.json(await yapeLink("yape-key", "get")); }
  catch (err: any) { res.status(502).json({ message: "No se pudo consultar al bot: " + (err?.response?.status || err?.message) }); }
});

router.post("/yape-link/rotate", requireAuth, async (_req, res) => {
  try { res.json(await yapeLink("yape-key/rotate", "post")); }
  catch (err: any) { res.status(502).json({ message: "No se pudo consultar al bot: " + (err?.response?.status || err?.message) }); }
});

router.post("/password", requireAuth, (req, res) => {
  const current = String(req.body?.current ?? "");
  const next    = String(req.body?.next ?? "");
  if (!checkPassword(current)) return res.status(400).json({ message: "La contraseña actual no es correcta." });
  if (next.length < 10 || next.length > 100) return res.status(400).json({ message: "La nueva contraseña debe tener al menos 10 caracteres." });
  if (!/[a-zA-Z]/.test(next) || !/\d/.test(next)) return res.status(400).json({ message: "Usa letras y números en la nueva contraseña." });
  setPanelPassword(next);
  const closed = revokeAllAdminSessions(req.cookies?.[SESSION_COOKIE]);
  resetTrustedDevices();
  setTrustedDeviceCookie(res);
  res.json({ ok: true, closed });
});

export default router;
