import { Router } from "express";
import { env } from "../config/env";
import { createAccountsBulk } from "../db/access.repository";

const router = Router();

// ─────────────────────────────────────────────────────────────
// POST /api/integrations/telegram-add
//
// El bot llama acá cuando se agrega una cuenta al stock por /add en
// Telegram — esta es la ÚNICA fuente ahora (ya no escribe nada en
// Sheets), así que si esto falla, el alta de stock falla también.
// Mismo candado que el bot usa para /api/dashboard/* (x-*-key +
// DASHBOARD_API_KEY compartida) — no depende de la sesión del navegador.
// ─────────────────────────────────────────────────────────────

router.post("/telegram-add", (req, res) => {
  const key = req.header("x-bot-key");
  if (!key || key !== env.DASHBOARD_API_KEY) {
    res.status(401).json({ message: "No autorizado" });
    return;
  }

  const { platform, email, password, hasProfiles, expiresAt, provider } = req.body ?? {};

  if (!platform?.trim() || !email?.trim() || !password) {
    res.status(400).json({ message: "Faltan platform, email o password." });
    return;
  }

  try {
    const [account] = createAccountsBulk({
      platform,
      provider: typeof provider === "string" ? provider : "",
      hasProfiles: hasProfiles !== false,
      expiresAt: typeof expiresAt === "string" ? expiresAt : null,
      pairs: [{ email, password }],
    });

    console.log("📥 Cuenta agregada desde Telegram /add: " + platform + " " + email);
    res.status(201).json({ ok: true, accountId: account?.id });
  } catch (err: any) {
    console.error("❌ Error reflejando cuenta de Telegram en Accesos:", err?.message);
    res.status(500).json({ message: "Error interno." });
  }
});

export default router;
