import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import axios from "axios";
import Database from "better-sqlite3";
import { db } from "../db/db";

// ─────────────────────────────────────────────────────────────
// COPIAS DE SEGURIDAD — una vez al día, todo lo que NO está en GitHub:
// la base del panel, la del bot, los .env y ~/scripts. Los videos del
// curso (pesados) solo cuando cambian.
//
// Cerradas con age: el servidor solo tiene la llave PÚBLICA (el candado).
// La privada la crea y guarda el dueño en su equipo (herramienta offline
// public/tools/copias.html); sin ella nadie —ni el servidor, ni Google, ni
// quien robe un archivo— puede abrirlas. Nunca se guarda una copia sin cifrar.
//
// Quedan las últimas 7 en el servidor (~/liordark-backups) y se suben a
// Google Drive por un Apps Script del dueño (solo recibe y guarda; no
// entrega archivos, así que su link no sirve para bajarlas).
// ─────────────────────────────────────────────────────────────

const run = promisify(execFile);

db.exec(`
  CREATE TABLE IF NOT EXISTS backup_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS backup_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,              -- datos | media
    trigger TEXT NOT NULL,           -- auto | manual
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    ok INTEGER NOT NULL DEFAULT 0,
    file_name TEXT,
    size_bytes INTEGER,
    drive TEXT,                      -- ok | off | error
    error TEXT,
    contents TEXT                    -- qué se incluyó (lista corta)
  );
`);

const KEEP_LOCAL = 7;
const PART_BYTES = 15 * 1024 * 1024; // el Apps Script recibe hasta ~50 MB por envío (en base64)
const RECIPIENT_RE = /^age1[02-9ac-hj-np-z]{58}$/;
const DRIVE_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;

function getSetting(key: string): string {
  const r = db.prepare(`SELECT value FROM backup_settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return r?.value ?? "";
}
function setSetting(key: string, value: string): void {
  db.prepare(`INSERT INTO backup_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/** Clave que el Apps Script exige en cada envío (se crea sola la primera vez). */
export function driveToken(): string {
  let t = getSetting("drive_token");
  if (!t) { t = crypto.randomBytes(24).toString("base64url"); setSetting("drive_token", t); }
  return t;
}
export function rotateDriveToken(): string {
  setSetting("drive_token", crypto.randomBytes(24).toString("base64url"));
  return driveToken();
}

export function backupConfig() {
  return { recipient: getSetting("recipient"), driveUrl: getSetting("drive_url") };
}

export function saveBackupConfig(input: { recipient?: unknown; driveUrl?: unknown }): { ok: true } | { ok: false; message: string } {
  if (input.recipient !== undefined) {
    const r = String(input.recipient ?? "").trim();
    if (r.startsWith("AGE-SECRET-KEY")) {
      return { ok: false, message: "Esa es tu llave PRIVADA: nunca la pegues aquí. Pega la pública (empieza con «age1»)." };
    }
    if (r && !RECIPIENT_RE.test(r)) return { ok: false, message: "La llave pública no es válida: empieza con «age1» y tiene 62 caracteres." };
    setSetting("recipient", r);
  }
  if (input.driveUrl !== undefined) {
    const u = String(input.driveUrl ?? "").trim();
    if (u && !DRIVE_URL_RE.test(u)) return { ok: false, message: "El link del Apps Script debe ser como https://script.google.com/macros/s/…/exec" };
    setSetting("drive_url", u);
  }
  return { ok: true };
}

// ── Rutas en el servidor ──

const PANEL_DIR = process.cwd();
const BOT_DIR = process.env.BOT_DIR || path.resolve(PANEL_DIR, "..", "proyecto-cuentas-bot-backend");
const SCRIPTS_DIR = path.join(os.homedir(), "scripts");
const MEDIA_DIRS = ["data/course-media", "data/avisos-media"].map(d => path.join(PANEL_DIR, d));
export const BACKUP_DIR = process.env.BACKUP_DIR || path.join(os.homedir(), "liordark-backups");

function ensureBackupDir(): void {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(BACKUP_DIR, 0o700); } catch { /* no crítico */ }
}

function stamp(): string {
  // Hora de Lima (UTC−5) en el nombre: «2026-11-23-0320».
  const d = new Date(Date.now() - 5 * 3600_000).toISOString();
  return d.slice(0, 10) + "-" + d.slice(11, 13) + d.slice(14, 16);
}

function copyIfExists(src: string, dest: string, contents: string[], label: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  contents.push(label);
}

async function gitHead(dir: string): Promise<string> {
  try { return (await run("git", ["-C", dir, "log", "-1", "--format=%h %cs %s"])).stdout.trim(); } catch { return "—"; }
}

// age es un módulo ESM: se carga con import() real (tsc lo cambiaría por require()).
const esmImport = new Function("m", "return import(m)") as (m: string) => Promise<any>;

async function encryptFile(src: string, dest: string, recipient: string): Promise<void> {
  const age = await esmImport("age-encryption");
  const e = new age.Encrypter();
  e.addRecipient(recipient);
  const input = Readable.toWeb(fs.createReadStream(src)) as unknown as ReadableStream<Uint8Array>;
  const encrypted: ReadableStream<Uint8Array> = await e.encrypt(input);
  await pipeline(Readable.fromWeb(encrypted as any), fs.createWriteStream(dest, { mode: 0o600 }));
}

/** Arma la carpeta temporal → .tar.gz → .age; borra todo lo intermedio. */
async function buildArchive(kind: "datos" | "media", recipient: string): Promise<{ file: string; contents: string[] }> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ld-copia-"));
  fs.chmodSync(work, 0o700);
  const stage = path.join(work, kind);
  fs.mkdirSync(stage, { mode: 0o700 });
  const contents: string[] = [];
  try {
    if (kind === "datos") {
      // Copia consistente aunque el panel esté escribiendo (API de respaldo de SQLite).
      fs.mkdirSync(path.join(stage, "panel"), { recursive: true });
      await db.backup(path.join(stage, "panel", "payments.db"));
      contents.push("base del panel");
      const botDb = path.join(BOT_DIR, "data", "orders.db");
      if (fs.existsSync(botDb)) {
        fs.mkdirSync(path.join(stage, "bot"), { recursive: true });
        const b = new Database(botDb, { readonly: true, fileMustExist: true });
        try { await b.backup(path.join(stage, "bot", "orders.db")); } finally { b.close(); }
        contents.push("base del bot");
      }
      copyIfExists(path.join(PANEL_DIR, ".env.production"), path.join(stage, "panel", ".env.production"), contents, "config del panel");
      copyIfExists(path.join(BOT_DIR, ".env.production"), path.join(stage, "bot", ".env.production"), contents, "config del bot");
      copyIfExists(SCRIPTS_DIR, path.join(stage, "scripts"), contents, "~/scripts");
    } else {
      for (const dir of MEDIA_DIRS) copyIfExists(dir, path.join(stage, "panel", "data", path.basename(dir)), contents, path.basename(dir));
    }
    fs.writeFileSync(path.join(stage, "LEEME.txt"), [
      `Copia de seguridad (${kind}) — ${new Date().toISOString()}`,
      `Incluye: ${contents.join(", ") || "—"}`,
      `Panel: ${await gitHead(PANEL_DIR)}`,
      `Bot:   ${await gitHead(BOT_DIR)}`,
      "",
      "El código está en GitHub (Therapthor/liordark-payments-dashboard y Therapthor/proyecto-cuentas-bot-backend).",
      "Para restaurar: clonar ambos repos en el servidor, poner cada .env.production y data/*.db en su carpeta,",
      "npm install && npm run build, y arrancar con pm2.",
    ].join("\n"));

    const tarFile = path.join(work, `${kind}.tar.gz`);
    await run("tar", ["-czf", tarFile, "-C", work, kind]);
    ensureBackupDir();
    const out = path.join(BACKUP_DIR, `${kind}-${stamp()}.tar.gz.age`);
    await encryptFile(tarFile, out, recipient);
    return { file: out, contents };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Huella de la carpeta de videos: si no cambió, no se vuelve a copiar. */
function mediaFingerprint(): string {
  const h = crypto.createHash("sha256");
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(`${path.relative(PANEL_DIR, p)}|${st.size}|${Math.floor(st.mtimeMs)}\n`);
    }
  };
  MEDIA_DIRS.forEach(walk);
  return h.digest("hex");
}

