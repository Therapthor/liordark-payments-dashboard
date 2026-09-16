import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import { env } from "./config/env";
import { db } from "./db/db";
import { startSync, stopSync } from "./services/sync.service";
import { requireAuth } from "./middleware/auth.middleware";
import authRoutes from "./routes/auth.routes";
import liveRoutes from "./routes/live.routes";
import statsRoutes from "./routes/stats.routes";
import historyRoutes from "./routes/history.routes";
import accessRoutes from "./routes/access.routes";
import integrationsRoutes from "./routes/integrations.routes";
import ordersRoutes from "./routes/orders.routes";
import catalogRoutes from "./routes/catalog.routes";
import { seedCatalogIfEmpty } from "./db/catalog.repository";
import { getPlatformCatalog } from "./services/catalog.service";

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

const apiRouter = express.Router();
apiRouter.use("/auth", authRoutes);
apiRouter.use("/live", requireAuth, liveRoutes);
apiRouter.use("/stats", requireAuth, statsRoutes);
apiRouter.use("/history", requireAuth, historyRoutes);
apiRouter.use("/access", requireAuth, accessRoutes);
apiRouter.use("/orders", requireAuth, ordersRoutes);
apiRouter.use("/catalog", requireAuth, catalogRoutes);
// Sin requireAuth — se autentica con su propia clave compartida (x-bot-key),
// para que el bot pueda llamarla como servidor-a-servidor, sin sesión de navegador.
apiRouter.use("/integrations", integrationsRoutes);
app.use("/api", apiRouter);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Frontend estático — sin build, HTML/CSS/JS planos servidos directo.
app.use(express.static(path.resolve(process.cwd(), "public")));

const server = app.listen(env.PORT, () => {
  console.log(`🚀 Panel corriendo en http://localhost:${env.PORT}`);
  startSync();

  getPlatformCatalog()
    .then(seedCatalogIfEmpty)
    .catch((err: any) => console.error("⚠️ No se pudo sembrar el catálogo del panel:", err?.message));
});

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n🛑 ${signal} recibido — cerrando...`);

  stopSync();
  server.close();

  try {
    db.close();
  } catch { /* noop */ }

  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
