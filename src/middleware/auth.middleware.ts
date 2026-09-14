import { Request, Response, NextFunction } from "express";
import { SESSION_COOKIE, verifySessionToken } from "../services/auth.service";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!verifySessionToken(token)) {
    res.status(401).json({ message: "No autenticado" });
    return;
  }
  next();
}