function pruneLocal(kind: string, keep: number): void {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(kind + "-") && f.endsWith(".age")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
}

async function postDrive(body: Record<string, unknown>): Promise<any> {
  const url = getSetting("drive_url");
  const res = await axios.post(url, JSON.stringify({ token: driveToken(), ...body }), {
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    timeout: 5 * 60_000, maxBodyLength: Infinity, maxContentLength: 5 * 1024 * 1024,
    validateStatus: () => true,
  });
  let data: any = res.data;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { /* HTML de error */ } }
  if (!data || typeof data !== "object" || data.ok !== true) {
    const why = data?.error === "token" ? "la clave no coincide (vuelve a copiar el código del Apps Script)"
      : res.status >= 400 ? `Google respondió ${res.status}` : "respuesta inesperada del Apps Script";
    throw new Error("Drive: " + why);
  }
  return data;
}

/** Sube el archivo cifrado (en partes de 15 MB si es grande). */
async function uploadToDrive(file: string): Promise<void> {
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  const parts = Math.max(1, Math.ceil(size / PART_BYTES));
  const fd = fs.openSync(file, "r");
  try {
    for (let i = 0; i < parts; i++) {
      const len = Math.min(PART_BYTES, size - i * PART_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, i * PART_BYTES);
      const partName = parts === 1 ? name : `${name}.part${String(i + 1).padStart(2, "0")}of${String(parts).padStart(2, "0")}`;
      await postDrive({ action: "upload", name: partName, data: buf.toString("base64") });
    }
  } finally {
    fs.closeSync(fd);
  }
}

