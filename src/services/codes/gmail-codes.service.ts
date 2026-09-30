import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { env } from "../../config/env";
import { findCodesEnabledAccountByEmailInText, saveIncomingCode } from "../../db/codes.repository";

// ─────────────────────────────────────────────────────────────
// CÓDIGOS POR GMAIL — lee una bandeja Gmail DEDICADA (solo para esto,
// nunca la cuenta personal de nadie) donde llegan, por reenvío, los
// correos de código de las cuentas marcadas "🔑 Código" en Accesos.
//
// Sin CODES_GMAIL_USER/CODES_GMAIL_APP_PASSWORD configurados, este
// poller queda inactivo — no rompe nada del resto del panel.
//
// Cómo atribuye el código a una cuenta: busca, dentro del asunto+cuerpo
// del correo, el email de alguna cuenta marcada — así no depende de que
// el remitente diga explícito a quién pertenece. Si no encuentra
// ninguna coincidencia, el correo se deja SIN LEER (por si en verdad
// era para una cuenta que no está marcada, y hay que revisarlo a mano).
// ─────────────────────────────────────────────────────────────

// Ajustar si Netflix/ChatGPT/etc. no vienen en 4-8 dígitos — pensado para
// cubrir el código de acceso de Netflix (4) y el de verificación de
// OpenAI/ChatGPT (6), que son los casos de prueba iniciales.
const CODE_REGEX = /\b(\d{4,8})\b/;

let isPolling = false;

export async function pollGmailForCodes(): Promise<void> {
  if (!env.CODES_GMAIL_USER || !env.CODES_GMAIL_APP_PASSWORD) return;
  if (isPolling) return; // evita solapar corridas si una tarda más que el intervalo
  isPolling = true;

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: env.CODES_GMAIL_USER, pass: env.CODES_GMAIL_APP_PASSWORD },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
        if (!msg.source) continue;

        const parsed = await simpleParser(msg.source);
        const text = [parsed.subject ?? "", parsed.text ?? ""].join("\n");

        const account = findCodesEnabledAccountByEmailInText(text);
        const codeMatch = text.match(CODE_REGEX);

        if (account && codeMatch) {
          saveIncomingCode({
            accountId: account.id,
            code:      codeMatch[1]!,
            snippet:   (parsed.subject ?? "").slice(0, 200),
            source:    "gmail",
          });
          await client.messageFlagsAdd(msg.uid, ["\\Seen"], { uid: true });
        }
        // Si no matchea ninguna cuenta o no se encontró código, se deja
        // sin leer a propósito — para poder revisarlo a mano en Gmail.
      }
    } finally {
      lock.release();
    }
  } catch (err: any) {
    console.error("❌ Códigos: error revisando Gmail:", err?.message);
  } finally {
    await client.logout().catch(() => {});
    isPolling = false;
  }
}

export function startGmailCodesPoller(intervalMs = 2 * 60 * 1000): void {
  if (!env.CODES_GMAIL_USER || !env.CODES_GMAIL_APP_PASSWORD) {
    console.log("ℹ️  Códigos: CODES_GMAIL_USER/CODES_GMAIL_APP_PASSWORD no configurados — poller de Gmail inactivo.");
    return;
  }
  console.log("📬 Códigos: poller de Gmail activo cada " + Math.round(intervalMs / 1000) + "s");
  pollGmailForCodes();
  setInterval(pollGmailForCodes, intervalMs);
}
