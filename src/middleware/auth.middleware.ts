import { Request, Response, NextFunction } from "express";
import { SESSION_COOKIE, verifySessionToken } from "../services/auth.service";
import { clientIp } from "../services/security.service";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!verifySessionToken(token, clientIp(req))) {
    res.status(401).json({ message: "No autenticado" });
    return;
  }
  next();
}
