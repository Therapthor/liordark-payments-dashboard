import { Router } from "express";
import {
  backupConfig, saveBackupConfig, driveToken, rotateDriveToken, appsScriptCode,
  runBackup, backupRunning, testDrive, listBackupRuns, localBackups, BACKUP_DIR,
} from "../services/backup.service";

// ── COPIAS DE SEGURIDAD (Configuración › 💾 Copias) — solo admin ──
const router = Router();

router.get("/", (_req, res) => {
  const cfg = backupConfig();
  res.json({
    recipient: cfg.recipient,
    driveUrl: cfg.driveUrl,
    running: backupRunning(),
    runs: listBackupRuns(),
    local: localBackups(),
    localDir: BACKUP_DIR,
    appsScript: appsScriptCode(),
    tokenTail: driveToken().slice(-4),
  });
});

router.put("/config", (req, res) => {
  const r = saveBackupConfig({ recipient: req.body?.recipient, driveUrl: req.body?.driveUrl });
  if (!r.ok) return res.status(400).json({ message: r.message });
  res.json({ ok: true });
});

// Clave nueva: el código del Apps Script cambia y hay que volver a pegarlo.
router.post("/token/rotate", (_req, res) => {
  rotateDriveToken();
  res.json({ ok: true, appsScript: appsScriptCode() });
});

router.post("/test-drive", async (_req, res) => {
  const r = await testDrive();
  if (!r.ok) return res.status(400).json({ message: r.message });
  res.json(r);
});

// La copia tarda (base + cifrado + subida): se lanza y el panel consulta el estado.
router.post("/run", (_req, res) => {
  if (!backupConfig().recipient) return res.status(400).json({ message: "Falta tu llave pública: sin ella no se hace ninguna copia." });
  if (backupRunning()) return res.status(409).json({ message: "Ya hay una copia en curso." });
  runBackup("manual").catch(err => console.error("⚠️ copia de seguridad:", err?.message));
  res.status(202).json({ ok: true });
});

export default router;
