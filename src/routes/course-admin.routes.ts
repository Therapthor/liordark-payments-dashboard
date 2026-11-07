import { Router, raw } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { findCustomerByPhone, createCustomer } from "../db/customer.repository";
import { hashPassword } from "../services/customer-auth.service";
import {
  adminOverview, sanitizeCues, setCues, setCoursePrice, grantCourseManually, revokeCoursePurchase,
  isMediaKind, mediaPath, ensureMediaDir, MEDIA_DIR, getCoursePrice, setCoursePublished, setCourseRegularPrice, getCoursePricing, isCoursePublished,
} from "../services/course.service";

// ─────────────────────────────────────────────────────────────
// CURSO — sección 🎓 Curso del panel admin (requireAuth en index.ts).
// Subida de videos/Excel POR PARTES: nginx suele cortar cuerpos de más
// de 1 MB, así que el navegador manda trozos de ~768 KB y acá se van
// pegando en un archivo temporal; al llegar el último se reemplaza el
// archivo final de una sola vez (nunca queda un video a medias visible).
// ─────────────────────────────────────────────────────────────

const router = Router();

const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB por archivo

router.get("/overview", (_req, res) => {
  res.json(adminOverview());
});

router.put("/cues", (req, res) => {
  const cues = sanitizeCues(req.body?.cues);
  if (!cues) return res.status(400).json({ message: "Tiempos inválidos. Revisa que inicio ≤ fin y que sean números." });
  setCues(cues);
  res.json({ ok: true, cues });
});

// Publicar / volver a borrador.
router.put("/published", (req, res) => {
  setCoursePublished(req.body?.published === true);
  res.json({ ok: true, published: isCoursePublished() });
});

router.put("/price", (req, res) => {
  const price = Number(req.body?.price);
  const regular = req.body?.regularPrice === undefined ? null : Number(req.body.regularPrice);
  if (!Number.isFinite(price) || price <= 0 || price > 10000) return res.status(400).json({ message: "Precio inválido." });
  if (regular !== null && (!Number.isFinite(regular) || regular <= 0 || regular > 10000)) return res.status(400).json({ message: "Precio normal inválido." });
  setCoursePrice(price);
  if (regular !== null) setCourseRegularPrice(regular);
  res.json({ ok: true, ...getCoursePricing() });
});

// Acceso manual (pagó por otro medio). Si el celular no tiene cuenta en la
// tienda, se le crea una con un PIN de 4 dígitos para que pueda entrar.
router.post("/grant", async (req, res) => {
  const digits = String(req.body?.phone ?? "").replace(/\D/g, "");
  const amount = Number(req.body?.amount ?? 0);
  if (digits.length < 9) return res.status(400).json({ message: "Celular inválido." });
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ message: "Monto inválido." });

  let customer = findCustomerByPhone(digits);
  let newPin: string | null = null;
  if (!customer) {
    newPin = String(crypto.randomInt(10000)).padStart(4, "0");
    customer = createCustomer(digits, await hashPassword(newPin), newPin, true);
  }
  const purchase = grantCourseManually(customer.id, customer.phone, amount.toFixed(2));
  res.json({ ok: true, purchaseId: purchase.id, phone: customer.phone, newPin });
});

router.post("/purchases/:id/revoke", (req, res) => {
  if (!revokeCoursePurchase(Number(req.params.id))) return res.status(404).json({ message: "Compra no encontrada." });
  res.json({ ok: true });
});

// POST /upload?kind=ep1&uploadId=abc&offset=0&total=123 — cuerpo binario.
router.post("/upload", raw({ type: "application/octet-stream", limit: "2mb" }), (req, res) => {
  const kind = String(req.query.kind ?? "");
  const uploadId = String(req.query.uploadId ?? "");
  const offset = Number(req.query.offset);
  const total = Number(req.query.total);
  const chunk = req.body as Buffer;

  if (!isMediaKind(kind)) return res.status(400).json({ message: "Tipo de archivo inválido." });
  if (!/^[a-z0-9]{8,40}$/i.test(uploadId)) return res.status(400).json({ message: "uploadId inválido." });
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(total) || total <= 0 || total > MAX_FILE_BYTES) {
    return res.status(400).json({ message: "Tamaño inválido." });
  }
  if (!Buffer.isBuffer(chunk) || chunk.length === 0) return res.status(400).json({ message: "Parte vacía." });
  if (offset + chunk.length > total) return res.status(400).json({ message: "La parte se pasa del tamaño total." });

  ensureMediaDir();
  const tmp = path.join(MEDIA_DIR, ".upload-" + kind + "-" + uploadId);

  let current = 0;
  try { current = fs.statSync(tmp).size; } catch { current = 0; }
  if (offset === 0 && current > 0) { fs.truncateSync(tmp, 0); current = 0; }
  if (current !== offset) {
    // El navegador reintenta desde donde de verdad quedó el archivo.
    return res.status(409).json({ message: "Desfase de subida.", expectedOffset: current });
  }

  try {
    fs.appendFileSync(tmp, chunk);
  } catch (err: any) {
    const full = err?.code === "ENOSPC";
    return res.status(507).json({ message: full ? "El servidor se quedó sin espacio en disco." : "No se pudo guardar la parte." });
  }

  const received = offset + chunk.length;
  if (received < total) return res.json({ ok: true, received });

  // Último trozo: se valida lo básico y se reemplaza el archivo final.
  const fd = fs.openSync(tmp, "r");
  const head = Buffer.alloc(12);
  fs.readSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);
  const isMp4 = head.subarray(4, 8).toString("latin1") === "ftyp";
  const isZip = head[0] === 0x50 && head[1] === 0x4b; // .xlsx es un zip
  if ((kind === "gestor" && !isZip) || (kind !== "gestor" && !isMp4)) {
    fs.rmSync(tmp, { force: true });
    return res.status(400).json({
      message: kind === "gestor" ? "El archivo no parece un Excel (.xlsx)." : "El archivo no parece un video MP4.",
    });
  }
  fs.renameSync(tmp, mediaPath(kind));
  cleanStaleUploads();
  res.json({ ok: true, received, done: true });
});

// Borra temporales de subidas abandonadas (más de 1 día).
function cleanStaleUploads(): void {
  try {
    for (const f of fs.readdirSync(MEDIA_DIR)) {
      if (!f.startsWith(".upload-")) continue;
      const full = path.join(MEDIA_DIR, f);
      if (Date.now() - fs.statSync(full).mtimeMs > 24 * 60 * 60 * 1000) fs.rmSync(full, { force: true });
    }
  } catch { /* no crítico */ }
}

// Vista previa para el admin (mismo archivo que ve el alumno).
router.get("/media/:kind", (req, res) => {
  const kind = String(req.params.kind);
  if (!isMediaKind(kind)) return res.status(404).end();
  const file = mediaPath(kind);
  if (!fs.existsSync(file)) return res.status(404).json({ message: "Todavía no subido." });
  if (kind === "gestor") return res.download(file, "Gestor-de-cuentas-Manguitope.xlsx");
  res.type("video/mp4");
  res.sendFile(file);
});

export default router;
