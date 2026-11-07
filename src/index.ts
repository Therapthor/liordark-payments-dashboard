import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import compression from "compression";
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
import storeRoutes, { generateExpiryNotificationsForAllCustomers } from "./routes/store.routes";
import customersRoutes from "./routes/customers.routes";
import wholesalerAuthRoutes from "./routes/wholesaler-auth.routes";
import wholesalerRoutes, { generateExpiryNotificationsForAllWholesalers } from "./routes/wholesaler.routes";
import wholesalersAdminRoutes from "./routes/wholesalers-admin.routes";
import supportChatRoutes from "./routes/support-chat.routes";
import courseRoutes from "./routes/course.routes";
import courseAdminRoutes from "./routes/course-admin.routes";
import { codeViewerAdminRoutes, codeLinkRoutes } from "./routes/code-viewer.routes";
import { cleanOldCodeLinks } from "./db/code-links.repository";
import { pinLinkAdminRoutes, pinLinkRoutes } from "./routes/pin-link.routes";
import { cleanPinLinks } from "./db/pin-links.repository";
import { mergeDuplicateCustomers } from "./db/customer.repository";
import { runPinRecovery } from "./services/pin-recovery.service";
import { syncPlanCatalogPrices, cleanOldPlanOrders } from "./services/plans.service";
import { applyPendingPasswordRotation } from "./services/auth.service";
import { scanPastChatMessages } from "./services/security.service";
import { cleanOldPendingPurchases } from "./services/course.service";
import { requireWholesalerSession } from "./services/wholesaler-auth.service";
import { seedCatalogIfEmpty } from "./db/catalog.repository";
import { seedPaymentMethodsIfEmpty } from "./db/payment-method.repository";
import { seedBotFlowConfigIfEmpty } from "./db/bot-flow.repository";
import { getPlatformCatalog } from "./services/catalog.service";
import { archiveExpiredAccounts } from "./db/access-history.repository";
import { limaTodayISO, runRenewalCutover } from "./services/access.service";
import { disableInactiveWholesalers } from "./db/wholesaler.repository";
import { runExpiryReminderEmails } from "./jobs/expiry-reminder-email.job";
import { runExpireChatMedia } from "./jobs/expiry-chat-media.job";
import { runSupportBotSweep } from "./services/support-bot.service";

const app = express();

