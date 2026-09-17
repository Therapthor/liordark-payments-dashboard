import { Router } from "express";
import {
  listProviders,
  createProvider,
  updateProvider,
  setProviderActive,
  deleteProvider,
  type ProviderInput,
} from "../db/provider.repository";

const router = Router();

function parseBody(body: any): ProviderInput {
  return {
    name:     String(body?.name ?? "").trim(),
    whatsapp: String(body?.whatsapp ?? "").replace(/\D/g, ""),
    notes:    String(body?.notes ?? "").trim(),
  };
}

router.get("/", (_req, res) => {
  res.json({ providers: listProviders() });
});

router.post("/", (req, res) => {
  const data = parseBody(req.body);
  if (!data.name) { res.status(400).json({ message: "Falta el nombre del proveedor." }); return; }
  res.status(201).json({ provider: createProvider(data) });
});

router.put("/:id", (req, res) => {
  const data = parseBody(req.body);
  if (!data.name) { res.status(400).json({ message: "Falta el nombre del proveedor." }); return; }
  const provider = updateProvider(Number(req.params.id), data);
  if (!provider) { res.status(404).json({ message: "Proveedor no encontrado." }); return; }
  res.json({ provider });
});

router.patch("/:id/active", (req, res) => {
  const provider = setProviderActive(Number(req.params.id), !!req.body?.active);
  if (!provider) { res.status(404).json({ message: "Proveedor no encontrado." }); return; }
  res.json({ provider });
});

router.delete("/:id", (req, res) => {
  deleteProvider(Number(req.params.id));
  res.status(204).end();
});

export default router;