export async function testDrive(): Promise<{ ok: true; folder: string } | { ok: false; message: string }> {
  if (!getSetting("drive_url")) return { ok: false, message: "Primero pega el link del Apps Script." };
  try {
    const r = await postDrive({ action: "ping" });
    return { ok: true, folder: String(r.folder || "") };
  } catch (err: any) {
    return { ok: false, message: err?.message || "No se pudo conectar con Drive." };
  }
}

let running = false;
export function backupRunning(): boolean { return running; }

/** Una corrida: siempre «datos»; «media» solo si cambió desde la última. */
export async function runBackup(trigger: "auto" | "manual"): Promise<{ ok: boolean; message: string }> {
  const recipient = getSetting("recipient");
  if (!recipient) return { ok: false, message: "Falta tu llave pública: sin ella no se hace ninguna copia (nunca se guarda sin cifrar)." };
  if (running) return { ok: false, message: "Ya hay una copia en curso." };
  running = true;
  const messages: string[] = [];
  try {
    const kinds: ("datos" | "media")[] = ["datos"];
    const fp = mediaFingerprint();
    if (fp !== getSetting("media_fp")) kinds.push("media");
    for (const kind of kinds) {
      const id = Number(db.prepare(`INSERT INTO backup_runs (kind, trigger) VALUES (?, ?)`).run(kind, trigger).lastInsertRowid);
      try {
        const { file, contents } = await buildArchive(kind, recipient);
        const size = fs.statSync(file).size;
        let drive = "off", error: string | null = null;
        if (getSetting("drive_url")) {
          try { await uploadToDrive(file); drive = "ok"; } catch (err: any) { drive = "error"; error = err?.message || String(err); }
        }
        pruneLocal(kind, kind === "datos" ? KEEP_LOCAL : 2);
        if (kind === "media" && drive !== "error") setSetting("media_fp", fp);
        db.prepare(`UPDATE backup_runs SET finished_at = datetime('now'), ok = 1, file_name = ?, size_bytes = ?, drive = ?, error = ?, contents = ? WHERE id = ?`)
          .run(path.basename(file), size, drive, error, contents.join(", "), id);
        messages.push(`${kind}: ${size < 1048576 ? Math.max(1, Math.round(size / 1024)) + " KB" : (size / 1048576).toFixed(1) + " MB"}` + (drive === "ok" ? " · en Drive" : drive === "error" ? " · ⚠️ " + error : " · solo en el servidor"));
      } catch (err: any) {
        const msg = err?.message || String(err);
        db.prepare(`UPDATE backup_runs SET finished_at = datetime('now'), ok = 0, error = ? WHERE id = ?`).run(msg, id);
        messages.push(`${kind}: ❌ ${msg}`);
      }
    }
    const ok = !messages.some(m => m.includes("❌"));
    console.log(`💾 Copia de seguridad (${trigger}): ${messages.join(" | ")}`);
    return { ok, message: messages.join(" · ") };
  } finally {
    running = false;
  }
}

export function listBackupRuns(limit = 15) {
  return (db.prepare(`SELECT * FROM backup_runs ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map(r => ({
    id: r.id, kind: r.kind, trigger: r.trigger, startedAt: r.started_at, finishedAt: r.finished_at,
    ok: r.ok === 1, fileName: r.file_name, sizeBytes: r.size_bytes, drive: r.drive, error: r.error, contents: r.contents,
  }));
}

export function localBackups(): { name: string; sizeBytes: number }[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith(".age")).sort().reverse()
    .map(f => ({ name: f, sizeBytes: fs.statSync(path.join(BACKUP_DIR, f)).size }));
}

// ── Apps Script que el dueño pega en script.google.com ──
export function appsScriptCode(): string {
  return `// Copias de seguridad de Liordark → esta carpeta de tu Google Drive.
// Solo RECIBE archivos ya cifrados y los guarda; no entrega nada.
const TOKEN = ${JSON.stringify(driveToken())};
const FOLDER = "Copias Liordark";
const KEEP_DAYS_DATOS = 30;   // copias diarias de datos: se guardan 30 días
const KEEP_DAYS_MEDIA = 180;  // videos del curso: 6 meses

function carpeta_() {
  const it = DriveApp.getFoldersByName(FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER);
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: "json" }); }
  if (!req || req.token !== TOKEN) return json_({ ok: false, error: "token" });
  const f = carpeta_();
  if (req.action === "ping") return json_({ ok: true, folder: f.getName() });
  if (req.action !== "upload") return json_({ ok: false, error: "action" });
  if (!/^(datos|media)-[0-9a-z.-]+$/i.test(req.name || "")) return json_({ ok: false, error: "name" });
  const bytes = Utilities.base64Decode(req.data);
  const file = f.createFile(Utilities.newBlob(bytes, "application/octet-stream", req.name));
  const now = Date.now(), files = f.getFiles();
  while (files.hasNext()) {
    const x = files.next(), n = x.getName(), age = now - x.getDateCreated().getTime();
    if ((/^datos-/.test(n) && age > KEEP_DAYS_DATOS * 864e5) || (/^media-/.test(n) && age > KEEP_DAYS_MEDIA * 864e5)) x.setTrashed(true);
  }
  return json_({ ok: true, id: file.getId(), size: file.getSize() });
}
`;
}
