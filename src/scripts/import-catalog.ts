// ─────────────────────────────────────────────────────────────
// IMPORTAR CATÁLOGO DESDE EL EXPORT DEL BOT (Sheets/Cloudinary → panel)
//
// Lee el JSON generado por export-catalog.ts (repo del bot) y llena
// Configuración > Catálogo con precio, título, descripción e imagen
// reales de WhatsApp. Por plataforma: si ya existe en el panel, actualiza
// precio/título/descripción/imagen (no toca "activo" ni "con perfiles",
// que ya están bien desde la migración de Accesos); si no existe, la crea.
//
// Uso:
//   npx tsx src/scripts/import-catalog.ts export-catalog.json          (simulación — no escribe nada)
//   npx tsx src/scripts/import-catalog.ts export-catalog.json --apply  (escribe de verdad)
// ─────────────────────────────────────────────────────────────

import fs from "fs";
import {
  listCatalogProducts,
  createCatalogProduct,
  updateCatalogProduct,
} from "../db/catalog.repository";

type ExportedProduct = {
  platform:    string;
  price:       string;
  hasProfiles: boolean;
  title:       string;
  description: string;
  imageUrl:    string;
  keywords:    string;
};

type ExportFile = {
  generatedAt: string;
  products:    ExportedProduct[];
};

function main(): void {
  const args     = process.argv.slice(2);
  const apply    = args.includes("--apply");
  const jsonPath = args.find(a => !a.startsWith("--"));

  if (!jsonPath) {
    console.error("Uso: npx tsx src/scripts/import-catalog.ts <export.json> [--apply]");
    process.exit(1);
  }

  const data: ExportFile = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const existing = listCatalogProducts();

  let created = 0, updated = 0, skipped = 0;

  for (const prod of data.products) {
    if (!prod.platform) { skipped++; continue; }

    const match = existing.find(e => e.platform.trim().toUpperCase() === prod.platform.trim().toUpperCase());

    if (match) {
      updated++;
      console.error(`~ ${prod.platform}: precio "${match.price}"→"${prod.price}", imagen ${match.imageUrl ? "reemplazada" : "agregada"}`);
      if (apply) {
        updateCatalogProduct(match.id, {
          platform:    match.platform,
          title:       prod.title || match.title,
          price:       prod.price || match.price,
          hasProfiles: match.hasProfiles,
          description: prod.description || match.description,
          imageUrl:    prod.imageUrl || match.imageUrl,
          keywords:    prod.keywords || match.keywords,
        });
      }
    } else {
      created++;
      console.error(`+ ${prod.platform}: nuevo producto`);
      if (apply) {
        createCatalogProduct({
          platform:    prod.platform,
          title:       prod.title,
          price:       prod.price,
          hasProfiles: prod.hasProfiles,
          description: prod.description,
          imageUrl:    prod.imageUrl,
          keywords:    prod.keywords,
        });
      }
    }
  }

  console.error("");
  console.error(`Creados:  ${created}`);
  console.error(`Actualizados: ${updated}`);
  console.error(`Omitidos (sin plataforma): ${skipped}`);
  console.error("");
  console.error(apply ? "✅ Importado de verdad." : "👀 Simulación — no se escribió nada. Corre con --apply para hacerlo real.");
}

main();
