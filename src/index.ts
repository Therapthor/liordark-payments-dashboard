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
import paymentMethodRoutes from "./routes/payment-method.routes";
import providerRoutes from "./routes/provider.routes";
import stockRoutes from "./routes/stock.routes";
import renewalsRoutes from "./routes/renewals.routes";
import botFlowRoutes from "./routes/bot-flow.routes";
import { seedCatalogIfEmpty } from "./db/catalog.repository";
import { seedPaymentMethodsIfEmpty } from "./db/payment-method.repository";
import { seedBotFlowConfigIfEmpty } from "./db/bot-flow.repository";
import { getPlatformCatalog } from "./services/catalog.service";
import { archiveExpiredAccounts } from "./db/access-history.repository";
import { limaTodayISO } from "./services/access.service";

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
apiRouter.use("/payment-methods", requireAuth, paymentMethodRoutes);
apiRouter.use("/providers", requireAuth, providerRoutes);
apiRouter.use("/renewals", requireAuth, renewalsRoutes);
apiRouter.use("/bot-flow", requireAuth, botFlowRoutes);
// Sin requireAuth — se autentica con su propia clave compartida (x-bot-key),
// para que el bot pueda llamarla como servidor-a-servidor, sin sesión de navegador.
apiRouter.use("/integrations", integrationsRoutes);
// Igual que integrations — su propio candado (x-bot-key) adentro del router.
apiRouter.use("/stock", stockRoutes);
app.use("/api", apiRouter);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Frontend estático — sin build, HTML/CSS/JS planos servidos directo.
// no-cache: sin esto el navegador a veces sirve una versión vieja de un
// .js/.css cacheada aunque el archivo ya se haya reemplazado en el deploy.
app.use(express.static(path.resolve(process.cwd(), "public"), {
  setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
}));

const server = app.listen(env.PORT, () => {
  console.log(`🚀 Panel corriendo en http://localhost:${env.PORT}`);
  startSync();

  getPlatformCatalog()
    .then(seedCatalogIfEmpty)
    .catch((err: any) => console.error("⚠️ No se pudo sembrar el catálogo del panel:", err?.message));
  seedPaymentMethodsIfEmpty();
  seedBotFlowConfigIfEmpty();

  runArchiveExpiredAccounts();
  setInterval(runArchiveExpiredAccounts, ARCHIVE_INTERVAL_MS);
});

// Cuentas vencidas (Accesos) — se archivan solas a Historial y se borran de
// las tablas activas. Al arrancar y cada hora, no hace falta más seguido.
const ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;

function runArchiveExpiredAccounts(): void {
  try {
    const archived = archiveExpiredAccounts(limaTodayISO());
    if (archived > 0) console.log(`🗄️  ${archived} cuenta(s) vencida(s) archivadas a Historial`);
  } catch (err: any) {
    console.error("⚠️ Error archivando cuentas vencidas:", err?.message);
  }
}

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
