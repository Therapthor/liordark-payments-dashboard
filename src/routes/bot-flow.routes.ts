import { Router } from "express";
import {
  getBotFlowConfig,
  updateBotFlowConfig,
  type BotFlowConfig,
} from "../db/bot-flow.repository";

const router = Router();

function parseBody(body: any): Omit<BotFlowConfig, "updatedAt"> {
  return {
    welcomeGreeting:       String(body?.welcomeGreeting ?? "").trim(),
    menuPrompt:            String(body?.menuPrompt ?? "").trim(),
    btnTermsTitle:         String(body?.btnTermsTitle ?? "").trim(),
    btnProductsTitle:      String(body?.btnProductsTitle ?? "").trim(),
    btnSupportTitle:       String(body?.btnSupportTitle ?? "").trim(),
    termsText:             String(body?.termsText ?? "").trim(),
    supportMessage:        String(body?.supportMessage ?? "").trim(),
    contactPhone:          String(body?.contactPhone ?? "").trim(),
    contactWaLink:         String(body?.contactWaLink ?? "").trim(),
    fallbackUnknownOption: String(body?.fallbackUnknownOption ?? "").trim(),
    fallbackUnknownType:   String(body?.fallbackUnknownType ?? "").trim(),
    backMainResponse:      String(body?.backMainResponse ?? "").trim(),
  };
}

router.get("/", (_req, res) => {
  res.json({ config: getBotFlowConfig() });
});

router.put("/", (req, res) => {
  const data = parseBody(req.body);
  const missing = Object.entries(data).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    res.status(400).json({ message: "Faltan campos: " + missing.join(", ") });
    return;
  }
  res.json({ config: updateBotFlowConfig(data) });
});

export default router;
