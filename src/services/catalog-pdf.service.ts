import PDFDocument from "pdfkit";
import axios from "axios";
import { listCatalogProducts, type CatalogProduct } from "../db/catalog.repository";
import { listCombos, type Combo } from "../db/combo.repository";
import { listPaymentMethods } from "../db/payment-method.repository";

// ─────────────────────────────────────────────────────────────
// PDF DEL CATÁLOGO — para el soporte de WhatsApp, mientras la tienda
// web no está lista. Se genera al vuelo con los productos ACTUALES
// (nunca queda desactualizado), con el número de soporte en cada
// página y el método de pago (Yape) al final. Cada producto va en su
// propia tarjeta (imagen + info), no en una lista de texto plana.
// ─────────────────────────────────────────────────────────────

// pdfkit solo trae las fuentes estándar (Helvetica) — soportan tildes/ñ
// pero NO emojis (salen como glifos rotos), así que el texto del PDF va
// sin emojis aunque el botón del panel sí los use.
const SUPPORT_PHONE = "+51 963 081 436";
const BRAND         = "Manguitope";

const COLOR_TEXT    = "#241a10";
const COLOR_MUTED   = "#8a7660";
const COLOR_ACCENT  = "#e35d00";
const COLOR_BORDER  = "#f1e4d3";
const COLOR_CARD_BG = "#fffdfb";
const COLOR_CHIP_BG = "#fdf0e4";

const PAGE_LEFT  = 50;
const PAGE_RIGHT = 545;
const PAGE_W     = PAGE_RIGHT - PAGE_LEFT;
const CONTENT_BOTTOM = 760;
const CARD_H     = 92;
const IMG_SIZE   = 66;

function isAnnual(item: { title: string; keywords?: string }): boolean {
  const haystack = (item.title + " " + (item.keywords ?? "")).toLowerCase();
  return haystack.includes("anual");
}

function drawHeader(doc: PDFKit.PDFDocument): void {
  doc
    .fillColor(COLOR_ACCENT).font("Helvetica-Bold").fontSize(11)
    .text(BRAND, PAGE_LEFT, 28, { continued: false });
  doc
    .fillColor(COLOR_MUTED).font("Helvetica").fontSize(9)
    .text("Soporte WhatsApp: " + SUPPORT_PHONE, PAGE_LEFT, 28, { align: "right", width: PAGE_W });
  doc
    .moveTo(PAGE_LEFT, 48).lineTo(PAGE_RIGHT, 48)
    .strokeColor(COLOR_BORDER).lineWidth(1).stroke();
  doc.y = 64;
}

function drawSectionChip(doc: PDFKit.PDFDocument, label: string): void {
  // +CARD_H para que el título nunca quede solo al fondo de la página,
  // separado de su primera tarjeta.
  if (doc.y + 30 + CARD_H > CONTENT_BOTTOM) doc.addPage();
  const y = doc.y + 6;
  doc.roundedRect(PAGE_LEFT, y, PAGE_W, 24, 6).fillColor(COLOR_CHIP_BG).fill();
  doc
    .fillColor(COLOR_ACCENT).font("Helvetica-Bold").fontSize(11)
    .text(label.toUpperCase(), PAGE_LEFT + 12, y + 7);
  doc.y = y + 24 + 10;
}

// pdfkit solo lee JPEG y PNG — Cloudinary puede servir WEBP/AVIF según el
// navegador que las subió o cómo se armó la URL. En vez de convertir la
// imagen localmente (necesitaba "sharp", que no corre en este servidor —
// su CPU no soporta el set de instrucciones que exige el binario), se le
// pide a Cloudinary que la entregue ya en PNG agregando f_png a la URL.
function toPngUrl(url: string): string {
  const marker = "/upload/";
  const i = url.indexOf(marker);
  if (!url.includes("res.cloudinary.com") || i === -1) return url;
  return url.slice(0, i + marker.length) + "f_png/" + url.slice(i + marker.length);
}

async function fetchImageBuffer(url: string | undefined): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const res = await axios.get(toPngUrl(url), { responseType: "arraybuffer", timeout: 10_000 });
    return Buffer.from(res.data);
  } catch {
    return null;
  }
}

