import { Router } from "express";
import {
  aiConfig, saveAiConfig, testAiConnection, isAiConfigured, listCredentials, credentialState,
  addCredential, editCredential, deleteCredential, storeAdminView, saveStoreConfig, giftToPhone,
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
    freePaused: c.freePaused,
    phoneCaps: Object.entries(c.phoneCaps).map(([p, v]) => `${p} = ${v}`).join("\n"),
    burstMessages: c.burstMessages,
    pausesPerDay: c.pausesPerDay,
    dailyCap: c.dailyCap,
    clientMonthlyCap: c.clientMonthlyCap,
    monthlyCap: c.monthlyCap,
    usage: usageSummary(),
    ...storeAdminView(),
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

// Venta: activar en la tienda, plan mensual, paquetes de créditos, tipo de cambio.
router.post("/store", (req, res) => {
  const err = saveStoreConfig(req.body);
  if (err) { res.status(400).json({ message: err }); return; }
  res.json(view());
});

// Regalar créditos o 30 días de plan a un cliente (por celular).
router.post("/gift", (req, res) => {
  const err = giftToPhone(req.body?.phone, req.body?.kind === "plan" ? "plan" : "credits", req.body?.usd);
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
  if (err) { res.status(400).json({ message: err }); return; }
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
