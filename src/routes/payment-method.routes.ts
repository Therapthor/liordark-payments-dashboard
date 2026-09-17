import { Router } from "express";
import {
  listPaymentMethods,
  createPaymentMethod,
  updatePaymentMethod,
  setPaymentMethodActive,
  deletePaymentMethod,
  type PaymentMethodInput,
} from "../db/payment-method.repository";

const router = Router();

function parseBody(body: any): PaymentMethodInput {
  return {
    name:        String(body?.name ?? "").trim(),
    description: String(body?.description ?? "").trim(),
  };
}

router.get("/", (_req, res) => {
  res.json({ methods: listPaymentMethods() });
});

router.post("/", (req, res) => {
  const data = parseBody(req.body);
  if (!data.name) { res.status(400).json({ message: "Falta el nombre del método de pago." }); return; }
  res.status(201).json({ method: createPaymentMethod(data) });
});

router.put("/:id", (req, res) => {
  const data = parseBody(req.body);
  if (!data.name) { res.status(400).json({ message: "Falta el nombre del método de pago." }); return; }
  const method = updatePaymentMethod(Number(req.params.id), data);
  if (!method) { res.status(404).json({ message: "Método de pago no encontrado." }); return; }
  res.json({ method });
});

router.patch("/:id/active", (req, res) => {
  const method = setPaymentMethodActive(Number(req.params.id), !!req.body?.active);
  if (!method) { res.status(404).json({ message: "Método de pago no encontrado." }); return; }
  res.json({ method });
});

router.delete("/:id", (req, res) => {
  deletePaymentMethod(Number(req.params.id));
  res.status(204).end();
});

export default router;
