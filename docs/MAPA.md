# Mapa del repo — dónde está cada cosa

Para ubicarse rápido sin recorrer el repo. Se citan **nombres** de funciones y secciones (`// ── Sección ──`), no números de línea: búscalos con grep. Si mueves o creas algo importante, actualiza este mapa en el mismo commit.

## 1. Buscador rápido: «quiero cambiar…»

| Quiero cambiar… | Pantalla (front) | Servidor | Datos |
|---|---|---|---|
| Manguito Pro: claves de API, topes, celulares | `public/js/manguito-admin.js` (Configuración › 🥭 Manguito Pro, `#config-section-manguito`) | `routes/manguito-admin.routes.ts` → `services/manguito.service.ts` («Claves de API», `editCredential`) | `admin_settings` |
| Manguito Pro: avisos a Soportes (sin saldo, clave rechazada, errores) | Soportes | `manguito.service.ts` → `incident()`, `reportKeyProblem`, `noteChatError` | `support_tickets` (kind `system`, sin duplicar: `createSystemIncident`) |
| Manguito Pro: chat, modelos, compactar, memoria | `public-store/js/manguito.js`, `manguito-md.js`, `manguito-files.js` | `routes/manguito.routes.ts` (`/api/store/ai`) → `manguito.service.ts` (`runChat`, «Selector de modelo», «Compactación», «Memoria») | `ai_conversations`, `ai_messages`, `ai_usage`, `ai_uploads` |
| Manguito Pro: planes, créditos, compra Yape, campanita | `manguito.js` («planes y compra», «saldo») | `manguito.service.ts` («Compra», `pickSource`, `sendWalletNotices`) | `ai_wallets`, `ai_purchases` |
| Manguito Pro: keys de mayoristas / login con key | `public-wholesale/js/app.js` (MANGUITO PRO) | `services/manguito-keys.service.ts`, `routes/wholesaler.routes.ts` (`/manguito/*`) | `ai_keys` |
| Manguito Pro: compartir chat | `public-store/js/manguito-share.js`, `manguito/compartido.html` | `services/manguito-share.service.ts`, `routes/manguito-public.routes.ts` | `ai_shares` |
| Cuentas y perfiles de streaming | `public/js/access.js` (Accesos) | `routes/access.routes.ts` → `services/access.service.ts` | `access_accounts`, `access_profiles` |
| Renovaciones / cerebro de cuentas | `public/js/brain.js`, `full-renewals.js` (Pagos › Renovaciones) | `services/brain.service.ts` (`runBrain`, `brainOverview`), `access.service.ts` (`runRenewalCutover`) | `brain_runs`, `brain_sales`, `renewal_history_log` |
| Avisos / SMS de vencimiento | `public/js/app.js` (Renovaciones › Avisos) | `routes/renewals.routes.ts`, `services/sms*.ts`, `jobs/expiry-reminder-email.job.ts` | `reminder_runs`, `sms_reminder_*` |
| Códigos (bandeja, pedidos, actividad) | `public/js/codes.js`, `codes-inbox.js`, `code-viewer.js` | `access.routes.ts` (`/codes/*`), `services/codes-lookup.service.ts`, `codes-brain.service.ts`, `code-requests.service.ts`, `codes-lanes.ts` | `account_codes`, `code_requests`, `code_links` |
| Buzones de correo (Gmail/Outlook) | `public/js/mail-admin.js` (Configuración › Correos) | `routes/mail-connections.routes.ts` → `services/mail-connections.service.ts`, `services/codes/gmail-codes.service.ts` | — |
| Soportes (tickets de clientes/mayoristas) | `public/js/soportes.js` | `routes/support-reports.routes.ts` → `services/support-reports.service.ts` | `support_tickets` |
| Bot de soporte en el chat (sin IA) | — | `services/support-bot.service.ts` (`runSupportBotSweep` cada 10 s) | `support_chats`, `support_chat_messages` |
| Mayoristas (admin) | `public/js/wholesalers.js` | `routes/wholesalers-admin.routes.ts` | `wholesalers`, `wholesaler_credit_ledger`, `wholesale_full_account_orders` |
| Panel del mayorista | `public-wholesale/js/app.js` | `routes/wholesaler.routes.ts`, `wholesaler-auth.routes.ts` | `wholesaler_*` |
| Tienda: catálogo, combo, checkout, Mis cuentas | `public-store/js/app.js` (secciones CATÁLOGO, ARMA TU COMBO, CHECKOUT…) | `routes/store.routes.ts` | `catalog_products`, `catalog_combos`, `store_web_orders` |
| Catálogo y combos (admin) / PDF | `public/js/catalog.js` | `routes/catalog.routes.ts`, `services/catalog-pdf.service.ts`, `product-media.service.ts` | `catalog_*` |
| Renovar desde link (SMS/correo) | `public-store/renovar.html` + `js/renovar.js` | `store.routes.ts` (`/renew/*`, `/renew-code/*`) | `renewal_pay_links`, `sms_renewal_links` |
| Clientes, bloqueos, seguridad | `public/js/web-customers.js`, `security.js`, `passkey.js` | `routes/customers.routes.ts`, `auth.routes.ts`, `services/security.service.ts` | `customers`, tablas de `security.repository.ts` |
| Links de venta `/v/<código>` | `public/js/sale-links.js` | `routes/sale-links.routes.ts` | `sale_links` |
| Curso | `public/js/course-admin.js`; `public-store/curso/*`, `js/curso*.js`, `aprender.js` | `routes/course*.routes.ts` → `services/course.service.ts` | `course_*` (creadas en `db.ts`) |
| Avisos con imagen (tienda/mayorista) | `public/js/avisos-admin.js`; `public-store/js/avisos.js` | `routes/avisos.routes.ts` | `site_avisos` |
| Reseñas | `public/js/reviews-admin.js`; `public-store/js/resenas.js` | `routes/reviews.routes.ts` | `store_reviews`, `store_sections` |
| Métodos de pago / proveedores | `public/js/settings.js` | `routes/payment-method.routes.ts`, `provider.routes.ts` | `payment_methods`, `providers` |
| Copias de seguridad | `public/js/backup.js`; `tools/copias/` → `public/tools/copias.html` | `routes/backup.routes.ts` → `services/backup.service.ts` (03:20 diario) | — |
| Pagos en vivo / historial | `public/js/app.js` (Resumen, Historial) | `routes/live.routes.ts` (SSE), `history.routes.ts`, `stats.routes.ts`, `services/sync.service.ts` | `payments`, `sync_state`, `monthly_totals` |
| Lo que el bot de WhatsApp consulta/vende | — | `routes/stock.routes.ts` (header `x-bot-key`) | varias |

