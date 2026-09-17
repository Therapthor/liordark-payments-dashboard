import { Router } from "express";
import {
  createAccountsBulk,
  updateAccount,
  deleteAccount,
  getAccountById,
  listPlatforms,
  listAccountsByPlatform,
  assignProfileClient,
  releaseProfile,
  setProfileRenewal,
  searchAccountsByEmail,
  searchProfilesByPhone,
  createAccountFromRenewal,
  type AccessAccountWithProfiles,
  type ProfileWithAccount,
  type RenewalStatus,
} from "../db/access.repository";
import { renewAccount, accountStatus, daysLeft } from "../services/access.service";
import { listCatalogProducts, getCatalogProductByPlatform } from "../db/catalog.repository";
import { listProviders } from "../db/provider.repository";

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── serialización — agrega estado/días calculados a la cuenta ──

function withStatus(account: AccessAccountWithProfiles) {
  return {
    ...account,
    status:   accountStatus(account.expiresAt),
    daysLeft: daysLeft(account.expiresAt),
  };
}

function profileWithStatus(p: ProfileWithAccount) {
  return { ...p, status: accountStatus(p.expiresAt), daysLeft: daysLeft(p.expiresAt) };
}

// ── CATÁLOGO (para el desplegable de plataforma) ──
// Viene del catálogo propio del panel (Configuración > Catálogo), no del
// bot — se edita ahí. Ver src/db/catalog.repository.ts.

router.get("/platforms-catalog", (_req, res) => {
  const platforms = listCatalogProducts(true).map(p => ({ platform: p.platform, hasProfiles: p.hasProfiles }));
  res.json({ platforms });
});

// ── PROVEEDORES (para el desplegable "Proveedor" y el botón 🔑 de soporte) ──
// Viene de Configuración > Proveedores. Ver src/db/provider.repository.ts.

router.get("/providers-catalog", (_req, res) => {
  const providers = listProviders(true).map(p => ({ name: p.name, whatsapp: p.whatsapp }));
  res.json({ providers });
});

// ── PLATAFORMAS (agrupación de cuentas ya cargadas en Accesos) ──

router.get("/platforms", (_req, res) => {
  res.json({ platforms: listPlatforms() });
});

router.get("/platforms/:platform/accounts", (req, res) => {
  const accounts = listAccountsByPlatform(req.params.platform);
  res.json({ accounts: accounts.map(withStatus) });
});

// ── CUENTAS ──

// Alta en formato "correo:contraseña" (una por línea) — todas comparten
// plataforma, proveedor y vencimiento inicial. hasProfiles se resuelve
// del catálogo propio del panel, nunca se confía en lo que mande el cliente.
router.post("/accounts/bulk", async (req, res) => {
  const { platform, provider, expiresAt, lines } = req.body ?? {};

  if (!platform?.trim()) { res.status(400).json({ message: "Elige una plataforma." }); return; }
  if (!expiresAt || !DATE_RE.test(expiresAt)) { res.status(400).json({ message: "Fecha de vencimiento inválida." }); return; }
  if (typeof lines !== "string" || !lines.trim()) { res.status(400).json({ message: "Pega al menos una línea correo:contraseña." }); return; }

  const pairs = lines
    .split("\n")
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0)
    .map((line: string) => {
      const idx = line.indexOf(":");
      if (idx === -1) return null;
      return { email: line.slice(0, idx).trim(), password: line.slice(idx + 1).trim() };
    });

  const invalid = pairs.some((p: any) => !p || !p.email || !p.password);
  if (invalid || pairs.length === 0) {
    res.status(400).json({ message: "Cada línea debe tener el formato correo:contraseña." });
    return;
  }

  const hasProfiles = getCatalogProductByPlatform(platform)?.hasProfiles ?? true;

  const accounts = createAccountsBulk({
    platform, provider: typeof provider === "string" ? provider : "",
    hasProfiles, expiresAt, pairs: pairs as { email: string; password: string }[],
  });

  res.status(201).json({ accounts: accounts.map(withStatus) });
});

