import type { Request, Response } from "express";

// ─────────────────────────────────────────────────────────────
// UN INTENTO A LA VEZ POR CUENTA — la contraseña/PIN se revisa con bcrypt
// (asíncrono). Si llegaban 40 intentos juntos, todos pasaban el control de
// bloqueo antes de que se anotara el primer fallo (auditoría 8-nov, A1).
// Con esto, mientras se revisa un intento de un celular, los demás de ese
// mismo celular reciben 429; el fallo queda anotado antes del siguiente.
// ─────────────────────────────────────────────────────────────

type Handler = (req: Request, res: Response) => Promise<unknown>;

export function oneAtATime(keyOf: (req: Request) => string) {
  const busy = new Set<string>();
  return (handler: Handler) => async (req: Request, res: Response): Promise<void> => {
    const key = keyOf(req);
    if (!key) { await handler(req, res); return; }
    if (busy.has(key)) {
      res.status(429).json({ message: "Espera un momento y vuelve a intentarlo." });
      return;
    }
    busy.add(key);
    try { await handler(req, res); } finally { busy.delete(key); }
  };
}

/** Clave por celular (últimos 9 dígitos). */
export const phoneKey = (req: Request) => String(req.body?.phone ?? "").replace(/\D/g, "").slice(-9);
