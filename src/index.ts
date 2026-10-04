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
import customerAuthRoutes from "./routes/customer-auth.routes";
import storeRoutes from "./routes/store.routes";
import customersRoutes from "./routes/customers.routes";
import wholesalerAuthRoutes from "./routes/wholesaler-auth.routes";
import wholesalerRoutes from "./routes/wholesaler.routes";
import wholesalersAdminRoutes from "./routes/wholesalers-admin.routes";
import { requireWholesalerSession } from "./services/wholesaler-auth.service";
import { seedCatalogIfEmpty } from "./db/catalog.repository";
import { seedPaymentMethodsIfEmpty } from "./db/payment-method.repository";
import { seedBotFlowConfigIfEmpty } from "./db/bot-flow.repository";
import { getPlatformCatalog } from "./services/catalog.service";
import { archiveExpiredAccounts } from "./db/access-history.repository";
import { limaTodayISO } from "./services/access.service";
import { disableInactiveWholesalers } from "./db/wholesaler.repository";

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
// ─── Tienda web (liordark.com) — clientes, no admins. Login propio,
// separado del de arriba (requireAuth es el del panel de administración). ──
apiRouter.use("/store/auth", customerAuthRoutes);
apiRouter.use("/store", storeRoutes);
apiRouter.use("/customers", requireAuth, customersRoutes);
// ─── Mayorista (mayorista.liordark.com) — login propio, separado tanto
// del de clientitos como del de admin.
apiRouter.use("/wholesaler/auth", wholesalerAuthRoutes);
apiRouter.use("/wholesaler", requireWholesalerSession, wholesalerRoutes);
// Gestión de mayoristas desde el panel admin (crear cuentas, ajustar
// saldo, asignar stock, cola de cuentas completas) — requireAuth normal.
apiRouter.use("/wholesalers", requireAuth, wholesalersAdminRoutes);
app.use("/api", apiRouter);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Frontend estático — sin build, HTML/CSS/JS planos servidos directo.
// no-cache: sin esto el navegador a veces sirve una versión vieja de un
// .js/.css cacheada aunque el archivo ya se haya reemplazado en el deploy.
//
// Un solo proceso sirve TRES sitios distintos según el dominio con el que
// entren (mismo servidor, nginx apunta los tres acá): liordark.com es la
// tienda para clientes (public-store/), mayorista.liordark.com es el panel
// de distribuidores (public-wholesale/), y cualquier otro host (panel.
// liordark.com, IP directa, localhost) sigue siendo el panel de admin
// (public/) — no cambia nada de cómo ya se accede a los dos primeros.
const noCacheHeaders = { setHeaders: (res: any) => res.setHeader("Cache-Control", "no-cache") };
const storeStatic     = express.static(path.resolve(process.cwd(), "public-store"), noCacheHeaders);
const panelStatic      = express.static(path.resolve(process.cwd(), "public"), noCacheHeaders);
const wholesaleStatic  = express.static(path.resolve(process.cwd(), "public-wholesale"), noCacheHeaders);

app.use((req, res, next) => {
  const host = req.hostname;
  if (host === "liordark.com" || host === "www.liordark.com") {
    storeStatic(req, res, next);
  } else if (host === "mayorista.liordark.com") {
    wholesaleStatic(req, res, next);
  } else {
    panelStatic(req, res, next);
  }
});

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

  runDisableInactiveWholesalers();
  setInterval(runDisableInactiveWholesalers, ARCHIVE_INTERVAL_MS);

  // Códigos apagado por ahora (el reenvío de Gmail resultó más complicado
  // de lo esperado) — no se arranca el poller ni la limpieza periódica.
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

// Mayoristas sin comprar/recargar en 1 mes — deshabilitados y saldo
// borrado (a pedido explícito). Mismo cadencia que el archivado de arriba.
function runDisableInactiveWholesalers(): void {
  try {
    const disabled = disableInactiveWholesalers();
    if (disabled > 0) console.log(`🗄️  ${disabled} mayorista(s) deshabilitados por inactividad`);
  } catch (err: any) {
    console.error("⚠️ Error deshabilitando mayoristas inactivos:", err?.message);
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
