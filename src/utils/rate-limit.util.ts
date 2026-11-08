import type { Request, Response, NextFunction } from "express";
import { clientIp } from "../services/security.service";

// ─────────────────────────────────────────────────────────────
// LÍMITE DE INTENTOS POR IP (solo POST) para los logins: cada intento hace
// bcrypt, y miles por segundo saturarían el servidor (auditoría M7).
// Generoso a propósito: en Perú muchos celulares comparten la misma IP.
// ─────────────────────────────────────────────────────────────

export function loginRateLimit(name: string, max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "POST") { next(); return; }
    const now = Date.now();
    const key = clientIp(req) || "?";
    const list = (hits.get(key) ?? []).filter(t => now - t < windowMs);
    if (list.length >= max) {
      const wait = Math.ceil((windowMs - (now - list[0]!)) / 60000);
      res.status(429).json({ message: `Demasiados intentos desde tu conexión. Prueba de nuevo en ${wait} min.` });
      return;
    }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 20000) {
      for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
      if (hits.size > 20000) hits.clear();
    }
    void name;
    next();
  };
}