## 2. Servidor (`src/`)

**`src/index.ts`** — todo arranca aquí:
- Monta `apiRouter` en `/api`. Rutas admin con `requireAuth` (`middleware/auth.middleware.ts`: 404 si el host no es el panel, 401 sin sesión).
- Sirve estáticos **por host**: `liordark.com` → `public-store/` (CSP `SITE_CSP`; `/manguito*` con `MANGUITO_CSP`), `mayorista.liordark.com` → `public-wholesale/`, cualquier otro → `public/` (panel, `PANEL_CSP`).
- Páginas por regex antes del estático: `/codigo/<tok>`, `/renovar`, `/v/<tok>`, `/cambiar-pin/<tok>`, `/manguito/s/<tok>`.
- Tareas programadas:

| Cada | Qué corre |
|---|---|
| 10 s | `runSupportBotSweep` |
| 15 min | `runExpireChatMedia` |
| 30 min | campanita de vencimientos (clientes y mayoristas), membresías por vencer |
| 1 h | acceso web, archivar vencidas, limpiezas, `runPinRecovery` |
| 3 h | `manguitoMaintenance` (compactar, avisos de plan/créditos) |
| 03:20 Lima | `runBackup("auto")` |
| 08:00 Lima | correos de vencimiento (3 días y 1 día antes) |
| 22:00 Lima | `runBrain("auto")` + `runRenewalCutover()` |

**Rutas (`src/routes/`, prefijo `/api/...`)**
- Panel admin (`requireAuth`): `access`, `live`, `stats`, `history`, `orders`, `catalog`, `payment-methods`, `providers`, `renewals`, `bot-flow`, `avisos`, `reviews`, `mail`, `backup`, `marketing`, `support`, `customers` (+ `pin-link` admin), `sale-links`, `code-viewer`, `course-admin`, `wholesalers`, `manguito-admin`. `auth` usa su propio guard de host.
- Tienda: `store/auth` (`customer-auth.routes.ts`), `store` (`store.routes.ts`; lo público va antes de `requireCustomerSession`), `store/ai-public` y `store/ai` (Manguito), `course`.
- Mayorista: `wholesaler/auth`, `wholesaler` (exige membresía salvo `OPEN_WITHOUT_MEMBERSHIP`).
- Por token, sin sesión: `code-link`, `pin-link`.
- Bot: `stock` (`x-bot-key` = `DASHBOARD_API_KEY`).

**Servicios clave (`src/services/`)**
- `manguito.service.ts` — secciones: Configuración · Claves de API · Prueba de conexión · Selector de modelo · Historial · Chat (streaming) · Pausa de 1 hora · Compactación · Memoria · Mantenimiento cada 3 horas · Estado del plan · `pickSource` (plan → créditos → gratis) · Medidor · Compra · Panel · **Incidencias automáticas a Soportes** · Avisos al cliente · Mayoristas S/ 5 menos.
- `access.service.ts` (renovar/reemplazar, avisos a suscriptores, corte de ciclo) · `brain.service.ts` (cerebro de renovaciones).
- Códigos: `codes-lookup.service.ts` (el más grande: un bloque por proveedor, reglas de entrega, reintentos), `codes-brain.service.ts` (salud, bandeja, vigilante cada 2 min), `code-requests.service.ts`, `codes-lanes.ts`.
- Soporte: `support-reports.service.ts` (tickets + mensajes WhatsApp), `support-bot.service.ts` (asistente por reglas).
- Correo/SMS: `email.service.ts` (`sendEmail`), `mango-email.ts` (plantilla), `customer-update-email.service.ts`, `sms.service.ts`, `sms-reminder-message.service.ts`, `expiry-reminder-email-message.service.ts`.
- Auth/seguridad: `auth.service.ts` (panel), `customer-auth.service.ts`, `wholesaler-auth.service.ts`, `passkey.service.ts`, `login-lockout.service.ts`, `login-unlock.service.ts`, `security.service.ts`.
- Otros: `sync.service.ts` (pagos del bot, SSE), `backup.service.ts`, `course.service.ts`, `plans.service.ts`, `catalog*.ts`, `product-media.service.ts`, `stats.service.ts`, `one-time-repairs.service.ts`.
- Solo `manguito.service.ts` crea incidencias de sistema en Soportes. La campanita del cliente es `createCustomerNotification(s)`.

