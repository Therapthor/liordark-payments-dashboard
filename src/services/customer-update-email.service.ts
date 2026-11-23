import { db } from "../db/db";
import { findCustomerByPhone, type Customer } from "../db/customer.repository";
import { getCatalogProductByPlatform } from "../db/catalog.repository";
import { sendEmail } from "./email.service";
import { mangoEmail, infoBox, infoRows, para, note, esc, STORE_URL } from "./mango-email";

// ─────────────────────────────────────────────────────────────
// CORREOS AL CLIENTE (diseño Mango Pro, ver mango-email.ts) — solo a quien
// tiene correo registrado:
//   · compra: sus datos de acceso con el PIN del perfil (una compra con
//     varias cuentas, como un combo, llega en un solo correo);
//   · cambios: reemplazo, contraseña nueva, PIN nuevo, avances del soporte;
//   · bienvenida al crear la cuenta y enlace para restablecer el PIN.
// ─────────────────────────────────────────────────────────────

export type UpdateEmailType = "account_replaced" | "password_changed" | "support_update" | "support_resolved";

function platformTitle(platform: string): string {
  return getCatalogProductByPlatform(platform)?.title || platform.trim();
}

function ddmmyyyy(iso: string | null | undefined): string {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

function maskPhone(phone: string): string {
  const d = String(phone || "").replace(/\D/g, "").slice(-9);
  return d.length < 6 ? "" : `${d.slice(0, 3)} *** ${d.slice(-3)}`;
}

function isPinMessage(message: string): boolean {
  return /^🔐/.test(message.trim());
}

// ── Cambios de la cuenta y soporte ──

export function updateEmailSubject(type: UpdateEmailType, platform: string, message: string): string {
  const name = platformTitle(platform);
  if (type === "account_replaced") return `🔁 Tu nueva cuenta de ${name} ya está lista`;
  if (type === "password_changed") return `🔑 Nueva contraseña para tu cuenta de ${name}`;
  if (type === "support_resolved") return `✅ Tu soporte de ${name} está listo`;
  return isPinMessage(message) ? `🔐 PIN nuevo en tu perfil de ${name}` : `🛠️ Novedades de tu soporte de ${name}`;
}

function heading(type: UpdateEmailType, message: string): { kicker: string; title: string; intro: string } {
  if (type === "account_replaced") return { kicker: "Cambio de cuenta", title: "Te dimos una cuenta nueva", intro: "Estos son tus nuevos datos de acceso. Tu fecha de vencimiento no cambia." };
  if (type === "password_changed") return { kicker: "Contraseña nueva", title: "Tu cuenta tiene contraseña nueva", intro: "Usa estos datos la próxima vez que ingreses." };
  if (type === "support_resolved") return { kicker: "Soporte", title: "Tu reporte quedó atendido", intro: "Esto es lo que hicimos con tu cuenta:" };
  return isPinMessage(message)
    ? { kicker: "PIN nuevo", title: "Tu perfil tiene PIN nuevo", intro: "Lo necesitarás para entrar a tu perfil." }
    : { kicker: "Soporte", title: "Novedades de tu reporte", intro: "Así va tu soporte:" };
}

/** «📧 Correo: x» → fila de datos; el resto, párrafos. */
function messageBody(message: string): string {
  const rows: { label: string; value: string; mono?: boolean }[] = [];
  const texts: string[] = [];
  for (const line of message.split("\n").map(l => l.trim()).filter(Boolean)) {
    const m = line.match(/^(\S{1,3}\s)?([A-Za-zÁÉÍÓÚáéíóúñÑ ]{3,22}):\s+(.+)$/);
    if (m) rows.push({ label: m[2]!.trim(), value: m[3]!.trim(), mono: /pin/i.test(m[2]!) });
    else texts.push(line);
  }
  // «…PIN nuevo: 4821» / «…contraseña nueva: abc» al final de una frase → fila aparte.
  const tail = texts.length === 1 && !rows.length ? texts[0]!.match(/^(.*?(PIN nuevo|contraseña nueva)):\s*(\S+)$/i) : null;
  if (tail) {
    return para(esc(tail[1]!) + ".") + infoBox(infoRows([{ label: /pin/i.test(tail[2]!) ? "PIN" : "Contraseña", value: tail[3]!, mono: true }]));
  }
  return texts.map(t => para(esc(t))).join("") + (rows.length ? infoBox(infoRows(rows)) : "");
}

export function updateEmailHtml(type: UpdateEmailType, platform: string, message: string): string {
  const h = heading(type, message);
  return mangoEmail({
    preheader: `${h.title} · ${platformTitle(platform)}`,
    kicker: `${h.kicker} · ${platformTitle(platform)}`,
    title: h.title,
    intro: h.intro,
    body: messageBody(message),
    cta: { label: "Ver mis cuentas", url: STORE_URL },
  });
}

/** Manda el correo si el cliente tiene uno guardado. Nunca lanza error. */
export async function emailCustomerUpdate(clientPhone: string, type: UpdateEmailType, platform: string, message: string): Promise<void> {
  try {
    const customer = findCustomerByPhone(clientPhone);
    const to = customer?.email?.trim();
    if (!to || !message.trim()) return;
    await sendEmail(to, updateEmailSubject(type, platform, message), updateEmailHtml(type, platform, message));
  } catch (err: any) {
    console.error("⚠️ correo de novedades al cliente:", err?.message);
  }
}

// ── Compra: datos de acceso con el PIN del perfil ──

export type DeliveredAccount = {
  platform: string; email: string; password: string; profileName: string; pin: string; expiresAt: string | null;
};

function deliveredAccount(phone: string, platform: string, accountEmail: string): DeliveredAccount | null {
  const d9 = String(phone || "").replace(/\D/g, "").slice(-9);
  const r = db.prepare(`
    SELECT a.platform AS platform, a.email AS email, a.password AS password, a.has_profiles AS hp, a.pin_mode AS pinMode,
           p.profile_name AS profileName, p.pin AS pin, COALESCE(p.expires_override, a.expires_at) AS expiresAt
    FROM access_profiles p JOIN access_accounts a ON a.id = p.account_id
    WHERE substr(p.client_phone, -9) = ? AND upper(a.platform) = upper(?) AND lower(a.email) = lower(?)
    ORDER BY p.updated_at DESC, p.id DESC LIMIT 1
  `).get(d9, platform, accountEmail) as any;
  if (!r) return null;
  return {
    platform: r.platform, email: r.email, password: r.password,
    profileName: r.hp ? (r.profileName || "") : "",
    pin: r.pinMode && r.pin ? String(r.pin) : "",
    expiresAt: r.expiresAt ?? null,
  };
}

export function purchaseEmail(accounts: DeliveredAccount[]): { subject: string; html: string } {
  const many = accounts.length > 1;
  const names = accounts.map(a => platformTitle(a.platform));
  const subject = many ? `🎉 ¡Tus cuentas están listas! (${names.join(", ")})` : `🎉 ¡Tu cuenta de ${names[0]} está lista!`;
  const boxes = accounts.map(a => infoBox(infoRows([
    { label: "Correo", value: a.email },
    { label: "Contraseña", value: a.password },
    { label: "Perfil", value: a.profileName },
    { label: "PIN del perfil", value: a.pin, mono: true },
  ]), { title: platformTitle(a.platform), tag: a.expiresAt ? `Vence ${ddmmyyyy(a.expiresAt)}` : "" })).join("");
  const html = mangoEmail({
    preheader: `Tus datos de acceso de ${names.join(", ")}`,
    kicker: "Compra confirmada",
    title: many ? "¡Tus cuentas están listas! 🎉" : "¡Tu cuenta está lista! 🎉",
    intro: "Gracias por tu compra. Estos son tus datos de acceso; también los tienes siempre en «Mis cuentas».",
    body: boxes +
      (accounts.some(a => a.pin) ? note("🔐 El <b>PIN del perfil</b> es para entrar a tu perfil. No lo compartas con nadie.") : "") +
      note("💡 Usa solo tu perfil y no cambies la contraseña de la cuenta. Si algo no funciona, repórtalo en <b>Soporte</b> dentro de la tienda y lo resolvemos."),
    cta: { label: "Ver mis cuentas", url: STORE_URL },
  });
  return { subject, html };
}

// Una compra con varias cuentas (combo) avisa varias veces seguidas: se
// juntan las que llegan en pocos segundos y sale un solo correo.
const pendingPurchases = new Map<string, { phone: string; items: { platform: string; email: string }[]; timer: NodeJS.Timeout }>();
const PURCHASE_BATCH_MS = 4000;

export function queuePurchaseEmail(phone: string, platform: string, accountEmail: string): void {
  const key = String(phone || "").replace(/\D/g, "").slice(-9);
  if (!key) return;
  const entry = pendingPurchases.get(key);
  if (entry) {
    entry.items.push({ platform, email: accountEmail });
    return;
  }
  const timer = setTimeout(() => flushPurchase(key), PURCHASE_BATCH_MS);
  pendingPurchases.set(key, { phone, items: [{ platform, email: accountEmail }], timer });
}

async function flushPurchase(key: string): Promise<void> {
  const entry = pendingPurchases.get(key);
  pendingPurchases.delete(key);
  if (!entry) return;
  try {
    const customer = findCustomerByPhone(entry.phone);
    const to = customer?.email?.trim();
    if (!to) return;
    const seen = new Set<string>();
    const accounts = entry.items
      .filter(i => { const k = i.platform.toUpperCase() + "|" + i.email.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .map(i => deliveredAccount(entry.phone, i.platform, i.email))
      .filter((a): a is DeliveredAccount => !!a);
    if (!accounts.length) return;
    const { subject, html } = purchaseEmail(accounts);
    await sendEmail(to, subject, html);
  } catch (err: any) {
    console.error("⚠️ correo de compra:", err?.message);
  }
}

// ── Bienvenida y restablecer PIN ──

export function welcomeEmail(customer: Pick<Customer, "phone" | "email">): { subject: string; html: string } {
  return {
    subject: "🥭 ¡Bienvenido a Manguitope! Tu cuenta está lista",
    html: mangoEmail({
      preheader: "Ya puedes comprar, renovar y ver tus cuentas cuando quieras.",
      kicker: "Bienvenido",
      title: "¡Tu cuenta en Manguitope está lista!",
      intro: "Desde la tienda compras, renuevas y ves tus cuentas cuando quieras, y a este correo te llegan tus datos de acceso y los avisos.",
      body: infoBox(infoRows([
        { label: "Entras con", value: `Tu celular ${maskPhone(customer.phone)} o este correo` },
        { label: "Y tu PIN", value: "El que creaste (no lo compartas)" },
      ])) +
        note("¿Olvidaste tu PIN? En la tienda toca <b>«¿Olvidaste tu PIN?»</b> y te llega aquí un enlace para crear uno nuevo."),
      cta: { label: "Ir a la tienda", url: STORE_URL },
    }),
  };
}

export async function sendWelcomeEmail(customer: Pick<Customer, "phone" | "email">): Promise<void> {
  try {
    if (!customer.email) return;
    const { subject, html } = welcomeEmail(customer);
    await sendEmail(customer.email, subject, html);
  } catch (err: any) {
    console.error("⚠️ correo de bienvenida:", err?.message);
  }
}

export function pinResetEmail(url: string, minutes: number): { subject: string; html: string } {
  return {
    subject: "🔑 Crea tu PIN nuevo de Manguitope",
    html: mangoEmail({
      preheader: `Tu enlace para crear un PIN nuevo (vale ${minutes} minutos).`,
      kicker: "Restablecer PIN",
      title: "Crea tu PIN nuevo",
      intro: "Recibimos un pedido para cambiar el PIN de tu cuenta. Toca el botón y elige uno nuevo de 4 números.",
      body: note(`⏱️ El enlace vale <b>${minutes} minutos</b> y sirve <b>una sola vez</b>.`),
      cta: { label: "Crear mi PIN nuevo", url },
      footnote: "¿No lo pediste? Ignora este correo: tu PIN actual sigue igual y nadie puede cambiarlo sin este enlace.",
    }),
  };
}
