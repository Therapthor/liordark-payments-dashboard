import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { db } from "../db/db";
import {
  createKey, findKey, getKey, keyIdentity, listKeys, normalizeKey, rotateKey, setKeyLabel, setKeyStatus, touchKeyLogin,
  type AiKey,
} from "../db/manguito-keys.repository";
import { createAiPurchase, markAiPurchasePaid, wallet, countConversations } from "../db/manguito.repository";
import { applyWholesalerCreditChange, hasRecentLedgerEntry } from "../db/wholesaler-credit.repository";
import { requireCustomerSession, type RequestWithCustomer } from "./customer-auth.service";
import { findCustomerById } from "../db/customer.repository";
import { storeConfig, isAiConfigured, WHOLESALE_DISCOUNT, planStatus } from "./manguito.service";

// ─────────────────────────────────────────────────────────────
// MANGUITO PRO — keys de mayoristas.
// · El mayorista compra una key con su saldo (precio mayorista del plan
//   mensual: S/ 5 menos) y se la da a su cliente. Cada key = 30 días del
//   plan mensual, con sus mismos límites (3 horas, semana, mes).
// · El cliente entra en liordark.com/manguito/ con la key: queda una sesión
//   (cookie firmada con la key). Si el mayorista cambia la key, esa sesión
//   deja de valer y el cliente pone la nueva; su historial sigue igual.
// · Dada de baja: no entra; sus conversaciones quedan guardadas.
// ─────────────────────────────────────────────────────────────

export const KEY_COOKIE = "mg_key_session";
const KEY_SESSION_DAYS = 180;

export type AiUser = { id: number; phone: string; keyId: number | null };

function sign(k: AiKey): string {
  return crypto.createHmac("sha256", env.SESSION_SECRET).update(`mgkey.${k.id}.${k.key}`).digest("hex");
}

type KeySession = { ok: true; key: AiKey } | { ok: false; code: "key_off" | "key_changed"; message: string } | null;

/** Lee la cookie de key: la key vigente, o por qué ya no vale (null si no hay). */
export function keySessionOf(token: unknown): KeySession {
  const [idStr, sig] = String(token ?? "").split(".");
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0 || !sig) return null;
  const k = getKey(id);
  if (!k) return null;
  const expected = sign(k);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, code: "key_changed", message: "Tu key cambió. Ingresa la nueva key que te dio tu proveedor." };
  }
  if (k.status !== "active") return { ok: false, code: "key_off", message: "Tu acceso fue dado de baja. Pídele una key nueva a quien te dio Manguito Pro." };
  return { ok: true, key: k };
}

function setKeyCookie(res: Response, k: AiKey): void {
  res.cookie(KEY_COOKIE, `${k.id}.${sign(k)}`, {
    httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "lax", path: "/",
    maxAge: KEY_SESSION_DAYS * 24 * 3600e3,
  });
}
export function clearKeyCookie(res: Response): void {
  res.clearCookie(KEY_COOKIE, { path: "/" });
}

/** Entrar con una key (liordark.com/manguito/). */
export function loginWithKey(raw: unknown, res: Response): { ok: true } | { ok: false; status: number; message: string } {
  const k = findKey(normalizeKey(raw));
  if (!k) return { ok: false, status: 401, message: "Esa key no existe. Revísala (son 12 letras y números) o pídela otra vez." };
  if (k.status !== "active") return { ok: false, status: 403, message: "Esta key fue dada de baja. Pídele una nueva a quien te dio Manguito Pro." };
  touchKeyLogin(k.id);
  setKeyCookie(res, k);
  return { ok: true };
}

/** /api/store/ai: entra quien tiene una key válida o una sesión de la tienda.
 *  Si hay key, manda la key (el cliente la puso a propósito en este equipo). */
export function requireAiUser(req: Request, res: Response, next: NextFunction): void {
  const ks = keySessionOf(req.cookies?.[KEY_COOKIE]);
  if (ks && ks.ok) {
    (req as any).aiUser = { id: keyIdentity(ks.key.id), phone: "", keyId: ks.key.id } satisfies AiUser;
    next();
    return;
  }
  if (ks && !ks.ok) {
    clearKeyCookie(res);
    // Si además tiene cuenta en la tienda, sigue con esa.
    if (!req.cookies?.ldp_customer_session) { res.status(401).json({ code: ks.code, message: ks.message }); return; }
  }
  requireCustomerSession(req, res, () => {
    const c = findCustomerById((req as RequestWithCustomer).customerId);
    (req as any).aiUser = { id: c!.id, phone: c!.phone, keyId: null } satisfies AiUser;
    next();
  });
}

// ── Para el mayorista ──

