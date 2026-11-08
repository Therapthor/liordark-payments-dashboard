import crypto from "crypto";
import { Router, type Request, type Response } from "express";
import { env } from "../config/env";
import { listCatalogProducts } from "../db/catalog.repository";
import { listCombos } from "../db/combo.repository";
import { createCustomer, findCustomerByPhone, findCustomerById, isCustomerSuspended } from "../db/customer.repository";
import { isPhoneBlocked } from "../db/security.repository";
import {
  createSaleLink, findSaleLink, listSaleLinks, cancelSaleLink, markSaleLinkOpened,
  saleLinkState, isSaleLinkUsable, SALE_LINK_HOURS, type SaleLinkKind,
} from "../db/sale-links.repository";
import { sqliteDate } from "../db/code-links.repository";
import { plansFor, planFor, money } from "../services/plans.service";
import { hashPassword, createCustomerSessionToken, CUSTOMER_SESSION_COOKIE } from "../services/customer-auth.service";
import { normalizePeruPhone } from "../utils/phone.util";
import { emitDashboardEvent } from "../utils/live-events.util";

// ─────────────────────────────────────────────────────────────
// LINKS DE VENTA (ver sale-links.repository.ts)
//  · Panel (requireAuth): /api/sale-links
//  · Cliente: liordark.com/v/<código> → entra a su cuenta y abre el pedido
// ─────────────────────────────────────────────────────────────

const STORE_BASE = "https://liordark.com";
const MAX_ITEMS = 6;

function last9(phone: string): string {
  return String(phone || "").replace(/\D/g, "").slice(-9);
}

// Mismo descuento que «Arma tu combo» de la tienda (store.routes.ts).
function customComboRate(count: number): number {
  return count >= 3 ? 0.15 : count === 2 ? 0.05 : 0;
}

type Resolved = { kind: SaleLinkKind; platforms: string[]; months: number | null; comboId: number | null; title: string; price: string };

/** Arma el pedido con los precios del catálogo (nunca los que mande el navegador). */
function resolveOrder(body: any): Resolved | { error: string } {
  const comboId = body?.comboId ? Number(body.comboId) : null;
  if (comboId) {
    const combo = listCombos(true).find(c => c.id === comboId);
    if (!combo) return { error: "Ese combo no existe o está apagado." };
    return { kind: "combo", platforms: combo.items.map(i => i.platform), months: null, comboId, title: combo.name, price: combo.price };
  }

  const raw: any[] = Array.isArray(body?.items) ? body.items.slice(0, MAX_ITEMS) : [];
  const catalog = listCatalogProducts(true);
  const seen = new Set<string>();
  const items: { platform: string; title: string; price: number; months: number | null; label: string }[] = [];
  for (const it of raw) {
    const plat = String(it?.platform ?? "").trim().toUpperCase();
    if (!plat || seen.has(plat)) continue;
    const product = catalog.find(p => p.platform.trim().toUpperCase() === plat);
    if (!product) return { error: "Producto no encontrado: " + plat };
    seen.add(plat);
    const plan = plansFor(product.platform) ? planFor(product.platform, it?.months ?? 1) : null;
    if (plansFor(product.platform) && !plan) return { error: "Elige un plan válido para " + product.title + "." };
    items.push({
      platform: product.platform, title: product.title,
      price: plan ? plan.price : parseFloat(product.price),
      months: plan ? plan.months : null, label: plan ? plan.label : "",
    });
  }
  if (!items.length) return { error: "Elige al menos un producto." };

  if (items.length === 1) {
    const it = items[0]!;
    return {
      kind: "platform", platforms: [it.platform], months: it.months, comboId: null,
      title: it.title + (it.label ? " · " + it.label : ""), price: money(it.price),
    };
  }
  // Varios productos → combo armado (en la tienda los planes por meses no
  // entran en combos: se cobra el precio de 1 mes, igual que «Arma tu combo»).
  const catalogPrice = (plat: string) => parseFloat(catalog.find(p => p.platform === plat)!.price);
  const sum = items.reduce((s, it) => s + catalogPrice(it.platform), 0);
  const total = Math.round(sum * (1 - customComboRate(items.length)) * 100) / 100;
  return {
    kind: "custom", platforms: items.map(i => i.platform), months: null, comboId: null,
    title: "Combo: " + items.map(i => i.title).join(" + "), price: money(total),
  };
}

function whatsappMessage(title: string, price: string, url: string): string {
  return `Hola 👋 Te preparé tu pedido 🥭\n\n🛒 ${title} — S/ ${price}\n\n`
    + `Entra aquí, ya tienes tu cuenta creada y solo falta pagar con Yape:\n${url}\n\n`
    + `Apenas pagues, tu cuenta aparece en «Mis cuentas». El link vale ${SALE_LINK_HOURS} horas.`;
}

function publicView(code: string) {
  const link = findSaleLink(code);
  if (!link) return null;
  const state = saleLinkState(link);
  return { link, state };
}

// ═════════ PANEL ═════════

export const saleLinksAdminRoutes = Router();

