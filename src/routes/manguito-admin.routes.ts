import { Router } from "express";
import { aiConfig, saveAiConfig, testAiConnection, isAiConfigured } from "../services/manguito.service";
import { usageSummary } from "../db/manguito.repository";

// ── Configuración › 🥭 Manguito Pro (solo admin) ──
// La clave o el token nunca vuelven al navegador: solo los últimos 4.
const router = Router();

function view() {
  const c = aiConfig();
  return {
    configured: isAiConfigured(),
    mode: c.apiKey ? "apiKey" : c.authToken ? "authToken" : "",
    secretTail: (c.apiKey || c.authToken).slice(-4),
    baseUrl: c.baseUrl,
    phones: c.phones,
    dailyCap: c.dailyCap,
    monthlyCap: c.monthlyCap,
    usage: usageSummary(),
  };
}

router.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(view());
});

router.post("/", (req, res) => {
  const err = saveAiConfig(req.body);
  if (err) { res.status(400).json({ message: err }); return; }
  res.json(view());
});

router.post("/test", async (_req, res) => {
  res.json(await testAiConnection());
});

export default router;
