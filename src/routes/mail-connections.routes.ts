import { Router } from "express";
import {
  listMailConnections, deleteMailConnection, getMicrosoftClientId, setMicrosoftClientId,
  startOutlookLogin, outlookLoginStatus, connectGmail, testMailConnection,
} from "../services/mail-connections.service";

// Panel › Configuración › Correos (requiere sesión del panel).
const router = Router();

router.get("/", (_req, res) => {
  res.json({ microsoftClientId: getMicrosoftClientId(), connections: listMailConnections() });
});

// «ID de la aplicación (cliente)» de Microsoft — no es secreto.
router.put("/microsoft", (req, res) => {
  try {
    res.json({ microsoftClientId: setMicrosoftClientId(String(req.body?.clientId ?? "")) });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

router.post("/outlook/start", async (_req, res) => {
  try {
    res.json(await startOutlookLogin());
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

router.get("/outlook/status/:id", (req, res) => {
  const st = outlookLoginStatus(String(req.params.id));
  if (!st) { res.status(404).json({ message: "Ese inicio de sesión ya no existe. Toca «Conectar Outlook» otra vez." }); return; }
  res.json(st);
});

router.post("/gmail", async (req, res) => {
  try {
    res.json({ connection: await connectGmail(req.body?.email, req.body?.appPassword) });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

router.post("/:id/test", async (req, res) => {
  res.json(await testMailConnection(Number(req.params.id)));
});

router.delete("/:id", (req, res) => {
  if (!deleteMailConnection(Number(req.params.id))) { res.status(404).json({ message: "Esa conexión ya no existe." }); return; }
  res.json({ ok: true });
});

export default router;
