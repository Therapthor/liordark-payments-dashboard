import { Router } from "express";
import {
  listCatalogProducts,
  createCatalogProduct,
  updateCatalogProduct,
  deleteCatalogProduct,
  type CatalogProductInput,
} from "../db/catalog.repository";

const router = Router();

function parseBody(body: any): CatalogProductInput {
  return {
    platform:    String(body?.platform ?? "").trim(),
    title:       String(body?.title ?? "").trim(),
    price:       String(body?.price ?? "0").trim(),
    hasProfiles: !!body?.hasProfiles,
    description: String(body?.description ?? "").trim(),
    imageUrl:    String(body?.imageUrl ?? "").trim(),
  };
}

router.get("/products", (_req, res) => {
  res.json({ products: listCatalogProducts() });
});

router.post("/products", (req, res) => {
  const data = parseBody(req.body);
  if (!data.platform) { res.status(400).json({ message: "Falta el nombre de la plataforma." }); return; }
  res.status(201).json({ product: createCatalogProduct(data) });
});

router.put("/products/:id", (req, res) => {
  const id = Number(req.params.id);
  const data = parseBody(req.body);
  if (!data.platform) { res.status(400).json({ message: "Falta el nombre de la plataforma." }); return; }

  const product = updateCatalogProduct(id, data);
  if (!product) { res.status(404).json({ message: "Producto no encontrado." }); return; }
  res.json({ product });
});

router.delete("/products/:id", (req, res) => {
  deleteCatalogProduct(Number(req.params.id));
  res.status(204).end();
});

export default router;