router.get("/accounts/:id", (req, res) => {
  const account = getAccountById(Number(req.params.id));
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  res.json({ account: withStatus(account) });
});

router.put("/accounts/:id", (req, res) => {
  const { platform, email, password, provider, expiresAt, link, notes } = req.body ?? {};

  if (expiresAt !== undefined && expiresAt !== null && !DATE_RE.test(expiresAt)) {
    res.status(400).json({ message: "Fecha inválida, usa YYYY-MM-DD." });
    return;
  }

  const account = updateAccount(Number(req.params.id), { platform, email, password, provider, expiresAt, link, notes });
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  res.json({ account: withStatus(account) });
});

router.delete("/accounts/:id", (req, res) => {
  deleteAccount(Number(req.params.id));
  res.json({ ok: true });
});

router.post("/accounts/:id/renew", (req, res) => {
  const account = renewAccount(Number(req.params.id));
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  res.json({ account: withStatus(account) });
});

// Renovación con cuenta nueva — crea una cuenta aparte y le pasa solo los
// clientes marcados "✅ Renueva" de la vieja. No manda WhatsApp ni toca el
// bot, solo mueve datos del panel (ver createAccountFromRenewal).
router.post("/accounts/:id/renew-new", (req, res) => {
  const { email, password, expiresAt } = req.body ?? {};
  if (!email?.trim())    { res.status(400).json({ message: "El correo es obligatorio." }); return; }
  if (!password?.trim()) { res.status(400).json({ message: "La contraseña es obligatoria." }); return; }

  const result = createAccountFromRenewal(Number(req.params.id), {
    email, password, expiresAt: expiresAt?.trim() || null,
  });
  if (!result) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }

  res.json({
    oldAccount: withStatus(result.oldAccount),
    newAccount: withStatus(result.newAccount),
  });
});

// ── PERFILES (solo el teléfono del cliente — el resto vive en la cuenta) ──

router.put("/profiles/:id", (req, res) => {
  const { clientPhone } = req.body ?? {};
  if (!clientPhone?.trim()) { res.status(400).json({ message: "El teléfono es obligatorio." }); return; }

  const profile = assignProfileClient(Number(req.params.id), clientPhone);
  if (!profile) { res.status(404).json({ message: "Perfil no encontrado." }); return; }
  res.json({ profile });
});

router.post("/profiles/:id/release", (req, res) => {
  const profile = releaseProfile(Number(req.params.id));
  if (!profile) { res.status(404).json({ message: "Perfil no encontrado." }); return; }
  res.json({ profile });
});

// Marcador manual — ¿el cliente confirmó que renueva? '' | 'yes' | 'no'.
// Puramente informativo para el admin, no afecta el vencimiento.
router.post("/profiles/:id/renewal", (req, res) => {
  const status = req.body?.status as RenewalStatus;
  if (!["", "yes", "no"].includes(status)) {
    res.status(400).json({ message: "Estado inválido." });
    return;
  }
  const profile = setProfileRenewal(Number(req.params.id), status);
  if (!profile) { res.status(404).json({ message: "Perfil no encontrado." }); return; }
  res.json({ profile });
});

// ── BUSCADOR ──
// ?q= dígitos → busca cliente por teléfono (todas sus cuentas/perfiles)
// ?q= texto   → busca cuenta por correo

router.get("/search", (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) { res.json({ mode: "none", accounts: [], profiles: [] }); return; }

  const looksLikePhone = /^\+?[\d\s-]{6,}$/.test(q);

  if (looksLikePhone) {
    const profiles = searchProfilesByPhone(q).map(profileWithStatus);
    res.json({ mode: "phone", profiles });
    return;
  }

  const accounts = searchAccountsByEmail(q).map(withStatus);
  res.json({ mode: "email", accounts });
});

export default router;
