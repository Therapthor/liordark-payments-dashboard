import { Router } from "express";
import { env } from "../config/env";
import { listCatalogProducts } from "../db/catalog.repository";
import {
  listPlatforms,
  sellProfile,
  releaseProfilesByPhone,
  findAccountByClientPhone,
  listExpiringClients,
  getProfileById,
  getAccountById,
} from "../db/access.repository";
import { renewAccount, accountStatus, daysLeft } from "../services/access.service";

// ─────────────────────────────────────────────────────────────
// API DE STOCK — consumida por el bot de WhatsApp/Telegram, NO por el
// navegador. Autenticada con x-bot-key (misma llave compartida que ya
// usa /api/integrations), no con la sesión de login del panel.
//
// Reemplaza, endpoint por endpoint, lo que el bot hoy hace contra Google
// Sheets (LISTA_PRODUCTOS + hojas de plataforma). Mientras el bot no
// llame a esto, no cambia nada de lo que ya funciona.
// ─────────────────────────────────────────────────────────────

const router = Router();

router.use((req, res, next) => {
  const key = req.header("x-bot-key");
  if (!key || key !== env.DASHBOARD_API_KEY) {
    res.status(401).json({ message: "No autorizado" });
    return;
  }
  next();
});

// GET /catalog — plataformas activas con precio/imagen/descr. y disponibilidad real.
router.get("/catalog", (_req, res) => {
  const products = listCatalogProducts(true);
  const summaries = listPlatforms();

  const catalog = products.map(p => {
    const summary = summaries.find(s => s.platform === p.platform.trim().toUpperCase());
    const available = summary ? summary.sellableCount : 0;
    return {
      platform:    p.platform,
      price:       p.price,
      title:       p.title,
      description: p.description,
      imageUrl:    p.imageUrl,
      hasProfiles: p.hasProfiles,
      keywords:    p.keywords.split(",").map(k => k.trim().toLowerCase()).filter(Boolean),
      available,
    };
  });

  res.json({ catalog });
});

// POST /sell — { platform, clientPhone, orderRef? } → vende el perfil libre más próximo a vencer.
router.post("/sell", (req, res) => {
  const { platform, clientPhone, orderRef } = req.body ?? {};
  if (!platform?.trim() || !clientPhone?.trim()) {
    res.status(400).json({ message: "Faltan platform o clientPhone." });
    return;
  }

  const sold = sellProfile(platform, clientPhone, typeof orderRef === "string" ? orderRef : "");
  if (!sold) {
    res.status(409).json({ success: false, message: "Sin stock disponible en esa plataforma." });
    return;
  }

  res.status(201).json({
    success: true,
    account: {
      profileId:   sold.profileId,
      platform:    sold.platform,
      email:       sold.email,
      password:    sold.password,
      profileName: sold.profileName,
      expiresAt:   sold.expiresAt,
    },
  });
});

// GET /profile/:id — reconsulta un perfil ya vendido (para reenviar credenciales
// si algo falló entre la venta y que el cliente las recibiera por WhatsApp).
router.get("/profile/:id", (req, res) => {
  const profile = getProfileById(Number(req.params.id));
  if (!profile) { res.status(404).json({ message: "Perfil no encontrado." }); return; }

  const account = getAccountById(profile.accountId);
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }

  res.json({
    profileId:   profile.id,
    platform:    account.platform,
    email:       account.email,
    password:    account.password,
    profileName: profile.profileName,
    clientPhone: profile.clientPhone,
    expiresAt:   account.expiresAt,
  });
});

// POST /release — { platform, clientPhone } → libera perfil(es) (orden cancelada).
router.post("/release", (req, res) => {
  const { platform, clientPhone } = req.body ?? {};
  if (!platform?.trim() || !clientPhone?.trim()) {
    res.status(400).json({ message: "Faltan platform o clientPhone." });
    return;
  }
  const released = releaseProfilesByPhone(platform, clientPhone);
  res.json({ released });
});

// POST /renew — { platform, clientPhone } → renueva +30 días la cuenta completa del cliente.
router.post("/renew", (req, res) => {
  const { platform, clientPhone } = req.body ?? {};
  if (!platform?.trim() || !clientPhone?.trim()) {
    res.status(400).json({ message: "Faltan platform o clientPhone." });
    return;
  }

  const account = findAccountByClientPhone(platform, clientPhone);
  if (!account) {
    res.status(404).json({ success: false, message: "No se encontró cuenta de ese cliente en esa plataforma." });
    return;
  }

  const renewed = renewAccount(account.id);
  res.json({ success: true, expiresAt: renewed?.expiresAt ?? null });
});

// GET /expiring?days=3 — clientes cuya cuenta vence en los próximos N días.
router.get("/expiring", (req, res) => {
  const days = Number(req.query.days ?? 3);
  const clients = listExpiringClients(Number.isFinite(days) ? days : 3).map(c => ({
    ...c,
    status:   accountStatus(c.expiresAt),
    daysLeft: daysLeft(c.expiresAt),
  }));
  res.json({ clients });
});

export default router;