/** Precio de una key: el plan mensual con el descuento de mayorista. */
export function keyOffer(): { available: boolean; priceSoles: number; usd: number; days: number } {
  const s = storeConfig();
  return {
    available: isAiConfigured() && s.monthly.enabled,
    priceSoles: Math.max(1, Math.round((s.monthly.priceSoles - WHOLESALE_DISCOUNT) * 100) / 100),
    usd: s.monthly.usd,
    days: 30,
  };
}

class KeyError extends Error { constructor(public status: number, message: string) { super(message); } }

/** Cobra la key del saldo y le suma 30 días del plan (todo o nada). */
function chargeAndGrant(wholesalerId: number, k: AiKey, ref: string): number {
  const offer = keyOffer();
  if (!offer.available) throw new KeyError(409, "Manguito Pro no está disponible en este momento.");
  const cents = Math.round(offer.priceSoles * 100);
  const d = applyWholesalerCreditChange(wholesalerId, -cents, "manguito_key", ref, "system");
  if (!d.ok) throw new KeyError(402, d.error === "Saldo insuficiente." ? `Saldo insuficiente: la key cuesta S/ ${offer.priceSoles.toFixed(2)}. Recarga créditos.` : d.error);
  const orderName = `key-${k.id}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  createAiPurchase({ customerId: keyIdentity(k.id), orderName, kind: "plan", amountSoles: offer.priceSoles.toFixed(2), usd: offer.usd });
  markAiPurchasePaid(orderName);
  return d.newBalanceCents;
}

type KeyResult = { ok: true; key: ReturnType<typeof keyView>; balanceCents?: number } | { ok: false; status: number; message: string };

function run(fn: () => KeyResult): KeyResult {
  try { return fn(); }
  catch (err) {
    if (err instanceof KeyError) return { ok: false, status: err.status, message: err.message };
    throw err;
  }
}

const cleanLabel = (v: unknown) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);

export function buyKey(wholesalerId: number, label: unknown): KeyResult {
  if (hasRecentLedgerEntry(wholesalerId, "manguito_key", `mgkey:new:${wholesalerId}:`, 4)) {
    return { ok: false, status: 429, message: "Espera un momento: ya se está creando una key." };
  }
  return run(() => db.transaction(() => {
    const k = createKey(wholesalerId, cleanLabel(label));
    const balanceCents = chargeAndGrant(wholesalerId, k, `mgkey:new:${wholesalerId}:${k.id}`);
    return { ok: true as const, key: keyView(getKey(k.id)!), balanceCents };
  })());
}

function ownKey(wholesalerId: number, id: number): AiKey {
  const k = getKey(id);
  if (!k || k.wholesalerId !== wholesalerId) throw new KeyError(404, "Esa key no existe.");
  return k;
}

export function renewKey(wholesalerId: number, id: number): KeyResult {
  return run(() => db.transaction(() => {
    const k = ownKey(wholesalerId, id);
    if (hasRecentLedgerEntry(wholesalerId, "manguito_key", `mgkey:renew:${k.id}:`, 4)) throw new KeyError(429, "Ya se renovó hace un momento.");
    const balanceCents = chargeAndGrant(wholesalerId, k, `mgkey:renew:${k.id}:${Date.now()}`);
    if (k.status !== "active") setKeyStatus(k.id, "active");
    return { ok: true as const, key: keyView(getKey(k.id)!), balanceCents };
  })());
}

export function changeKey(wholesalerId: number, id: number): KeyResult {
  return run(() => { ownKey(wholesalerId, id); return { ok: true, key: keyView(rotateKey(id)!) }; });
}

export function setKeyActive(wholesalerId: number, id: number, active: boolean): KeyResult {
  return run(() => { ownKey(wholesalerId, id); setKeyStatus(id, active ? "active" : "off"); return { ok: true, key: keyView(getKey(id)!) }; });
}

export function renameKey(wholesalerId: number, id: number, label: unknown): KeyResult {
  return run(() => { ownKey(wholesalerId, id); setKeyLabel(id, cleanLabel(label)); return { ok: true, key: keyView(getKey(id)!) }; });
}

/** Lo que ve el mayorista de cada key (incluye la key para dársela a su cliente). */
export function keyView(k: AiKey) {
  const who = keyIdentity(k.id);
  const w = wallet(who);
  const plan = planStatus(who, w);
  return {
    id: k.id, key: k.key, label: k.label, status: k.status, planEnd: w.planEnd || 0,
    usedPct: plan && plan.cycle.limit > 0 ? Math.min(100, Math.round(plan.cycle.used / plan.cycle.limit * 100)) : 0,
    conversations: countConversations(who), lastLoginAt: k.lastLoginAt, createdAt: k.createdAt,
  };
}

export function wholesalerKeys(wholesalerId: number) {
  return listKeys(wholesalerId).map(keyView);
}
