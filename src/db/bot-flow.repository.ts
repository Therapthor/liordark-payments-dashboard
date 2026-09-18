import { db } from "./db";

export type BotFlowConfig = {
  welcomeGreeting:       string;
  menuPrompt:            string;
  btnTermsTitle:         string;
  btnProductsTitle:      string;
  btnSupportTitle:       string;
  termsText:             string;
  supportMessage:        string;
  contactPhone:          string;
  contactWaLink:         string;
  fallbackUnknownOption: string;
  fallbackUnknownType:   string;
  backMainResponse:      string;
  updatedAt:             string;
};

// Mismos valores por defecto con los que arranca el bot (bot.config.json)
// — así panel y bot empiezan sincronizados hasta que alguien edite algo.
const DEFAULTS = {
  welcomeGreeting: "¡Hola, {name}! 👋 Bienvenido/a a nuestro servicio.\nEstamos aquí para ayudarte.",
  menuPrompt: "¿En qué te puedo ayudar? Elige una opción 👇",
  btnTermsTitle: "📜 Términos y Condiciones",
  btnProductsTitle: "🛒 Productos",
  btnSupportTitle: "📞 Soporte",
  termsText: "📜 *Términos y Condiciones*\n\n*Reembolsos*\nNo hay reembolsos de dinero una vez procesado el pago. En caso de caída de una cuenta, el dinero abonado queda como *saldo a favor* para tu próxima compra.\n\n*Garantía por caída*\nTodas las cuentas tienen garantía y serán reemplazadas en caso de caída. Si hay demora en la reposición, se añaden días extra a tu suscripción para compensar.\n\n*Cambio de cuenta*\nUna vez entregada y activada la cuenta, no se realizan cambios por otro servicio ni se desactiva por cambio de opinión.\n\n_Escribe *menu* para volver al menú principal_ 👆",
  supportMessage: "📞 *Soporte*\n\nSi necesitas ayuda, escríbenos directamente:\n{waLink}\n\nEstamos para ayudarte 🙌",
  contactPhone: "+51 963 081 436",
  contactWaLink: "https://wa.me/51963081436",
  fallbackUnknownOption: "No reconocí esa opción. Intenta de nuevo.",
  fallbackUnknownType: "Por favor, elige una opción del menú 👆",
  backMainResponse: "⬅️ Volviendo al menú principal...",
};

export function seedBotFlowConfigIfEmpty(): void {
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM bot_flow_config`).get() as { count: number };
  if (count > 0) return;
  db.prepare(`
    INSERT INTO bot_flow_config
      (id, welcome_greeting, menu_prompt, btn_terms_title, btn_products_title, btn_support_title,
       terms_text, support_message, contact_phone, contact_wa_link,
       fallback_unknown_option, fallback_unknown_type, back_main_response)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    DEFAULTS.welcomeGreeting, DEFAULTS.menuPrompt, DEFAULTS.btnTermsTitle,
    DEFAULTS.btnProductsTitle, DEFAULTS.btnSupportTitle, DEFAULTS.termsText,
    DEFAULTS.supportMessage, DEFAULTS.contactPhone, DEFAULTS.contactWaLink,
    DEFAULTS.fallbackUnknownOption, DEFAULTS.fallbackUnknownType, DEFAULTS.backMainResponse
  );
}

export function getBotFlowConfig(): BotFlowConfig {
  const row = db.prepare(`SELECT * FROM bot_flow_config WHERE id = 1`).get() as any;
  return {
    welcomeGreeting:       row.welcome_greeting,
    menuPrompt:            row.menu_prompt,
    btnTermsTitle:         row.btn_terms_title,
    btnProductsTitle:      row.btn_products_title,
    btnSupportTitle:       row.btn_support_title,
    termsText:             row.terms_text,
    supportMessage:        row.support_message,
    contactPhone:          row.contact_phone,
    contactWaLink:         row.contact_wa_link,
    fallbackUnknownOption: row.fallback_unknown_option,
    fallbackUnknownType:   row.fallback_unknown_type,
    backMainResponse:      row.back_main_response,
    updatedAt:             row.updated_at,
  };
}

export function updateBotFlowConfig(fields: Omit<BotFlowConfig, "updatedAt">): BotFlowConfig {
  db.prepare(`
    UPDATE bot_flow_config
    SET welcome_greeting = ?, menu_prompt = ?, btn_terms_title = ?, btn_products_title = ?,
        btn_support_title = ?, terms_text = ?, support_message = ?, contact_phone = ?,
        contact_wa_link = ?, fallback_unknown_option = ?, fallback_unknown_type = ?,
        back_main_response = ?, updated_at = datetime('now')
    WHERE id = 1
  `).run(
    fields.welcomeGreeting, fields.menuPrompt, fields.btnTermsTitle, fields.btnProductsTitle,
    fields.btnSupportTitle, fields.termsText, fields.supportMessage, fields.contactPhone,
    fields.contactWaLink, fields.fallbackUnknownOption, fields.fallbackUnknownType,
    fields.backMainResponse
  );
  return getBotFlowConfig();
}
