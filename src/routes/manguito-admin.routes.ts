import { Router } from "express";
import {
  aiConfig, saveAiConfig, testAiConnection, isAiConfigured, listCredentials, credentialState,
  addCredential, editCredential, deleteCredential,
} from "../services/manguito.service";
import { usageSummary, monthSpendByCredential } from "../db/manguito.repository";

// ── Configuración › 🥭 Manguito Pro (solo admin) ──
// Las claves nunca vuelven al navegador: solo sus últimos 4 caracteres.
const router = Router();

function view() {
  const c = aiConfig();
  const spend = monthSpendByCredential();
  return {
    configured: isAiConfigured(),
    credentials: listCredentials().map(k => ({
      id: k.id, label: k.label, kind: k.kind, tail: k.secret.slice(-4), baseUrl: k.baseUrl,
      enabled: k.enabled, ...credentialState(k), failedAt: k.failedAt, lastOkAt: k.lastOkAt,
      monthUsd: spend[k.id] ?? 0,
    })),
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

// Celulares con acceso y topes.
router.post("/", (req, res) => {
  const err = saveAiConfig(req.body);
  if (err) { res.status(400).json({ message: err }); return; }
  res.json(view());
});

// Lista de claves: agregar, editar (activar, subir/bajar, quitar pausa), borrar, probar.
router.post("/keys", (req, res) => {
  const err = addCredential(req.body);
  if (err) { res.status(400).json({ message: err }); return; }
  res.status(201).json(view());
});

router.patch("/keys/:id", (req, res) => {
  const err = editCredential(String(req.params.id), req.body);
  if (err) { res.status(404).json({ message: err }); return; }
  res.json(view());
});

router.delete("/keys/:id", (req, res) => {
  if (!deleteCredential(String(req.params.id))) { res.status(404).json({ message: "Esa clave ya no existe." }); return; }
  res.json(view());
});

router.post("/keys/:id/test", async (req, res) => {
  const r = await testAiConnection(String(req.params.id));
  res.json({ ...r, view: view() });
});

router.post("/test", async (_req, res) => {
  const r = await testAiConnection();
  res.json({ ...r, view: view() });
});

export default router;