// Productos y combos para el formulario (con planes por meses).
saleLinksAdminRoutes.get("/options", (_req, res) => {
  res.json({
    products: listCatalogProducts(true).map(p => {
      const plans = plansFor(p.platform);
      return {
        platform: p.platform, title: p.title,
        price: plans ? money(plans[0]!.price) : p.price,
        plans: plans ? plans.map(pl => ({ months: pl.months, label: pl.label, price: money(pl.price) })) : null,
      };
    }),
    combos: listCombos(true).map(c => ({ id: c.id, name: c.name, price: c.price })),
  });
});

// Vista previa del precio (sin crear nada).
saleLinksAdminRoutes.post("/preview", (req, res) => {
  const order = resolveOrder(req.body);
  if ("error" in order) return res.status(400).json({ message: order.error });
  res.json({ title: order.title, price: order.price, kind: order.kind });
});

// ¿Ese celular ya es cliente? (para que el admin confirme a quién se lo manda)
saleLinksAdminRoutes.get("/customer/:phone", (req, res) => {
  const d = last9(String(req.params.phone));
  if (!/^9\d{8}$/.test(d)) return res.json({ valid: false });
  const c = findCustomerByPhone(d);
  res.json({ valid: true, exists: !!c, blocked: isPhoneBlocked(d) });
});

saleLinksAdminRoutes.post("/", async (req, res) => {
  const d = last9(String(req.body?.phone ?? ""));
  if (!/^9\d{8}$/.test(d)) return res.status(400).json({ message: "Escribe un celular de 9 dígitos que empiece con 9." });
  if (isPhoneBlocked(d)) return res.status(403).json({ message: "Ese número está bloqueado (fraude/baneo)." });

  const order = resolveOrder(req.body);
  if ("error" in order) return res.status(400).json({ message: order.error });

  let customer = findCustomerByPhone(d);
  let newCustomer = false;
  let pin = "";
  if (!customer) {
    pin = String(crypto.randomInt(10000)).padStart(4, "0");
    customer = createCustomer(normalizePeruPhone(d), await hashPassword(pin), pin, true);
    newCustomer = true;
    emitDashboardEvent({ type: "customer_registered", phone: customer.phone, isGuest: true });
  }

  const link = createSaleLink({
    customerId: customer.id, phone: customer.phone, kind: order.kind, platforms: order.platforms,
    months: order.months, comboId: order.comboId, title: order.title, price: order.price, newCustomer,
  });
  const url = `${STORE_BASE}/v/${link.code}`;
  const message = whatsappMessage(order.title, order.price, url);
  console.log(`🔗 Link de venta ${link.code} para ${d}: ${order.title} — S/ ${order.price}${newCustomer ? " (cliente nuevo)" : ""}`);
  res.json({
    code: link.code, url, message,
    waUrl: `https://wa.me/51${d}?text=${encodeURIComponent(message)}`,
    newCustomer, pin: newCustomer ? pin : undefined,
    title: order.title, price: order.price,
    expiresAt: sqliteDate(link.expiresAt)?.toISOString() ?? null,
  });
});

saleLinksAdminRoutes.get("/", (_req, res) => {
  res.json({
    links: listSaleLinks(60).map(l => ({
      code: l.code, phone: l.phone, title: l.title, price: l.price, newCustomer: l.newCustomer,
      state: saleLinkState(l), url: `${STORE_BASE}/v/${l.code}`,
      createdAt: l.createdAt, openedAt: l.openedAt, expiresAt: l.expiresAt,
    })),
  });
});

saleLinksAdminRoutes.post("/:code/cancel", (req, res) => {
  cancelSaleLink(String(req.params.code));
  res.json({ ok: true });
});

// ═════════ CLIENTE ═════════

/**
 * liordark.com/v/<código>: si el link sirve, deja al cliente con la sesión
 * de SU cuenta abierta y lo lleva a la tienda con el pedido listo. Si no
 * sirve (vencido, pagado, anulado) igual va a la tienda y ahí se le dice.
 */
export function openSaleLinkPage(req: Request, res: Response): void {
  const code = String(req.path.split("/")[2] ?? "");
  const view = publicView(code);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (view && isSaleLinkUsable(view.state)) {
    const customer = findCustomerById(view.link.customerId);
    if (customer && !isCustomerSuspended(customer) && !isPhoneBlocked(customer.phone)) {
      const { token, expires } = createCustomerSessionToken(customer.id);
      res.cookie(CUSTOMER_SESSION_COOKIE, token, {
        httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "lax", expires,
      });
      markSaleLinkOpened(view.link.code);
    }
  }
  res.redirect(302, "/?venta=" + encodeURIComponent(code));
}

/** Público: solo el estado (para avisar si el link ya no sirve). */
export function saleLinkStatus(code: string): { state: string } {
  const view = publicView(code);
  return { state: view ? view.state : "expired" };
}

/** Con sesión: el pedido, solo si el link es de ESE cliente. */
export function saleLinkForCustomer(code: string, customerId: number) {
  const view = publicView(code);
  if (!view || view.link.customerId !== customerId) return null;
  const { link, state } = view;
  const customer = link.newCustomer ? findCustomerById(customerId) : null;
  return {
    state, kind: link.kind, platforms: link.platforms, months: link.months, comboId: link.comboId,
    title: link.title, price: link.price,
    // Cliente creado por este link: se le muestra su PIN para que pueda
    // volver a entrar después (es SU cuenta; ya está dentro).
    pin: customer && isSaleLinkUsable(state) ? customer.passwordPlain || undefined : undefined,
  };
}