/** Tarjeta de un producto/combo: imagen a la izquierda, info a la derecha, precio al extremo. */
function drawItemCard(
  doc: PDFKit.PDFDocument,
  params: {
    title:       string;
    price:       string;
    subtitle:    string;   // descripción, o el detalle de un combo
    note?:       string | undefined;   // línea chica opcional (ej. "Incluye perfil individual")
    annual:      boolean;
    imgBuffer:   Buffer | null;
    fallbackTag: string;   // 2-3 letras si no hay imagen
  }
): void {
  if (doc.y + CARD_H > CONTENT_BOTTOM) doc.addPage();
  const y = doc.y;

  doc.roundedRect(PAGE_LEFT, y, PAGE_W, CARD_H, 10)
    .fillAndStroke(COLOR_CARD_BG, COLOR_BORDER);

  const imgX = PAGE_LEFT + 13;
  const imgY = y + (CARD_H - IMG_SIZE) / 2;

  if (params.imgBuffer) {
    try {
      doc.save();
      doc.roundedRect(imgX, imgY, IMG_SIZE, IMG_SIZE, 8).clip();
      doc.image(params.imgBuffer, imgX, imgY, { fit: [IMG_SIZE, IMG_SIZE], align: "center", valign: "center" });
      doc.restore();
    } catch {
      params.imgBuffer = null; // cae al placeholder de abajo si la imagen estaba corrupta
    }
  }
  if (!params.imgBuffer) {
    doc.roundedRect(imgX, imgY, IMG_SIZE, IMG_SIZE, 8).fillColor(COLOR_CHIP_BG).fill();
    doc
      .fillColor(COLOR_ACCENT).font("Helvetica-Bold").fontSize(13)
      .text(params.fallbackTag, imgX, imgY + IMG_SIZE / 2 - 7, { width: IMG_SIZE, align: "center" });
  }

  const textX     = imgX + IMG_SIZE + 16;
  const priceW    = 95;
  const titleW    = PAGE_RIGHT - 12 - priceW - textX;
  const titleTop  = y + 14;

  doc.fillColor(COLOR_TEXT).font("Helvetica-Bold").fontSize(12);
  doc.text(params.title, textX, titleTop, { width: titleW, lineBreak: false, ellipsis: true });

  if (params.annual) {
    const titleWidth = Math.min(doc.widthOfString(params.title), titleW);
    const badgeX = textX + titleWidth + 8;
    if (badgeX + 54 < PAGE_RIGHT - 12 - priceW) {
      doc.roundedRect(badgeX, titleTop - 1, 52, 15, 7).fillColor(COLOR_ACCENT).fill();
      doc
        .fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.5)
        .text("ANUAL", badgeX, titleTop + 3, { width: 52, align: "center" });
    }
  }

  doc
    .fillColor(COLOR_ACCENT).font("Helvetica-Bold").fontSize(13)
    .text("S/ " + params.price, PAGE_RIGHT - 12 - priceW, titleTop - 1, { width: priceW, align: "right" });

  if (params.subtitle) {
    doc
      .fillColor(COLOR_MUTED).font("Helvetica").fontSize(9)
      .text(params.subtitle, textX, titleTop + 20, { width: titleW + priceW, height: 30, ellipsis: true });
  }
  if (params.note) {
    doc
      .fillColor(COLOR_MUTED).font("Helvetica-Oblique").fontSize(8)
      .text(params.note, textX, y + CARD_H - 18, { width: titleW + priceW });
  }

  doc.y = y + CARD_H + 12;
}

export async function generateCatalogPdf(): Promise<Buffer> {
  const products = listCatalogProducts(true);
  const combos   = listCombos(true);
  const methods  = listPaymentMethods().filter(m => m.active);

  const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  doc.on("pageAdded", () => drawHeader(doc));
  drawHeader(doc); // primera página — "pageAdded" no dispara para la que ya crea el constructor

  doc
    .fillColor(COLOR_TEXT).font("Helvetica-Bold").fontSize(20)
    .text("Catálogo de productos", PAGE_LEFT, doc.y + 4);
  doc
    .fillColor(COLOR_MUTED).font("Helvetica").fontSize(10)
    .text("Precios y disponibilidad al día de hoy. Cualquier duda, escribinos al soporte de arriba.", { width: PAGE_W });
  doc.y += 16;

  const byPlatform = new Map<string, CatalogProduct[]>();
  for (const p of products) {
    const list = byPlatform.get(p.platform) ?? [];
    list.push(p);
    byPlatform.set(p.platform, list);
  }

  for (const [platform, items] of byPlatform) {
    drawSectionChip(doc, platform);

    for (const p of items) {
      const imgBuffer = await fetchImageBuffer(p.imageUrl);
      drawItemCard(doc, {
        title:       p.title,
        price:       p.price,
        subtitle:    p.description,
        note:        p.hasProfiles ? "Incluye perfil individual" : undefined,
        annual:      isAnnual(p),
        imgBuffer,
        fallbackTag: platform.slice(0, 3).toUpperCase(),
      });
    }
  }

  if (combos.length > 0) {
    drawSectionChip(doc, "Combos");

    for (const c of combos) {
      const itemsLine = c.items.map(i => i.quantity > 1 ? `${i.platform} x${i.quantity}` : i.platform).join(" + ");
      const imgBuffer = await fetchImageBuffer(c.imageUrl);
      drawItemCard(doc, {
        title:       c.name,
        price:       c.price,
        subtitle:    c.description || itemsLine,
        note:        c.description ? itemsLine : undefined,
        annual:      isAnnual({ title: c.name }),
        imgBuffer,
        fallbackTag: "COM",
      });
    }
  }

  // ── Cómo pagar (Yape) — siempre al final ──────────────────────
  doc.addPage();
  doc
    .fillColor(COLOR_TEXT).font("Helvetica-Bold").fontSize(16)
    .text("Cómo pagar", PAGE_LEFT, doc.y + 6);
  doc.y += 14;

  for (const m of methods) {
    doc
      .fillColor(COLOR_TEXT).font("Helvetica-Bold").fontSize(12)
      .text(m.name, PAGE_LEFT, doc.y);
    if (m.description) {
      doc
        .fillColor(COLOR_MUTED).font("Helvetica").fontSize(10)
        .text(m.description, PAGE_LEFT, doc.y + 4, { width: PAGE_W });
    }
    doc.y += 14;

    const imgBuffer = await fetchImageBuffer(m.imageUrl);
    if (imgBuffer) {
      try {
        doc.roundedRect(PAGE_LEFT, doc.y, 190, 190, 12).fillAndStroke(COLOR_CARD_BG, COLOR_BORDER);
        doc.image(imgBuffer, PAGE_LEFT + 10, doc.y + 10, { fit: [170, 170], align: "center", valign: "center" });
        doc.y += 202;
      } catch {
        // imagen corrupta o formato no soportado — se sigue sin ella
      }
    }
    doc.y += 8;
  }

  doc
    .fillColor(COLOR_MUTED).font("Helvetica").fontSize(10)
    .text(
      "Después de pagar, envía tu comprobante a nuestro soporte por WhatsApp: " + SUPPORT_PHONE,
      PAGE_LEFT, doc.y + 10, { width: PAGE_W }
    );

  doc.end();
  return done;
}
