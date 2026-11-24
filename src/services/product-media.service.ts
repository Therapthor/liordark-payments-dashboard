import fs from "fs";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import { db } from "../db/db";

// ─────────────────────────────────────────────────────────────
// IMÁGENES DE PRODUCTOS Y COMBOS — guardadas en el propio servidor
// (antes: enlaces de Cloudinary, que fallaba seguido).
//
// Cada imagen se guarda en 3 archivos con la misma huella en el nombre:
//   <nombre>.webp    720 px — detalle del producto (tienda, mayoristas, panel)
//   <nombre>-s.webp  360 px — tarjetas y fichas (lo que carga primero)
//   <nombre>.jpg     720 px — WhatsApp (no acepta WEBP) y el catálogo PDF
// Si la imagen llegó sin comprimir (JPG/PNG), se guarda tal cual y esa
// misma sirve para todo. Como el nombre lleva la huella del contenido,
// el navegador la guarda 1 año sin volver a preguntar (una imagen nueva
// siempre tiene otro nombre).
//
// El servidor no puede comprimir (su CPU no corre «sharp»): la compresión
// la hace Cloudinary en la migración (le pedimos la versión ya liviana) y
// el navegador del admin al subir desde el panel.
// ─────────────────────────────────────────────────────────────

export const MEDIA_DIR = path.resolve(process.cwd(), "data", "media", "products");
export const MEDIA_PREFIX = "/media/products/";
const PUBLIC_BASE = "https://liordark.com";
const NAME_RE = /^[a-z0-9-]{1,90}\.(webp|jpg|png)$/;
const MAX_BYTES = 4 * 1024 * 1024;

