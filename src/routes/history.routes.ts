import { Router } from "express";
import { getHistory, getDayInfo } from "../services/stats.service";
import { getDayPayments } from "../db/payments.repository";
import { upsertManualEntry, deleteManualEntry } from "../db/ledger.repository";

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/", (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 365);
  res.json({ days: getHistory(days) });
});

router.get("/:date", (req, res) => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) {
    res.status(400).json({ message: "Fecha inválida, usa YYYY-MM-DD" });
    return;
  }
  const info = getDayInfo(date);
  const payments = info.source === "auto" ? getDayPayments(date) : [];
  res.json({ ...info, payments });
});

// Crear/editar un registro manual — solo para días SIN datos automáticos
// (backfill de días pasados, antes de que existiera el panel).
router.put("/:date", (req, res) => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) {
    res.status(400).json({ message: "Fecha inválida, usa YYYY-MM-DD" });
    return;
  }

  const amount = Number(req.body?.amount);
  const note   = typeof req.body?.note === "string" ? req.body.note.slice(0, 300) : "";

  if (!Number.isFinite(amount) || amount < 0) {
    res.status(400).json({ message: "El monto debe ser un número válido" });
    return;
  }

  const existing = getDayInfo(date);
  if (existing.source === "auto") {
    res.status(409).json({
      message: "Ese día ya tiene pagos reales registrados — no se puede sobrescribir manualmente.",
    });
    return;
  }

  upsertManualEntry(date, amount, note);
  res.json({ ok: true, day: getDayInfo(date) });
});

router.delete("/:date", (req, res) => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) {
    res.status(400).json({ message: "Fecha inválida, usa YYYY-MM-DD" });
    return;
  }
  deleteManualEntry(date);
  res.json({ ok: true });
});

export default router;
