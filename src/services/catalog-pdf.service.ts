import PDFDocument from "pdfkit";
import axios from "axios";
import { listCatalogProducts } from "../db/catalog.repository";
import { listCombos } from "../db/combo.repository";
import { listPaymentMethods } from "../db/payment-method.repository";

// ─────────────────────────────────────────────────────────────
// PDF DEL CATÁLOGO — para el soporte de WhatsApp, mientras la tienda
// web no está lista. Se genera al vuelo con los productos ACTUALES
// (nunca queda desactualizado), con el número de soporte en cada
// página y el método de pago (Yape) al final.
// ─────────────────────────────────────────────────────────────

// pdfkit solo trae las fuentes estándar (Helvetica) — soportan tildes/ñ
// pero NO emojis (salen como glifos rotos), así que el texto del PDF va
// sin emojis aunque el botón del panel sí los use.
const SUPPORT_PHONE = "+51 963 081 436";
const BRAND         = "Manguitope";

const COLOR_TEXT   = "#241a10";
const COLOR_MUTED  = "#8a7660";
const COLOR_ACCENT = "#e35d00";
const COLOR_BORDER = "#f1e4d3";

function isAnnual(product: { title: string; keywords: string }): boolean {
  const haystack = (product.title + " " + product.keywords).toLowerCase();
  return haystack.includes("anual");
}

function drawHeader(doc: PDFKit.PDFDocument): void {
  doc
    .fillColor(COLOR_ACCENT).font("Helvetica-Bold").fontSize(11)
    .text(BRAND, 50, 28, { continued: false });
  doc
    .fillColor(COLOR_MUTED).font("Helvetica").fontSize(9)
    .text("Soporte WhatsApp: " + SUPPORT_PHONE, 50, 28, { align: "right", width: 495 });
  doc
    .moveTo(50, 48).lineTo(545, 48)
    .strokeColor(COLOR_BORDER).lineWidth(1).stroke();
  doc.y = 62;
}

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const res = await axios.get(url, { responseType: "arraybuffer", timeout: 10_000 });
    return Buffer.from(res.data);
  } catch {
    return null;
  }
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
    .text("Catálogo de productos", 50, doc.y + 6);
  doc
    .fillColor(COLOR_MUTED).font("Helvetica").fontSize(10)
    .text("Precios y disponibilidad al día de hoy. Cualquier duda, escribinos al soporte de arriba.", { width: 495 });
  doc.moveDown(1.2);

  const byPlatform = new Map<string, typeof products>();
  for (const p of products) {
    const list = byPlatform.get(p.platform) ?? [];
    list.push(p);
    byPlatform.set(p.platform, list);
  }

  for (const [platform, items] of byPlatform) {
    if (doc.y > 700) doc.addPage();

    doc
      .fillColor(COLOR_TEXT).font("Helvetica-Bold").fontSize(14)
      .text(platform, 50, doc.y + 8);
    doc.moveDown(0.3);

    for (const p of items) {
      if (doc.y > 720) doc.addPage();

      const annual = isAnnual(p);
      const titleLine = p.title + (annual ? "  (Plan anual)" : "");

      doc
        .fillColor(COLOR_TEXT).font("Helvetica-Bold").fontSize(11)
        .text(titleLine, 50, doc.y, { continued: true, width: 350 })
        .fillColor(COLOR_ACCENT).font("Helvetica-Bold")
        .text("   S/ " + p.price, { align: "right" });

      if (p.description) {
        doc
          .fillColor(COLOR_MUTED).font("Helvetica").fontSize(9.5)
          .text(p.description, 50, doc.y + 2, { width: 495 });
      }
      if (p.hasProfiles) {
        doc
          .fillColor(COLOR_MUTED).font("Helvetica-Oblique").fontSize(8.5)
          .text("Incluye perfil individual", 50, doc.y + 2);
      }
      doc.moveDown(0.6);
    }
    doc.moveDown(0.4);
  }

  if (combos.length > 0) {
    if (doc.y > 650) doc.addPage();
    doc
      .fillColor(COLOR_TEXT).font("Helvetica-Bold").fontSize(14)
      .text("Combos", 50, doc.y + 10);
    doc.moveDown(0.3);

    for (const c of combos) {
      if (doc.y > 700) doc.addPage();

      doc
        .fillColor(COLOR_TEXT).font("Helvetica-Bold").fontSize(11)
        .text(c.name, 50, doc.y, { continued: true, width: 350 })
        .fillColor(COLOR_ACCENT).font("Helvetica-Bold")
        .text("   S/ " + c.price, { align: "right" });

      const itemsLine = c.items.map(i => i.quantity > 1 ? `${i.platform} x${i.quantity}` : i.platform).join(" + ");
      doc
        .fillColor(COLOR_MUTED).font("Helvetica").fontSize(9.5)
        .text(itemsLine, 50, doc.y + 2, { width: 495 });

      if (c.description) {
        doc
          .fillColor(COLOR_MUTED).font("Helvetica-Oblique").fontSize(8.5)
          .text(c.description, 50, doc.y + 2, { width: 495 });
      }
      doc.moveDown(0.6);
    }
  }

  // ── Cómo pagar (Yape) — siempre al final ──────────────────────
  doc.addPage();
  doc
    .fillColor(COLOR_TEXT).font("Helvetica-Bold").fontSize(16)
    .text("Cómo pagar", 50, doc.y + 10);
  doc.moveDown(0.5);

  for (const m of methods) {
    doc
      .fillColor(COLOR_TEXT).font("Helvetica-Bold").fontSize(12)
      .text(m.name, 50, doc.y);
    if (m.description) {
      doc
        .fillColor(COLOR_MUTED).font("Helvetica").fontSize(10)
        .text(m.description, 50, doc.y + 2, { width: 495 });
    }
    doc.moveDown(0.5);

    const imgBuffer = await fetchImageBuffer(m.imageUrl);
    if (imgBuffer) {
      try {
        doc.image(imgBuffer, 50, doc.y, { width: 180 });
        doc.moveDown(10);
      } catch {
        // imagen corrupta o formato no soportado — se sigue sin ella
      }
    }
    doc.moveDown(0.6);
  }

  doc
    .fillColor(COLOR_MUTED).font("Helvetica").fontSize(10)
    .text(
      "Después de pagar, envía tu comprobante a nuestro soporte por WhatsApp: " + SUPPORT_PHONE,
      50, doc.y + 10, { width: 495 }
    );

  doc.end();
  return done;
}