db.exec(`
  CREATE TABLE IF NOT EXISTS media_migration_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name  TEXT NOT NULL,
    row_id      INTEGER NOT NULL,
    old_url     TEXT NOT NULL,
    new_url     TEXT NOT NULL,
    bytes       INTEGER NOT NULL DEFAULT 0,
    migrated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export function isLocalMedia(url: string | null | undefined): boolean {
  return typeof url === "string" && url.startsWith(MEDIA_PREFIX);
}

/** Archivo en disco de una imagen nuestra (null si el nombre no es válido). */
export function mediaFilePath(name: string): string | null {
  if (!NAME_RE.test(name)) return null;
  return path.join(MEDIA_DIR, name);
}

/** WhatsApp y el PDF: JPG/PNG con dirección completa. */
export function botImageUrl(url: string): string {
  if (!isLocalMedia(url)) return url;
  return PUBLIC_BASE + (url.endsWith(".webp") ? url.replace(/\.webp$/, ".jpg") : url);
}

/** Archivo JPG/PNG en disco de una imagen nuestra (para el PDF). */
export function localJpegFile(url: string): string | null {
  if (!isLocalMedia(url)) return null;
  const name = url.slice(MEDIA_PREFIX.length).replace(/\.webp$/, ".jpg");
  const file = mediaFilePath(name);
  return file && fs.existsSync(file) ? file : null;
}

export type ImageKind = "webp" | "jpg" | "png" | "gif";

export function sniffImage(buf: Buffer | null | undefined): ImageKind | null {
  if (!buf || buf.length < 12) return null;
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.toString("ascii", 0, 4) === "GIF8") return "gif";
  return null;
}

function slug(label: string): string {
  const s = String(label || "producto").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "producto";
}

function writeAtomic(file: string, data: Buffer): void {
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * Guarda el juego de archivos de una imagen y devuelve su dirección
 * («/media/products/…»). `main` WEBP exige `jpg` (WhatsApp/PDF); `main`
 * JPG/PNG sirve para todo.
 */
export function saveProductImageSet(label: string, files: { main: Buffer; small?: Buffer | null; jpg?: Buffer | null }): string {
  const mainKind = sniffImage(files.main);
  if (!mainKind || mainKind === "gif") throw new Error("La imagen tiene que ser WEBP, JPG o PNG.");
  if (files.main.length > MAX_BYTES) throw new Error("La imagen pesa demasiado (máx. 4 MB).");
  const small = files.small && sniffImage(files.small) === mainKind && files.small.length <= MAX_BYTES ? files.small : files.main;
  if (mainKind === "webp" && sniffImage(files.jpg) !== "jpg") throw new Error("Falta la versión JPG de la imagen.");
  if (files.jpg && files.jpg.length > MAX_BYTES) throw new Error("La imagen pesa demasiado (máx. 4 MB).");

  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const hash = crypto.createHash("sha256").update(files.main).digest("hex").slice(0, 12);
  const base = `${slug(label)}-${hash}`;
  writeAtomic(path.join(MEDIA_DIR, `${base}.${mainKind}`), files.main);
  writeAtomic(path.join(MEDIA_DIR, `${base}-s.${mainKind}`), small);
  if (mainKind === "webp") writeAtomic(path.join(MEDIA_DIR, `${base}.jpg`), files.jpg!);
  return `${MEDIA_PREFIX}${base}.${mainKind}`;
}

// ── Migración: Cloudinary (u otro enlace) → servidor ──

/** La misma imagen de Cloudinary, pedida ya comprimida y del tamaño justo. */
export function cloudinaryVariant(url: string, transformation: string): string | null {
  const marker = "/upload/";
  const i = url.indexOf(marker);
  if (!/^https:\/\/res\.cloudinary\.com\//.test(url) || i === -1) return null;
  const rest = url.slice(i + marker.length).split("/");
  // Se quitan las transformaciones que ya tuviera (f_auto, w_…) si hay
  // versión (v123…) después: así manda solo la nuestra.
  const v = rest.findIndex(seg => /^v\d+$/.test(seg));
  const tail = v > 0 && rest.slice(0, v).every(seg => /^[a-z]{1,3}_[^/]*$/.test(seg)) ? rest.slice(v) : rest;
  return url.slice(0, i + marker.length) + transformation + "/" + tail.join("/");
}

// Por qué falló la última descarga (Cloudinary explica en «x-cld-error»).
let lastDownloadError = "";

async function download(url: string): Promise<Buffer | null> {
  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer", timeout: 20_000, maxContentLength: MAX_BYTES, maxRedirects: 3,
      headers: { Accept: "image/webp,image/jpeg,image/png,image/*;q=0.8" },
      validateStatus: s => s === 200,
    });
    return Buffer.from(res.data);
  } catch (err: any) {
    const status = err?.response?.status;
    const why = err?.response?.headers?.["x-cld-error"];
    lastDownloadError = status ? `HTTP ${status}${why ? " (" + String(why).slice(0, 120) + ")" : ""}`
      : /maxContentLength/i.test(String(err?.message)) ? "pesa más de 4 MB" : String(err?.code || err?.message || "sin respuesta").slice(0, 80);
    return null;
  }
}

type Row = { table: "catalog_products" | "catalog_combos" | "payment_methods"; id: number; label: string; url: string };

async function migrateOne(row: Row): Promise<{ ok: boolean; reason?: string; url?: string; bytes?: number }> {
  let saved: string | null = null;
  let bytes = 0;
  const big = cloudinaryVariant(row.url, "c_limit,w_720,f_webp,q_auto:good");
  let cloudinaryWhy = "";
  if (big) {
    const [main, small, jpg] = await Promise.all([
      download(big),
      download(cloudinaryVariant(row.url, "c_limit,w_360,f_webp,q_auto:good")!),
      download(cloudinaryVariant(row.url, "c_limit,w_720,f_jpg,q_auto:good")!),
    ]);
    if (sniffImage(main) === "webp" && sniffImage(jpg) === "jpg") {
      saved = saveProductImageSet(row.label, { main: main!, small, jpg });
      bytes = main!.length + (small?.length ?? 0);
    } else cloudinaryWhy = "versión liviana: " + (lastDownloadError || "formato inesperado");
  }
  if (!saved) {
    // Sin la versión comprimida: la original, si ya es JPG o PNG.
    const original = await download(row.url);
    const kind = sniffImage(original);
    if (kind !== "jpg" && kind !== "png") {
      const orig = original ? `original en formato ${kind ?? "desconocido"}` : "original: " + (lastDownloadError || "no descargó");
      return { ok: false, reason: [cloudinaryWhy, orig].filter(Boolean).join(" · ") };
    }
    saved = saveProductImageSet(row.label, { main: original! });
    bytes = original!.length;
  }
  const r = db.prepare(`UPDATE ${row.table} SET image_url = ?, updated_at = datetime('now') WHERE id = ? AND image_url = ?`)
    .run(saved, row.id, row.url);
  if (!r.changes) return { ok: false, reason: "cambió mientras se descargaba" };
  db.prepare(`INSERT INTO media_migration_log (table_name, row_id, old_url, new_url, bytes) VALUES (?, ?, ?, ?, ?)`)
    .run(row.table, row.id, row.url, saved, bytes);
  return { ok: true, url: saved, bytes };
}

let migrating: Promise<{ ok: number; fail: number }> | null = null;

/**
 * Pasa al servidor toda imagen de producto/combo que todavía sea un enlace
 * externo (https://…). Se llama al arrancar y después de guardar un
 * producto con un enlace pegado a mano. Las que fallan se reintentan en el
 * próximo arranque (el enlace viejo sigue funcionando mientras tanto).
 */
export function migrateExternalProductImages(): Promise<{ ok: number; fail: number }> {
  if (migrating) return migrating;
  migrating = (async () => {
    const rows: Row[] = [
      ...(db.prepare(`SELECT id, platform AS label, image_url AS url FROM catalog_products WHERE image_url LIKE 'http%'`).all() as any[])
        .map(r => ({ table: "catalog_products" as const, id: r.id, label: r.label, url: r.url })),
      ...(db.prepare(`SELECT id, name AS label, image_url AS url FROM payment_methods WHERE image_url LIKE 'http%'`).all() as any[])
        .map(r => ({ table: "payment_methods" as const, id: r.id, label: "pago-" + r.label, url: r.url })),
      ...(db.prepare(`SELECT id, name AS label, image_url AS url FROM catalog_combos WHERE image_url LIKE 'http%'`).all() as any[])
        .map(r => ({ table: "catalog_combos" as const, id: r.id, label: /^combo/i.test(r.label) ? r.label : "combo-" + r.label, url: r.url })),
    ];
    let ok = 0, fail = 0, total = 0;
    for (const row of rows) {
      try {
        const r = await migrateOne(row);
        if (r.ok) { ok++; total += r.bytes ?? 0; }
        else { fail++; console.warn(`⚠️ Imagen de ${row.label} (#${row.id}) sigue en el enlace externo: ${r.reason}`); }
      } catch (err: any) {
        fail++;
        console.warn(`⚠️ Imagen de ${row.label} (#${row.id}) no se pudo guardar: ${err?.message}`);
      }
    }
    if (rows.length) console.log(`🖼️ Imágenes de productos al servidor: ${ok} listas (${Math.round(total / 1024)} KB), ${fail} pendientes`);
    return { ok, fail };
  })().finally(() => { migrating = null; });
  return migrating;
}
