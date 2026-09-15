import { Router } from "express";
import {
  createAccount,
  updateAccount,
  deleteAccount,
  getAccountById,
  listPlatforms,
  listAccountsByPlatform,
  assignProfileClient,
  releaseProfile,
  searchAccountsByEmail,
  searchProfilesByPhone,
  type AccessAccountWithProfiles,
  type ProfileWithAccount,
} from "../db/access.repository";
import { renewProfile, statusOf, daysLeft } from "../services/access.service";

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── serialización — agrega estado/días calculados a cada perfil ──

function withStatus(account: AccessAccountWithProfiles) {
  return {
    ...account,
    profiles: account.profiles.map(p => ({
      ...p,
      status:   statusOf(p),
      daysLeft: daysLeft(p.expiresAt),
    })),
  };
}

function profileWithStatus(p: ProfileWithAccount) {
  return { ...p, status: statusOf(p), daysLeft: daysLeft(p.expiresAt) };
}

// ── PLATAFORMAS ──

router.get("/platforms", (_req, res) => {
  res.json({ platforms: listPlatforms() });
});

router.get("/platforms/:platform/accounts", (req, res) => {
  const accounts = listAccountsByPlatform(req.params.platform);
  res.json({ accounts: accounts.map(withStatus) });
});

// ── CUENTAS ──

router.post("/accounts", (req, res) => {
  const { platform, email, password, notes, slots } = req.body ?? {};

  if (!platform?.trim() || !email?.trim() || !password) {
    res.status(400).json({ message: "Plataforma, correo y contraseña son obligatorios." });
    return;
  }

  const account = createAccount({
    platform, email, password,
    notes: typeof notes === "string" ? notes : "",
    slots: Number(slots) || 5,
  });
  res.status(201).json({ account: withStatus(account) });
});

router.get("/accounts/:id", (req, res) => {
  const account = getAccountById(Number(req.params.id));
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  res.json({ account: withStatus(account) });
});

router.put("/accounts/:id", (req, res) => {
  const { platform, email, password, notes } = req.body ?? {};
  const account = updateAccount(Number(req.params.id), { platform, email, password, notes });
  if (!account) { res.status(404).json({ message: "Cuenta no encontrada." }); return; }
  res.json({ account: withStatus(account) });
});

router.delete("/accounts/:id", (req, res) => {
  deleteAccount(Number(req.params.id));
  res.json({ ok: true });
});

// ── PERFILES ──

router.put("/profiles/:id", (req, res) => {
  const { clientName, clientPhone, expiresAt, profileName } = req.body ?? {};

  if (!clientName?.trim() || !clientPhone?.trim() || !expiresAt) {
    res.status(400).json({ message: "Cliente, teléfono y fecha de vencimiento son obligatorios." });
    return;
  }
  if (!DATE_RE.test(expiresAt)) {
    res.status(400).json({ message: "Fecha inválida, usa YYYY-MM-DD." });
    return;
  }

  const profile = assignProfileClient(Number(req.params.id), { clientName, clientPhone, expiresAt, profileName });
  if (!profile) { res.status(404).json({ message: "Perfil no encontrado." }); return; }
  res.json({ profile: profileWithStatus({ ...profile, platform: "", email: "", password: "" }) });
});

router.post("/profiles/:id/renew", (req, res) => {
  const profile = renewProfile(Number(req.params.id));
  if (!profile) { res.status(404).json({ message: "Perfil no encontrado." }); return; }
  res.json({ profile: profileWithStatus({ ...profile, platform: "", email: "", password: "" }) });
});

router.post("/profiles/:id/release", (req, res) => {
  const profile = releaseProfile(Number(req.params.id));
  if (!profile) { res.status(404).json({ message: "Perfil no encontrado." }); return; }
  res.json({ profile: profileWithStatus({ ...profile, platform: "", email: "", password: "" }) });
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
