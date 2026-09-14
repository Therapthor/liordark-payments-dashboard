# Liordark — Panel de Pagos

Panel en vivo de pagos Yape, contabilidad diaria/mensual e historial editable.

## Arquitectura

- **Backend** (Express + TypeScript + SQLite): se conecta al stream en vivo
  (`GET /api/dashboard/stream`) de `proyecto-cuentas-bot-backend` para recibir
  cada pago Yape apenas se registra, y hace un backfill periódico como red de
  seguridad. Guarda todo permanentemente en su propia base de datos — el bot
  borra pagos de más de 7 días, así que este panel es el archivo histórico real.
- **Frontend**: HTML/CSS/JS planos (sin build), Chart.js por CDN. Servido
  directo por el mismo Express — un solo proceso, un solo despliegue.

## Configurar

```bash
cp .env.example .env.production   # o .env.development
```

Completa:
- `BOT_BASE_URL` — URL pública del bot (ej. `https://backend-api.liordark.com`)
- `DASHBOARD_API_KEY` — debe ser **idéntica** a `DASHBOARD_API_KEY` en el `.env` del bot
- `DASHBOARD_PASSWORD` — contraseña para entrar al panel
- `SESSION_SECRET` — cualquier cadena larga y aleatoria

## Desarrollo

```bash
npm install
npm run dev
```

## Producción

```bash
npm install
npm run build
npm start
```

O con PM2 (recomendado, igual que el bot principal):
```bash
pm2 start dist/index.js --name liordark-payments-dashboard
```

Si el build falla por memoria en un VPS chico, usar:
```bash
NODE_OPTIONS=--max-old-space-size=1536 npm run build
```

## Notas de diseño

- El "Días susc." de la contabilidad = suma de los pagos Yape confirmados por
  día/mes (ingresos brutos), en horario Lima (UTC-5 fijo).
- Los registros manuales del historial solo se permiten para días **sin**
  datos automáticos (backfill de días anteriores al panel) — si el día ya
  tiene pagos reales, no se puede sobrescribir manualmente.
- El sonido de notificación se genera con la Web Audio API (sin archivo de
  audio) y su estado (silenciado o no) se guarda en `localStorage` del
  navegador — es por dispositivo/pestaña, no global.