// Comprime (gzip) todo lo que sale — JS/CSS/HTML/JSON pesan ~4 veces menos.
// Nunca los streams en vivo (SSE): comprimirlos los retiene en el buffer y
// dejarían de llegar al instante.
app.use(compression({
  filter: (req, res) => {
    if (String(req.headers.accept ?? "").includes("text/event-stream") || req.path.endsWith("/stream")) return false;
    return compression.filter(req, res);
  },
}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

const apiRouter = express.Router();
// Ninguna respuesta de la API se cachea en el navegador — sin esto, un GET
// (ej. /store/account/email, /store/auth/me) puede quedar servido desde
// el caché HTTP local tras un reinicio del servidor o entre pestañas,
// mostrando datos viejos (ej. "todavía no tienes correo") aunque el valor
// real en la base ya haya cambiado hace rato.
apiRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
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
apiRouter.use("/customers", requireAuth, pinLinkAdminRoutes);
apiRouter.use("/customers", requireAuth, customersRoutes);
// ─── Mayorista (mayorista.liordark.com) — login propio, separado tanto
// del de clientitos como del de admin.
apiRouter.use("/wholesaler/auth", wholesalerAuthRoutes);
apiRouter.use("/wholesaler", requireWholesalerSession, wholesalerRoutes);
// Gestión de mayoristas desde el panel admin (crear cuentas, ajustar
// saldo, asignar stock, cola de cuentas completas) — requireAuth normal.
apiRouter.use("/wholesalers", requireAuth, wholesalersAdminRoutes);
apiRouter.use("/support-chat", requireAuth, supportChatRoutes);
// Curso (liordark.com/curso) — alumno con su sesión de cliente; admin aparte.
apiRouter.use("/course", courseRoutes);
apiRouter.use("/course-admin", requireAuth, courseAdminRoutes);
// Visor de códigos: panel (admin) y link temporal del cliente (sin sesión).
apiRouter.use("/code-viewer", requireAuth, codeViewerAdminRoutes);
apiRouter.use("/code-link", codeLinkRoutes);
apiRouter.use("/pin-link", pinLinkRoutes);
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
// HTML/JS/CSS: "no-cache" (el navegador confirma con el servidor si cambió,
// así cada deploy se ve al toque). Imágenes y fuentes casi nunca cambian:
// se guardan 7 días en el navegador y no se vuelven a pedir en cada visita.
const LONG_CACHE_EXT = /\.(png|jpe?g|webp|gif|svg|ico|woff2?|ttf)$/i;
const noCacheHeaders = {
  setHeaders: (res: any, filePath: string) =>
    res.setHeader("Cache-Control", LONG_CACHE_EXT.test(filePath) ? "public, max-age=604800" : "no-cache"),
};
const storeStatic     = express.static(path.resolve(process.cwd(), "public-store"), noCacheHeaders);
const PANEL_CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' https: data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");
const panelStatic      = express.static(path.resolve(process.cwd(), "public"), noCacheHeaders);
const wholesaleStatic  = express.static(path.resolve(process.cwd(), "public-wholesale"), noCacheHeaders);

// liordark.com/codigo/<token> — página del link temporal de códigos.
const CODE_LINK_PAGE = path.resolve(process.cwd(), "public-store/codigo.html");
app.get(/^\/codigo\/[A-Za-z0-9]{6,20}\/?$/, (req, res, next) => {
  const host = req.hostname;
  if (host === "mayorista.liordark.com") return next();
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(CODE_LINK_PAGE);
});

// liordark.com/cambiar-pin/<token> — el cliente cambia su PIN.
const PIN_LINK_PAGE = path.resolve(process.cwd(), "public-store/cambiar-pin.html");
app.get(/^\/cambiar-pin\/[A-Za-z0-9]{6,20}\/?$/, (req, res, next) => {
  if (req.hostname === "mayorista.liordark.com") return next();
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(PIN_LINK_PAGE);
});

app.use((req, res, next) => {
  const host = req.hostname;
  if (host === "liordark.com" || host === "www.liordark.com") {
    storeStatic(req, res, next);
  } else if (host === "mayorista.liordark.com") {
    wholesaleStatic(req, res, next);
  } else {
    // Panel admin: el navegador solo ejecuta nuestros propios scripts — si
    // algún texto de un cliente se colara como HTML, igual no puede correr
    // código (onmouseover, <script>…) ni mandar datos a otro sitio.
    res.setHeader("Content-Security-Policy", PANEL_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "same-origin");
    panelStatic(req, res, next);
  }
});

const server = app.listen(env.PORT, () => {
  console.log(`🚀 Panel corriendo en http://localhost:${env.PORT}`);
  try { mergeDuplicateCustomers(); } catch (err: any) { console.error("⚠️ fusión de clientes:", err?.message); }
  try { applyPendingPasswordRotation(); } catch (err: any) { console.error("⚠️ cambio de contraseña:", err?.message); }
  try {
    const n = scanPastChatMessages();
    if (n) console.log(`🚨 ${n} ataque(s) del chat procesados (PIN cambiado y sesiones cerradas)`);
  } catch (err: any) { console.error("⚠️ revisión de chats:", err?.message); }
  // PIN de cuentas viejas sin contraseña visible (en segundo plano).
  setTimeout(() => { runPinRecovery().catch(() => {}); }, 60_000);
  setInterval(() => { runPinRecovery().catch(() => {}); }, ARCHIVE_INTERVAL_MS);
  startSync();

  getPlatformCatalog()
    .then(seedCatalogIfEmpty)
    .catch((err: any) => console.error("⚠️ No se pudo sembrar el catálogo del panel:", err?.message));
  try { syncPlanCatalogPrices(); } catch (err: any) { console.error("⚠️ precios de planes:", err?.message); }
  seedPaymentMethodsIfEmpty();
  seedBotFlowConfigIfEmpty();

  runArchiveExpiredAccounts();
  setInterval(runArchiveExpiredAccounts, ARCHIVE_INTERVAL_MS);

  // Curso: pedidos que nunca se pagaron (más de 1 día) se borran.
  const cleanCourse = () => { try { cleanOldPendingPurchases(); cleanOldCodeLinks(); cleanPinLinks(); cleanOldPlanOrders(); } catch { /* no crítico */ } };
  cleanCourse();
  setInterval(cleanCourse, ARCHIVE_INTERVAL_MS);

  runDisableInactiveWholesalers();
  setInterval(runDisableInactiveWholesalers, ARCHIVE_INTERVAL_MS);

  runGenerateExpiryNotifications();
  setInterval(runGenerateExpiryNotifications, EXPIRY_NOTIFY_INTERVAL_MS);

  scheduleEmailRemindersDaily();
  scheduleRenewalCutoverDaily();

  runExpireChatMediaJob();
  setInterval(runExpireChatMediaJob, CHAT_MEDIA_EXPIRY_INTERVAL_MS);

  // Asistente del chat: cierra solo por inactividad (5 min) o al vencer el 2FA.
  setInterval(runSupportBotSweepJob, SUPPORT_BOT_SWEEP_INTERVAL_MS);

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

// Mayoristas sin comprar/recargar en 1 mes — deshabilitados (el saldo se guarda)
// borrado (a pedido explícito). Mismo cadencia que el archivado de arriba.
function runDisableInactiveWholesalers(): void {
  try {
    const disabled = disableInactiveWholesalers();
    if (disabled > 0) console.log(`🗄️  ${disabled} mayorista(s) deshabilitados por inactividad`);
  } catch (err: any) {
    console.error("⚠️ Error deshabilitando mayoristas inactivos:", err?.message);
  }
}

// Campanita de "cuenta por vencer" (clientes y mayoristas) — antes solo se
// generaba de forma perezosa cuando cada uno entraba a pedir sus propias
// notificaciones, así que quien no visitaba la web nunca se enteraba. Corre
// cada 30 min (y al arrancar, para ponerse al día con lo que quedó pendiente).
const EXPIRY_NOTIFY_INTERVAL_MS = 30 * 60 * 1000;

function runGenerateExpiryNotifications(): void {
  try {
    generateExpiryNotificationsForAllCustomers();
    generateExpiryNotificationsForAllWholesalers();
  } catch (err: any) {
    console.error("⚠️ Error generando notificaciones de vencimiento:", err?.message);
  }
}

// Recordatorio de vencimiento por CORREO (3 días y 1 día antes, ver
// expiry-reminder-email.job.ts) — a propósito UNA vez al día, a las 8am
// hora de Lima (no al arrancar ni cada tanto como los demás jobs): que
// siempre le llegue al cliente a una hora decente, nunca de madrugada.
const EMAIL_REMINDER_HOUR_LIMA   = 8;
const EMAIL_REMINDER_MINUTE_LIMA = 0;
const LIMA_OFFSET_HOURS = 5; // UTC-5 fijo, sin horario de verano (mismo criterio que limaTodayISO)
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function msUntilNextLimaTime(hour: number, minute: number): number {
  const nowMs = Date.now();
  const limaNowMs = nowMs - LIMA_OFFSET_HOURS * 60 * 60 * 1000;
  const limaNow = new Date(limaNowMs);
  let targetMs = Date.UTC(limaNow.getUTCFullYear(), limaNow.getUTCMonth(), limaNow.getUTCDate(), hour, minute, 0, 0);
  if (targetMs <= limaNowMs) targetMs += ONE_DAY_MS;
  return targetMs - limaNowMs;
}

function runEmailReminders(): void {
  runExpiryReminderEmails().catch((err: any) => {
    console.error("⚠️ Error mandando recordatorios de vencimiento por correo:", err?.message);
  });
}

function scheduleEmailRemindersDaily(): void {
  const delay = msUntilNextLimaTime(EMAIL_REMINDER_HOUR_LIMA, EMAIL_REMINDER_MINUTE_LIMA);
  console.log(`📧 Recordatorios de vencimiento por correo: próxima corrida en ${Math.round(delay / 60000)} min (8am Lima)`);
  setTimeout(() => {
    runEmailReminders();
    setInterval(runEmailReminders, ONE_DAY_MS);
  }, delay);
}

// Corte automático de ciclo de renovación (ver runRenewalCutover en
// access.service.ts) — 1 vez al día, 10pm Lima. A esa hora ya se sabe
// quién marcó que renueva ese día, y deja la cuenta lista (extendida o
// con los cupos liberados) antes de que el admin tenga que ir a renovar
// con su propio proveedor a la mañana siguiente.
const RENEWAL_CUTOVER_HOUR_LIMA   = 22;
const RENEWAL_CUTOVER_MINUTE_LIMA = 0;

function runRenewalCutoverJob(): void {
  try {
    const result = runRenewalCutover();
    if (result.cleaned.length > 0 || result.relocated > 0 || result.pendingNew > 0 || result.assignedPending > 0) {
      console.log(
        `🔁 Corte de renovación: ${result.cleaned.length} cuenta(s) con perfiles sin renovar liberados, ` +
        `${result.relocated} cliente(s) movidos, ${result.pendingNew} a pendientes, ${result.assignedPending} pendientes asignados`
      );
    }
  } catch (err: any) {
    console.error("⚠️ Error en el corte automático de renovación:", err?.message);
  }
}

function scheduleRenewalCutoverDaily(): void {
  const delay = msUntilNextLimaTime(RENEWAL_CUTOVER_HOUR_LIMA, RENEWAL_CUTOVER_MINUTE_LIMA);
  console.log(`🔁 Corte de renovación: próxima corrida en ${Math.round(delay / 60000)} min (10pm Lima)`);
  setTimeout(() => {
    runRenewalCutoverJob();
    setInterval(runRenewalCutoverJob, ONE_DAY_MS);
  }, delay);
}

// Fotos/videos del chat de soporte autodestruidos al día — cada 15 min
// alcanza de sobra (no hace falta borrarlos al segundo exacto).
const CHAT_MEDIA_EXPIRY_INTERVAL_MS = 15 * 60 * 1000;

const SUPPORT_BOT_SWEEP_INTERVAL_MS = 10 * 1000;

let supportBotSweepRunning = false;
function runSupportBotSweepJob(): void {
  if (supportBotSweepRunning) return;
  supportBotSweepRunning = true;
  runSupportBotSweep()
    .catch((err: any) => console.error("⚠️ Error en el barrido del asistente del chat:", err?.message))
    .finally(() => { supportBotSweepRunning = false; });
}

function runExpireChatMediaJob(): void {
  runExpireChatMedia().catch((err: any) => {
    console.error("⚠️ Error autodestruyendo medios del chat de soporte:", err?.message);
  });
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
