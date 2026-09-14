import { Router } from "express";
import { getSummary } from "../services/stats.service";

const router = Router();

router.get("/summary", (_req, res) => {
  res.json(getSummary());
});

export default router;