**Utilidades (`src/utils/`)**: `live-events` (eventos al panel), `chat-events`, `phone.util` (`normalizePeruPhone`), `rate-limit`, `one-at-a-time`, `renewal-token`, `safe-compare`, `totp`, `email.util`.

## 3. Base de datos (`src/db/`, archivo `data/payments.db`)

- `db.ts`: abre SQLite (WAL), ejecuta `data/tables.sql`, migra con `ensureColumn` (`PRAGMA table_info` + `ALTER TABLE`) y crea con `CREATE TABLE IF NOT EXISTS`: códigos, links, chats de soporte, curso, `brain_*` y `app_migrations`.
- Ajustes clave/valor del panel: `admin_settings` → `getAdminSetting` / `setAdminSetting` en `security.repository.ts`.
- Un repositorio por tema. Tablas que crea el propio repositorio:

| Repositorio | Tablas |
|---|---|
| `manguito.repository.ts` | `ai_conversations`, `ai_messages`, `ai_uploads`, `ai_usage`, `ai_customer_state`, `ai_wallets`, `ai_purchases`, `ai_shares` |
| `manguito-keys.repository.ts` | `ai_keys` |
| `security.repository.ts` | `admin_settings`, `admin_sessions`, `admin_passkeys`, `blocked_phones`, `blocked_ips`, `panel_blocked_ips`, `security_events`, `login_*`, `registration_log` |
| `reviews.repository.ts` | `store_reviews`, `store_sections` |
| `sale-links.repository.ts` | `sale_links`, `sale_link_orders` |
| `store-orders.repository.ts` | `store_web_orders` |
| `avisos.repository.ts` | `site_avisos` |
| `wholesaler-membership.repository.ts` | `wholesaler_membership_orders`, `wholesaler_membership_log` |

  El resto de las tablas está en `data/tables.sql`, y su repositorio lleva el nombre del tema: `access`, `customer`, `payments`, `support-tickets`, `wholesaler*`, `catalog`, `combo`, etc.

## 4. Frontends

**Panel — `public/`** (una página, `index.html`; cada pestaña es `<section id="view-X">`, cambio con `switchView` en `app.js`, marco visual en `mango.js`)
- Resumen `#view-live` · Pagos › Historial `#view-history` · Pagos › Renovaciones `#view-renewals` · Accesos `#view-access` · Códigos `#view-codes` · Mayoristas `#view-wholesalers` · Clientes `#view-web-customers` · Curso `#view-course` · Soportes `#view-soportes` · Configuración `#view-config`.
- Configuración (`#config-section-*`): `catalog`, `payment-methods`, `providers`, `avisos`, `reviews`, `mail`, `marketing`, `manguito`, `security`, `backup`.
- Cada `js/*.js` es un IIFE sin compilación con su propio `api()`. Estilos: `css/mango.css` (tema actual) y `css/style.css` (base).

**Tienda — `public-store/`**
- `index.html` (tienda) → `js/app.js` (secciones en mayúsculas: CATÁLOGO, ARMA TU COMBO, CHECKOUT, INIT…).
- Otras páginas: `codigo.html` (código del cliente), `renovar.html`, `cambiar-pin.html`, `curso/`, `manguito/` (chat) y `manguito/compartido.html`.
- `js/cat.js` (el gatito) está repetido en las 3 carpetas: si lo cambias, cámbialo en todas.

**Mayorista — `public-wholesale/`**: una SPA en `js/app.js`, con secciones GATE, MANGUITO PRO, CLIENTES, CÓDIGOS, CUENTAS, CRÉDITOS, COMPRAR, RECORDATORIOS y SOPORTE.

## 5. Publicación e infraestructura
- `.github/workflows/deploy.yml` («Deploy al VPS»): con cada push a `main` entra por SSH al VPS y corre `git pull`, `npm install`, `npm run build` y `pm2 restart`.
- `deploy/nginx-panel.conf`: solo el panel, con proxy al Node en el puerto 4000. No fija `client_max_body_size`, así que el límite es 1 MB; por eso las subidas van en partes.
- Scripts: `npm run dev`, `npm run build` (`tsc`) y `npm start`. No hay tests ni lint; antes de publicar, verificar con `npx tsc --noEmit`.
- Variables de entorno: solo los nombres, en `.env.example` y `src/config/env.ts`.
