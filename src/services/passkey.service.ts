import crypto from "crypto";
import type { Request, Response } from "express";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON, type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { env } from "../config/env";
import {
  getAdminSetting, setAdminSetting, listPasskeys, getPasskey, addPasskey, touchPasskey,
} from "../db/security.repository";

// ─────────────────────────────────────────────────────────────
// LLAVES DE ACCESO DEL PANEL (passkeys: Face ID / huella / llavero de
// iCloud). El teléfono guarda la llave privada y solo firma un reto; el
// panel guarda la llave pública. No hay contraseña que adivinar ni robar.
//
// El reto de cada intento viaja en una cookie firmada (5 min, un solo
// uso), así no se guarda nada en memoria que un atacante pueda llenar.
// ─────────────────────────────────────────────────────────────

const RP_NAME = "Liordark Panel";
const MAX_PASSKEYS = 10;
const CHALLENGE_TTL_MS = 5 * 60_000;
const CHALLENGE_COOKIE = "ldp_pk_chal";
const COOKIE_SECRET = crypto.randomBytes(32);
const usedChallenges = new Map<string, number>();

type Kind = "register" | "login";

function sign(text: string): string {
  return crypto.createHmac("sha256", COOKIE_SECRET).update(text).digest("hex");
}

function setChallengeCookie(res: Response, kind: Kind, challenge: string): void {
  const expires = Date.now() + CHALLENGE_TTL_MS;
  const body = `${kind}.${challenge}.${expires}`;
  res.cookie(CHALLENGE_COOKIE, `${body}.${sign(body)}`, {
    httpOnly: true,
    secure:   env.NODE_ENV === "production",
    sameSite: "strict",
    path:     "/api/auth",
    maxAge:   CHALLENGE_TTL_MS,
  });
}

/** Reto guardado en la cookie, si es válido, del tipo pedido y no usado. */
function takeChallenge(req: Request, res: Response, kind: Kind): string | null {
  res.clearCookie(CHALLENGE_COOKIE, { path: "/api/auth" });
  const raw = String(req.cookies?.[CHALLENGE_COOKIE] ?? "");
  const m = /^(register|login)\.([A-Za-z0-9_-]{16,128})\.(\d{10,16})\.([0-9a-f]{64})$/.exec(raw);
  if (!m || m[1] !== kind) return null;
  const body = `${m[1]}.${m[2]}.${m[3]}`;
  const a = Buffer.from(m[4]!, "hex");
  const b = Buffer.from(sign(body), "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const now = Date.now();
  if (Number(m[3]) < now) return null;
  for (const [k, exp] of usedChallenges) if (exp < now) usedChallenges.delete(k);
  if (usedChallenges.has(m[2]!)) return null;
  return m[2]!;
}

function markUsed(challenge: string): void {
  usedChallenges.set(challenge, Date.now() + CHALLENGE_TTL_MS);
}

function userId(): Uint8Array<ArrayBuffer> {
  let id = getAdminSetting("passkey_user_id");
  if (!id) { id = crypto.randomBytes(16).toString("base64url"); setAdminSetting("passkey_user_id", id); }
  return new Uint8Array(Buffer.from(id, "base64url"));
}

const transportsOf = (t: string[]) => t as AuthenticatorTransportFuture[];

export function passkeyCount(): number {
  return listPasskeys().length;
}

/**
 * ENTRADA SOLO CON LLAVE (pedido del dueño): con al menos una llave de
 * acceso registrada, la contraseña ya no abre el panel. Sin llaves, la
 * contraseña sigue funcionando: el dueño nunca queda afuera. Emergencia:
 * PANEL_PASSWORD_LOGIN=on en el servidor la vuelve a habilitar.
 */
export function passkeyOnlyStatus(): { active: boolean; passkeys: number; override: boolean } {
  const passkeys = passkeyCount();
  const override = env.PANEL_PASSWORD_LOGIN;
  return { active: passkeys > 0 && !override, passkeys, override };
}

// ── Registrar una llave (con sesión abierta) ──

export async function registrationOptions(res: Response) {
  const existing = listPasskeys();
  if (existing.length >= MAX_PASSKEYS) throw new Error(`Máximo ${MAX_PASSKEYS} llaves. Borra una para agregar otra.`);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: env.PANEL_RP_ID,
    userName: "admin",
    userDisplayName: "Administrador Liordark",
    userID: userId(),
    attestationType: "none",
    excludeCredentials: existing.map(p => ({ id: p.id, transports: transportsOf(p.transports) })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  setChallengeCookie(res, "register", options.challenge);
  return options;
}

export async function registerPasskey(req: Request, res: Response, response: RegistrationResponseJSON, name: string): Promise<void> {
  const challenge = takeChallenge(req, res, "register");
  if (!challenge) throw new Error("Se venció el tiempo. Vuelve a intentarlo.");
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: env.PANEL_ORIGIN,
    expectedRPID: env.PANEL_RP_ID,
    requireUserVerification: true,
  });
  if (!v.verified) throw new Error("No se pudo verificar la llave.");
  markUsed(challenge);
  const { credential } = v.registrationInfo;
  if (getPasskey(credential.id)) throw new Error("Esa llave ya está registrada.");
  addPasskey({
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: credential.transports ?? response.response?.transports ?? [],
    name: String(name || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 60) || "Llave de acceso",
  });
}

// ── Entrar con una llave (sin sesión) ──

export async function loginOptions(res: Response) {
  const keys = listPasskeys();
  if (!keys.length) throw new Error("Aún no hay llaves de acceso registradas.");
  const options = await generateAuthenticationOptions({
    rpID: env.PANEL_RP_ID,
    userVerification: "required",
    allowCredentials: keys.map(p => ({ id: p.id, transports: transportsOf(p.transports) })),
  });
  setChallengeCookie(res, "login", options.challenge);
  return options;
}

/** Devuelve el nombre de la llave usada si la firma es válida. */
export async function verifyPasskeyLogin(req: Request, res: Response, response: AuthenticationResponseJSON): Promise<string | null> {
  const challenge = takeChallenge(req, res, "login");
  if (!challenge) return null;
  const pk = typeof response?.id === "string" ? getPasskey(response.id) : null;
  if (!pk) return null;
  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: env.PANEL_ORIGIN,
      expectedRPID: env.PANEL_RP_ID,
      credential: {
        id: pk.id,
        publicKey: new Uint8Array(Buffer.from(pk.publicKey, "base64url")),
        counter: pk.counter,
        transports: transportsOf(pk.transports),
      },
      requireUserVerification: true,
    });
    if (!v.verified) return null;
    markUsed(challenge);
    touchPasskey(pk.id, v.authenticationInfo.newCounter);
    return pk.name;
  } catch {
    return null;
  }
}
