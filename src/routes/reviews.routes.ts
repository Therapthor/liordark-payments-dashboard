import { Router } from "express";
import {
  listAllReviews, countPendingReviews, createPanelReview, setReviewStatus, deleteReview,
  cleanReviewInput, getStoreSections, setStoreSection, type ReviewStatus,
} from "../db/reviews.repository";
import { invalidateStoreReviewsCache } from "./store.routes";

// Panel › Configuración › Reseñas (requiere sesión del panel).
const router = Router();

router.get("/", (_req, res) => {
  res.json({ reviews: listAllReviews(), pending: countPendingReviews(), sections: getStoreSections() });
});

// Prender / apagar en la tienda: { reviewsEnabled?, faqEnabled? }
router.put("/sections", (req, res) => {
  const body = req.body ?? {};
  if (typeof body.reviewsEnabled === "boolean") setStoreSection("reviews", body.reviewsEnabled);
  if (typeof body.faqEnabled === "boolean") setStoreSection("faq", body.faqEnabled);
  invalidateStoreReviewsCache();
  res.json({ sections: getStoreSections() });
});

// Reseña real que el dueño recibió por otro lado (WhatsApp, Facebook…).
router.post("/", (req, res) => {
  const input = cleanReviewInput(req.body);
  if ("error" in input) { res.status(400).json({ message: input.error }); return; }
  const review = createPanelReview(input.author, input.stars, input.body);
  invalidateStoreReviewsCache();
  res.json({ review });
});

router.patch("/:id", (req, res) => {
  const status = String(req.body?.status ?? "") as ReviewStatus;
  if (!["publicada", "oculta", "pendiente"].includes(status)) { res.status(400).json({ message: "Estado inválido." }); return; }
  const review = setReviewStatus(Number(req.params.id), status);
  if (!review) { res.status(404).json({ message: "Reseña no encontrada." }); return; }
  invalidateStoreReviewsCache();
  res.json({ review });
});

router.delete("/:id", (req, res) => {
  if (!deleteReview(Number(req.params.id))) { res.status(404).json({ message: "Reseña no encontrada." }); return; }
  invalidateStoreReviewsCache();
  res.json({ ok: true });
});

export default router;
