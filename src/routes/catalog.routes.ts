import { Router } from "express";
import {
  listCatalogProducts,
  createCatalogProduct,
  updateCatalogProduct,
  deleteCatalogProduct,
  setCatalogProductActive,
  type CatalogProductInput,
} from "../db/catalog.repository";
import {
  listCombos,
  createCombo,
  updateCombo,
  deleteCombo,
  setComboActive,
  type ComboInput,
  type ComboItem,
} from "../db/combo.repository";

const router = Router();

// ── PRODUCTOS ──

function parseProductBody(body: any): CatalogProductInput {
  return {
    platform:    String(body?.platform ?? "").trim(),
    title:       String(body?.title ?? "").trim(),
    price:       String(body?.price ?? "0").trim(),
    hasProfiles: !!body?.hasProfiles,
    description: String(body?.description ?? "").trim(),
    imageUrl:    String(body?.imageUrl ?? "").trim(),
    keywords:    String(body?.keywords ?? "").trim(),
  };
}

router.get("/products", (_req, res) => {
  res.json({ products: listCatalogProducts() });
});

router.post("/products", (req, res) => {
  const data = parseProductBody(req.body);
  if (!data.platform) { res.status(400).json({ message: "Falta el nombre de la plataforma." }); return; }
  res.status(201).json({ product: createCatalogProduct(data) });
});

router.put("/products/:id", (req, res) => {
  const id = Number(req.params.id);
  const data = parseProductBody(req.body);
  if (!data.platform) { res.status(400).json({ message: "Falta el nombre de la plataforma." }); return; }

  const product = updateCatalogProduct(id, data);
  if (!product) { res.status(404).json({ message: "Producto no encontrado." }); return; }
  res.json({ product });
});

router.patch("/products/:id/active", (req, res) => {
  const product = setCatalogProductActive(Number(req.params.id), !!req.body?.active);
  if (!product) { res.status(404).json({ message: "Producto no encontrado." }); return; }
  res.json({ product });
});

router.delete("/products/:id", (req, res) => {
  deleteCatalogProduct(Number(req.params.id));
  res.status(204).end();
});

// ── COMBOS ──

function parseComboItems(rawItems: any): ComboItem[] {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .map((it: any) => {
      const quantity = Number(it?.quantity);
      return {
        platform: String(it?.platform ?? "").trim(),
        quantity: Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity) : 1,
      };
    })
    .filter((it: ComboItem) => it.platform);
}

function parseComboBody(body: any): ComboInput {
  return {
    name:        String(body?.name ?? "").trim(),
    price:       String(body?.price ?? "0").trim(),
    description: String(body?.description ?? "").trim(),
    imageUrl:    String(body?.imageUrl ?? "").trim(),
    items:       parseComboItems(body?.items),
  };
}

router.get("/combos", (_req, res) => {
  res.json({ combos: listCombos() });
});

router.post("/combos", (req, res) => {
  const data = parseComboBody(req.body);
  if (!data.name)          { res.status(400).json({ message: "Falta el nombre del combo." }); return; }
  if (data.items.length < 2) { res.status(400).json({ message: "Un combo necesita al menos 2 plataformas." }); return; }
  res.status(201).json({ combo: createCombo(data) });
});

router.put("/combos/:id", (req, res) => {
  const id = Number(req.params.id);
  const data = parseComboBody(req.body);
  if (!data.name)          { res.status(400).json({ message: "Falta el nombre del combo." }); return; }
  if (data.items.length < 2) { res.status(400).json({ message: "Un combo necesita al menos 2 plataformas." }); return; }

  const combo = updateCombo(id, data);
  if (!combo) { res.status(404).json({ message: "Combo no encontrado." }); return; }
  res.json({ combo });
});

router.patch("/combos/:id/active", (req, res) => {
  const combo = setComboActive(Number(req.params.id), !!req.body?.active);
  if (!combo) { res.status(404).json({ message: "Combo no encontrado." }); return; }
  res.json({ combo });
});

router.delete("/combos/:id", (req, res) => {
  deleteCombo(Number(req.params.id));
  res.status(204).end();
});

export default router;
