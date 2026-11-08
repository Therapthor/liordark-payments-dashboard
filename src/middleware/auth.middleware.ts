import { Request, Response, NextFunction } from "express";
import {
  SESSION_COOKIE, TRUSTED_COOKIE, verifySessionToken, isTrustedDevice, setTrustedDeviceCookie,
} from "../services/auth.service";
import { clientIp } from "../services/security.service";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!verifySessionToken(token, clientIp(req))) {
    res.status(401).json({ message: "No autenticado" });
    return;
  }
  // Los dispositivos con sesión abierta quedan como de confianza.
  if (!isTrustedDevice(req.cookies?.[TRUSTED_COOKIE])) setTrustedDeviceCookie(res);
  next();
}
