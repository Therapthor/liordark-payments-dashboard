import fs from "fs";
import path from "path";
import { db } from "../db/db";
import {
  brainPlatforms, isRotatePlatform, isBrainPlatform, isSingleBrainPlatform, limaToday, addDays, invalidateBrainPlatforms,
} from "../db/brain-platforms";
import { createCustomerNotification } from "../db/customer-notifications.repository";
import { createWholesalerNotification } from "../db/wholesaler-notifications.repository";
import { createPendingAssignment } from "../db/pending-assignments.repository";
import { sendEmail } from "./email.service";

// ─────────────────────────────────────────────────────────────
// CEREBRO DE CUENTAS — corre todas las noches a las 10 pm (y a mano desde
// Pagos › Renovaciones). En las plataformas del cerebro (ver
// db/brain-platforms.ts) cada cliente tiene su propia fecha y la cuenta, la
// fecha pagada al proveedor. Cada noche:
//   1. Libera a los clientes cuya fecha ya pasó (perfil con PIN → pide PIN
//      nuevo; sin PIN → «cambiar contraseña», como siempre).
//   2. Para cada cuenta que vence con el proveedor mañana (o ya venció):
//      decide RENOVAR o DEJAR VENCER, usando el mínimo de cuentas donde
//      quepan todos los que siguen (los que ya pagaron) + un margen de stock
//      para ventas nuevas.
//   3. Mueve a los clientes de las cuentas que se dejan vencer a lugares
//      libres de las que siguen (conservan su fecha) y les avisa por la
//      campanita y por correo.
//   4. Calcula si falta stock y cuántas cuentas comprar.
// ChatGPT y CapCut nunca se renuevan (se cambia de correo cada mes): quien
// sigue pasa a una cuenta nueva con los días que le quedan.
// ─────────────────────────────────────────────────────────────

const GRACE_DAYS = 2;            // días que se espera un «Ya la renové» antes de mover a todos
const RESERVE_MIN = 2;           // perfiles libres mínimos por plataforma para ventas nuevas
const PROVIDER_PERIOD_DAYS = 30;
const RECENT_MOVE_DAYS = 25;     // no mover dos veces en el mes a la misma persona si se puede evitar

type Policy = "normal" | "renewOnly" | "rotate";

type Prof = {
  id: number; accountId: number; slot: number; name: string; pin: string; pinPending: boolean;
  clientPhone: string; wholesalerId: number | null; seen: number; orderRef: string;
  date: string | null; planMonths: number | null; movedAt: string | null;
  reminders: { r: string | null; s: string | null; e: string | null; d3: string | null; d1: string | null };
};

type Unit = {
  id: number; platform: string; email: string; password: string; providerDate: string | null;
  hasProfiles: boolean; pinMode: boolean; paused: boolean; action: string; actionFor: string | null;
  profiles: Prof[]; policy: Policy;
};

export type BrainRenew = {
  accountId: number; platform: string; email: string; providerDate: string | null;
  stayers: number; capacity: number; cost: string; overdue: boolean; reason: string;
};
export type BrainMove = {
  platform: string; clientPhone: string; wholesalerId: number | null; date: string | null;
  fromEmail: string; toEmail: string; toAccountId: number; profileName: string;
};
export type BrainStock = {
  platform: string; freeTomorrow: number; reserve: number; missing: number;
  accountsToBuy: number; urgent: boolean; note: string;
};
export type BrainPlan = {
  ranAt: string; today: string; origin: string;
  renew: BrainRenew[]; drop: { accountId: number; platform: string; email: string; providerDate: string | null }[];
  moves: BrainMove[]; expired: { platform: string; count: number }[];
  stock: BrainStock[]; pending: { platform: string; clientPhone: string; date: string | null }[];
  forcedRenew: number;
};

const occupied = (p: Prof) => p.clientPhone !== "" || p.wholesalerId !== null;
// «PIN por cambiar» no bloquea: el admin decide si lo cambia o lo deja igual.
const isFree = (p: Prof) => !occupied(p);

function loadUnits(platform: string): Unit[] {
  const accounts = db.prepare(`
    SELECT id, platform, email, password, expires_at, has_profiles, pin_mode, sale_paused, brain_action, brain_action_for
    FROM access_accounts WHERE platform = ?
  `).all(platform) as any[];
  const profStmt = db.prepare(`
    SELECT p.*, COALESCE(p.expires_override, a.expires_at) AS client_date
    FROM access_profiles p JOIN access_accounts a ON a.id = p.account_id
    WHERE p.account_id = ? ORDER BY p.slot_number ASC
  `);
  const rotate = isRotatePlatform(platform);
  return accounts.map(a => {
    const profiles: Prof[] = (profStmt.all(a.id) as any[]).map(r => ({
      id: r.id, accountId: r.account_id, slot: r.slot_number, name: r.profile_name ?? "", pin: r.pin ?? "",
      pinPending: r.pin_reset_pending === 1, clientPhone: r.client_phone ?? "", wholesalerId: r.wholesaler_id ?? null,
      seen: r.seen_by_wholesaler ?? 1, orderRef: r.order_ref ?? "", date: r.client_date ?? null,
      planMonths: r.plan_months ?? null, movedAt: r.moved_at ?? null,
      reminders: { r: r.reminder_sent_at, s: r.sms_reminder_sent_at, e: r.expiry_notified_at, d3: r.email_reminder_3d_sent_at, d1: r.email_reminder_1d_sent_at },
    }));
    return {
      id: a.id, platform: a.platform, email: a.email, password: a.password, providerDate: a.expires_at ?? null,
      hasProfiles: a.has_profiles === 1, pinMode: a.pin_mode === 1, paused: a.sale_paused === 1, action: a.brain_action ?? "", actionFor: a.brain_action_for ?? null,
      profiles, policy: rotate ? "rotate" : a.has_profiles === 1 ? "normal" : "renewOnly",
    } as Unit;
  });
}

function stayersOf(u: Unit): Prof[] {
  if (!u.providerDate) return [];
  return u.profiles.filter(p => occupied(p) && !!p.date && p.date > u.providerDate!);
}

/** Perfiles libres que conviene tener para ventas nuevas: lo que se vende en
 *  ~2 días (ventas de los últimos 7: aviso de cuenta nueva al cliente o al
 *  mayorista). Plataforma que no se vendió en la semana: sin margen (no se
 *  renueva una cuenta vacía «por si acaso»). */
function reserveFor(platform: string): number {
  const row = db.prepare(`
    SELECT (SELECT COUNT(*) FROM customer_notifications WHERE type = 'new_account' AND UPPER(TRIM(platform)) = @p AND created_at >= datetime('now', '-7 days'))
         + (SELECT COUNT(*) FROM wholesaler_notifications WHERE type = 'purchase_added' AND UPPER(TRIM(platform)) = @p AND created_at >= datetime('now', '-7 days')) AS n
  `).get({ p: platform }) as { n: number };
  if (!row.n) return 0;
  return Math.max(RESERVE_MIN, Math.ceil((row.n / 7) * 2));
}

function providerCost(platform: string): string {
  const row = db.prepare(`SELECT provider_cost AS c FROM catalog_products WHERE UPPER(TRIM(platform)) = ? ORDER BY id LIMIT 1`).get(platform) as { c: string } | undefined;
  return row?.c ?? "";
}

function recentlyMoved(p: Prof, today: string): boolean {
  return !!p.movedAt && p.movedAt.slice(0, 10) >= addDays(today, -RECENT_MOVE_DAYS);
}

// ── Mover a un cliente (conserva su fecha, plan y avisos ya enviados) ──

function moveClient(from: Prof, fromUnit: Unit, to: Prof, toUnit: Unit): void {
  db.transaction(() => {
    db.prepare(`
      UPDATE access_profiles
      SET client_phone = ?, order_ref = ?, renewal_status = '', wholesaler_id = ?, seen_by_wholesaler = ?,
          expires_override = ?, plan_months = ?, moved_at = datetime('now'),
          replaced_from = ?, replaced_at = datetime('now'), replaced_by = 'cerebro',
          reminder_sent_at = ?, sms_reminder_sent_at = ?, expiry_notified_at = ?,
          email_reminder_3d_sent_at = ?, email_reminder_1d_sent_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(from.clientPhone, from.orderRef, from.wholesalerId, from.wholesalerId === null ? 1 : 0,
      from.date, from.planMonths, fromUnit.email + (fromUnit.hasProfiles && from.name ? " · " + from.name : ""), from.reminders.r, from.reminders.s, from.reminders.e, from.reminders.d3, from.reminders.d1, to.id);
    db.prepare(`
      UPDATE access_profiles
      SET client_phone = '', order_ref = '', renewal_status = '', wholesaler_id = NULL, expires_override = NULL,
          plan_months = NULL, moved_at = NULL, reminder_sent_at = NULL, sms_reminder_sent_at = NULL,
          expiry_notified_at = NULL, email_reminder_3d_sent_at = NULL, email_reminder_1d_sent_at = NULL,
          pin_reset_pending = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(fromUnit.pinMode && from.clientPhone ? 1 : 0, from.id);
  })();
  // Estado en memoria para el resto de la corrida.
  Object.assign(to, { clientPhone: from.clientPhone, wholesalerId: from.wholesalerId, date: from.date, planMonths: from.planMonths, orderRef: from.orderRef, movedAt: new Date().toISOString() });
  Object.assign(from, { clientPhone: "", wholesalerId: null, date: null, planMonths: null, orderRef: "", pinPending: fromUnit.pinMode });
  notifyMoved(to, toUnit);
}

function overviewReason(accountId: number, stayers: number, capacity: number, providerDate: string | null): string {
  const annual = planMixOf(accountId, providerDate).filter(p => p.months >= 12).reduce((s, p) => s + p.count, 0);
  const why = capacity <= 1 ? "cuenta individual: el cliente sigue" : annual ? `tiene ${annual} cliente(s) anual(es)` : stayers * 2 > capacity ? "más de la mitad sigue" : "no hay dónde moverlos";
  return `${stayers} cliente(s) siguen después del ${ddmmyyyy(providerDate)} · ${why}`;
}

/** Por qué conviene pagar esta cuenta (lo ve el admin en «Pagos al proveedor»). */
function renewReason(st: Prof[], capacity: number, providerDate: string | null): string {
  const annual = st.filter(p => (p.planMonths ?? 1) >= 12).length;
  const why = capacity <= 1 ? "cuenta individual: el cliente sigue" : annual ? `tiene ${annual} cliente(s) anual(es)` : st.length * 2 > capacity ? "más de la mitad sigue" : "no hay dónde moverlos";
  return `${st.length} cliente(s) siguen después del ${ddmmyyyy(providerDate)} · ${why}`;
}

function ddmmyyyy(d: string | null): string {
  if (!d) return "—";
  const [y, m, dd] = d.split("-");
  return `${dd}/${m}/${y}`;
}

function movedDetail(p: Prof, u: Unit): string {
  return `📧 Correo: ${u.email}\n🔑 Contraseña: ${u.password}` +
    (u.hasProfiles && p.name ? `\n👤 Perfil: ${p.name}` : "") +
    (u.pinMode && p.pin ? `\n🔐 PIN: ${p.pin}` : "") +
    `\n📅 Tu fecha sigue igual: ${ddmmyyyy(p.date)}` +
    `\n\nTe pasamos a otra cuenta para darte un mejor servicio. Tus días se mantienen. 😊`;
}

function notifyMoved(p: Prof, u: Unit): void {
  if (!p.clientPhone && p.wholesalerId === null) return;
  const detail = movedDetail(p, u);
  if (p.wholesalerId !== null) {
    createWholesalerNotification(p.wholesalerId, "account_replaced", u.platform, u.email,
      (p.clientPhone ? `👤 Cliente: ${p.clientPhone}\n` : "") + detail);
    return;
  }
  createCustomerNotification(p.clientPhone, "account_replaced", u.platform, u.email, detail);
  const row = db.prepare(`SELECT email FROM customers WHERE substr(phone, -9) = substr(?, -9) AND email != '' LIMIT 1`).get(p.clientPhone) as { email: string } | undefined;
  if (row?.email) {
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;line-height:1.5">` +
      `<h2 style="margin:0 0 12px">Tu cuenta de ${escapeHtml(u.platform)} fue cambiada ✅</h2>` +
      `<p>Te pasamos a otra cuenta para darte un mejor servicio. <b>Tus días se mantienen.</b></p>` +
      `<p style="background:#f6f3ea;border-radius:10px;padding:12px 14px;white-space:pre-line">${escapeHtml(detail.split("\n\n")[0] ?? "")}</p>` +
      `<p>También lo ves en <a href="https://liordark.com">liordark.com</a> › Mis cuentas.</p></div>`;
    sendEmail(row.email, `Tu cuenta de ${u.platform} fue cambiada`, html).catch(() => {});
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

function freeExpired(p: Prof, u: Unit): void {
  db.prepare(`
    UPDATE access_profiles
    SET client_phone = '', order_ref = '', renewal_status = '', wholesaler_id = NULL, expires_override = NULL,
        plan_months = NULL, moved_at = NULL, reminder_sent_at = NULL, sms_reminder_sent_at = NULL,
        expiry_notified_at = NULL, email_reminder_3d_sent_at = NULL, email_reminder_1d_sent_at = NULL,
        pin_reset_pending = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(u.pinMode && p.clientPhone ? 1 : 0, p.id);
  // Sin PIN, quien se fue sabe la contraseña de una cuenta que sigue en uso
  // (ChatGPT/CapCut se cambian de correo cada mes: ahí no hace falta).
  if (!u.pinMode && u.policy === "normal" && p.clientPhone) {
    db.prepare(`UPDATE access_accounts SET password_change_pending = 1 WHERE id = ?`).run(u.id);
  }
  Object.assign(p, { clientPhone: "", wholesalerId: null, date: null, planMonths: null, orderRef: "", pinPending: u.pinMode && !!p.clientPhone });
}

function setDecision(u: Unit, action: "renew" | "drop" | ""): void {
  db.prepare(`UPDATE access_accounts SET brain_action = ?, brain_action_for = ? WHERE id = ?`)
    .run(action, action ? u.providerDate : null, u.id);
  u.action = action;
  u.actionFor = action ? u.providerDate : null;
}

// ─────────────────────────────────────────────────────────────

export function runBrain(origin: "auto" | "manual" = "auto"): BrainPlan {
  const today = limaToday();
  const tomorrow = addDays(today, 1);
  const graceLimit = addDays(today, -GRACE_DAYS);
  const plan: BrainPlan = {
    ranAt: new Date().toISOString(), today, origin,
    renew: [], drop: [], moves: [], expired: [], stock: [], pending: [], forcedRenew: 0,
  };

  for (const platform of [...brainPlatforms()].sort()) {
    const units = loadUnits(platform);
    if (units.length === 0) continue;

    // 1) Clientes cuya fecha ya pasó → perfil libre.
    let expiredCount = 0;
    for (const u of units) for (const p of u.profiles) {
      // Solo clientes de verdad: el stock reservado a un mayorista sigue a la cuenta.
      if (p.clientPhone && p.date && p.date < today) { freeExpired(p, u); expiredCount++; }
    }
    if (expiredCount) plan.expired.push({ platform, count: expiredCount });

    // Decisiones viejas de otro vencimiento ya no valen (la cuenta se renovó o cambió).
    for (const u of units) if (u.action && u.actionFor !== u.providerDate) setDecision(u, "");

    const reserve = reserveFor(platform);
    const due = (u: Unit) => !!u.providerDate && u.providerDate <= tomorrow;
    const lastDay = (u: Unit) => !!u.providerDate && u.providerDate <= today;
    const beyondGrace = (u: Unit) => !!u.providerDate && u.providerDate < graceLimit;
    const cost = providerCost(platform);
    const renewList = new Set<Unit>();
    const dropList = new Set<Unit>();
    const movers: { p: Prof; u: Unit }[] = [];

    // 2a) Cuentas completas (un solo cliente dueño de toda la cuenta): se renuevan si sigue.
    for (const u of units.filter(x => x.policy === "renewOnly" && due(x))) {
      if (stayersOf(u).length > 0 && !beyondGrace(u)) renewList.add(u); else dropList.add(u);
    }

    // 2b) Perfiles: qué cuentas conviene renovar (pedido del dueño, nov-2026):
    //   · Nunca una cuenta sin clientes que sigan: el stock para ventas
    //     nuevas se compra nuevo (ver «Stock por comprar»), no se renueva.
    //   · Siempre la que tiene clientes ANUALES que siguen, o la que tiene
    //     más de la mitad de sus perfiles con clientes que siguen.
    //   · Las demás (pocos clientes de meses): sus clientes pasan a lugares
    //     libres de otras cuentas; solo si no alcanza el espacio, se renueva
    //     el mínimo (las de más clientes primero).
    if (units.some(x => x.policy === "normal")) {
      const normal = units.filter(x => x.policy === "normal");
      const dueUnits = normal.filter(due);
      const candidates = dueUnits.filter(u => !beyondGrace(u) && stayersOf(u).length > 0);
      const worthIt = (u: Unit) => {
        const st = stayersOf(u);
        return st.some(p => (p.planMonths ?? 1) >= 12) || st.length * 2 > u.profiles.length;
      };
      // Lugares libres hoy en cuentas que no vencen todavía.
      // (Las cuentas con la venta en pausa no reciben a nadie.)
      let avail = normal.filter(u => !due(u) && !u.paused).reduce((s, u) => s + u.profiles.filter(isFree).length, 0);
      const keep = (u: Unit) => { renewList.add(u); if (!u.paused) avail += u.profiles.length - stayersOf(u).length; };
      for (const u of candidates) if (worthIt(u) || u.action === "renew") keep(u);
      const score = (u: Unit) => {
        const st = stayersOf(u);
        return st.length * 10 + st.filter(p => (p.planMonths ?? 1) >= 6).length * 3 + st.filter(p => recentlyMoved(p, today)).length * 5;
      };
      const rest = candidates.filter(u => !renewList.has(u))
        .sort((a, b) => score(b) - score(a) || (b.profiles.length - a.profiles.length) || a.id - b.id);
      const notRenewedNeed = () => dueUnits.filter(u => !renewList.has(u)).reduce((s, u) => s + stayersOf(u).length, 0);
      for (const u of rest) {
        if (notRenewedNeed() <= avail) break;
        keep(u);
      }
      for (const u of dueUnits) if (!renewList.has(u)) dropList.add(u);
      for (const u of [...dropList].filter(x => x.policy === "normal")) for (const p of stayersOf(u)) movers.push({ p, u });
    }

    // 2c) ChatGPT / CapCut: nunca se renuevan, quien sigue pasa a otro correo.
    for (const u of units.filter(x => x.policy === "rotate" && due(x))) {
      dropList.add(u);
      for (const p of stayersOf(u)) movers.push({ p, u });
    }

    // 3) Mover. Primero los de plan largo y los que más días tienen.
    movers.sort((a, b) => (b.p.planMonths ?? 1) - (a.p.planMonths ?? 1) || String(b.p.date).localeCompare(String(a.p.date)));
    const keptUnits = () => units.filter(u => !dropList.has(u) && (renewList.has(u) || !due(u)) && (u.policy !== "renewOnly"));
    for (const { p, u } of movers) {
      const targets = keptUnits()
        .filter(t => t.id !== u.id && !t.paused && (u.policy === "rotate" ? t.policy === "rotate" : t.policy === "normal"))
        .filter(t => !t.providerDate || t.providerDate > tomorrow || renewList.has(t))
        .flatMap(t => t.profiles.filter(isFree).map(q => ({ q, t })))
        .sort((x, y) => {
          // Rotativas: el correo que más dura. Perfiles: la cuenta más llena, luego la que más dura.
          if (u.policy === "rotate") return String(y.t.providerDate ?? "9999").localeCompare(String(x.t.providerDate ?? "9999"));
          const occ = (t: Unit) => t.profiles.filter(occupied).length;
          return (occ(y.t) - occ(x.t)) || String(y.t.providerDate ?? "9999").localeCompare(String(x.t.providerDate ?? "9999"))
            || (Number(x.q.pinPending) - Number(y.q.pinPending)) || x.q.slot - y.q.slot;
        });
      const pick = targets[0];
      if (pick) {
        const snapshot = { phone: p.clientPhone, wid: p.wholesalerId, date: p.date };
        moveClient(p, u, pick.q, pick.t);
        plan.moves.push({
          platform, clientPhone: snapshot.phone, wholesalerId: snapshot.wid, date: snapshot.date,
          fromEmail: u.email, toEmail: pick.t.email, toAccountId: pick.t.id, profileName: pick.q.name,
        });
        continue;
      }
      // Sin lugar libre hoy.
      if (u.policy === "normal" && lastDay(u) && !beyondGrace(u)) {
        // Último día y no hay dónde ponerlo: se renueva esta cuenta para no cortarle.
        dropList.delete(u); renewList.add(u); plan.forcedRenew++;
      } else if (u.policy !== "normal" ? (u.providerDate ?? "") < today : beyondGrace(u)) {
        // La cuenta ya venció: queda en «Pendientes de cuenta nueva» (se acomoda
        // sola apenas haya stock) y el perfil viejo se libera.
        createPendingAssignment({
          platform, clientPhone: p.clientPhone, wholesalerId: p.wholesalerId,
          profileName: "", expiresAt: p.date ?? addDays(today, PROVIDER_PERIOD_DAYS), fromEmail: u.email,
        });
        plan.pending.push({ platform, clientPhone: p.clientPhone, date: p.date });
        freeExpired(p, u);
      }
      // Si no, espera a la próxima corrida (mañana se liberan lugares).
    }

    // Una cuenta que se renueva para no cortarle a alguien no puede quedar marcada para vencer.
    for (const u of renewList) {
      if (u.action !== "renew") setDecision(u, "renew");
      plan.renew.push({
        accountId: u.id, platform, email: u.email, providerDate: u.providerDate,
        stayers: stayersOf(u).length, capacity: u.profiles.length, cost,
        overdue: !!u.providerDate && u.providerDate < today,
        reason: renewReason(stayersOf(u), u.profiles.length, u.providerDate),
      });
    }
    for (const u of dropList) {
      if (renewList.has(u)) continue;
      if (u.action !== "drop") setDecision(u, "drop");
      plan.drop.push({ accountId: u.id, platform, email: u.email, providerDate: u.providerDate });
    }

    // 4) Stock para mañana: lugares libres (o que se liberan) en cuentas que siguen.
    // Cuentas individuales (Spotify): cada cuenta libre es 1 lugar.
    const single = isSingleBrainPlatform(platform);
    const kept = units.filter(u => !dropList.has(u) && (renewList.has(u) || !due(u))
      && (single ? u.policy === "renewOnly" : u.policy !== "renewOnly") && !u.paused);
    const freeTomorrow = kept.reduce((s, u) => s + u.profiles.filter(p => !occupied(p) || !p.date || p.date <= tomorrow).length, 0);
    // Esperan lugar: los que no se pudieron mover todavía + los que quedaron
    // en «Pendientes de cuenta nueva» en esta corrida.
    const waiting = movers.filter(m => occupied(m.p) && dropList.has(m.u)).length
      + plan.pending.filter(x => x.platform === platform).length;
    const missing = reserve + waiting - freeTomorrow;
    if (missing > 0) {
      const caps = units.filter(u => u.policy === "normal").map(u => u.profiles.length).sort((a, b) => a - b);
      const cap = isRotatePlatform(platform) || single ? 1 : (caps[Math.floor(caps.length / 2)] ?? 5) || 5;
      const accountsToBuy = isRotatePlatform(platform) || single ? missing : Math.ceil(missing / cap);
      plan.stock.push({
        platform, freeTomorrow, reserve, missing, accountsToBuy, urgent: waiting > 0,
        note: isRotatePlatform(platform)
          ? `Faltan ${missing} acceso(s)${waiting ? ` — ${waiting} cliente(s) esperan cuenta nueva` : ""}`
          : `Compra ${accountsToBuy} cuenta(s)${waiting ? ` — ${waiting} cliente(s) esperan lugar` : ""}`,
      });
    }
  }

  db.prepare(`INSERT INTO brain_runs (origin, plan_json) VALUES (?, ?)`).run(origin, JSON.stringify(plan));
  db.prepare(`DELETE FROM brain_runs WHERE ran_at < datetime('now', '-30 days')`).run();
  db.prepare(`DELETE FROM brain_sales WHERE at < datetime('now', '-60 days')`).run();
  return plan;
}

// ── Lo que ve el admin en Pagos › Renovaciones ──

export type BrainOverview = {
  today: string;
  renew: (BrainRenew & { daysLeft: number | null; plans: PlanMix })[];
  lastRun: BrainPlan | null;
  pinTasks: { profileId: number; accountId: number; platform: string; email: string; password: string; profileName: string; slot: number }[];
  passwordTasks: { accountId: number; platform: string; email: string }[];
  totalCostUSDT: number;
  // Próximos 7 días (aún sin decidir): cuentas con clientes que siguen.
  upcoming: { accountId: number; platform: string; email: string; providerDate: string; stayers: number; capacity: number;
    cost: string; daysLeft: number; decideOn: string; plans: PlanMix }[];
};

/** Cuántos clientes de cada plan (12 = anual) siguen después de la fecha del proveedor. */
export type PlanMix = { months: number; count: number }[];

function planMixOf(accountId: number, providerDate: string | null): PlanMix {
  if (!providerDate) return [];
  return (db.prepare(`
    SELECT COALESCE(p.plan_months, 1) AS months, COUNT(*) AS count
    FROM access_profiles p
    WHERE p.account_id = ? AND (p.client_phone != '' OR p.wholesaler_id IS NOT NULL)
      AND COALESCE(p.expires_override, ?) > ?
    GROUP BY COALESCE(p.plan_months, 1)
    ORDER BY months DESC
  `).all(accountId, providerDate, providerDate) as PlanMix);
}

export function brainOverview(): BrainOverview {
  const today = limaToday();
  const rows = db.prepare(`
    SELECT a.id, a.platform, a.email, a.expires_at, COALESCE(c.provider_cost, '') AS cost,
      (SELECT COUNT(*) FROM access_profiles p WHERE p.account_id = a.id) AS capacity,
      (SELECT COUNT(*) FROM access_profiles p WHERE p.account_id = a.id AND (p.client_phone != '' OR p.wholesaler_id IS NOT NULL)
         AND COALESCE(p.expires_override, a.expires_at) > a.expires_at) AS stayers
    FROM access_accounts a
    LEFT JOIN catalog_products c ON UPPER(TRIM(c.platform)) = a.platform
    WHERE a.brain_action = 'renew' AND a.brain_action_for = a.expires_at
    GROUP BY a.id
    ORDER BY a.expires_at ASC, a.platform ASC
  `).all() as any[];
  // Solo cuentas con clientes que siguen: nunca se paga una cuenta vacía.
  const renew = rows.filter(r => r.stayers > 0).map(r => ({
    accountId: r.id, platform: r.platform, email: r.email, providerDate: r.expires_at, stayers: r.stayers,
    capacity: r.capacity, cost: r.cost, overdue: !!r.expires_at && r.expires_at < today,
    reason: overviewReason(r.id, r.stayers, r.capacity, r.expires_at),
    daysLeft: r.expires_at ? Math.round((Date.parse(r.expires_at) - Date.parse(today)) / 86400e3) : null,
    plans: planMixOf(r.id, r.expires_at),
  }));
  const last = db.prepare(`SELECT plan_json FROM brain_runs ORDER BY id DESC LIMIT 1`).get() as { plan_json: string } | undefined;
  let lastRun: BrainPlan | null = null;
  try { lastRun = last ? JSON.parse(last.plan_json) : null; } catch { lastRun = null; }
  const pinTasks = (db.prepare(`
    SELECT p.id AS profileId, a.id AS accountId, a.platform, a.email, a.password, p.profile_name AS profileName, p.slot_number AS slot
    FROM access_profiles p JOIN access_accounts a ON a.id = p.account_id
    WHERE p.pin_reset_pending = 1 AND a.pin_mode = 1 AND p.client_phone = '' AND p.wholesaler_id IS NULL
    ORDER BY a.platform, a.email, p.slot_number
  `).all() as any[]);
  const passwordTasks = (db.prepare(`
    SELECT id AS accountId, platform, email FROM access_accounts WHERE password_change_pending = 1 ORDER BY platform, email
  `).all() as any[]).filter(r => isBrainPlatform(r.platform));
  const totalCostUSDT = renew.reduce((s, r) => s + (Number(r.cost) || 0), 0);
  // Sin decidir todavía: desde las vencidas dentro de la gracia hasta 7 días
  // adelante. El cerebro decide la víspera (10 pm) si se paga o se mueve.
  const upcoming = (db.prepare(`
    SELECT a.id AS accountId, a.platform, a.email, a.expires_at AS providerDate, COALESCE(c.provider_cost, '') AS cost,
      (SELECT COUNT(*) FROM access_profiles p WHERE p.account_id = a.id) AS capacity,
      (SELECT COUNT(*) FROM access_profiles p WHERE p.account_id = a.id AND (p.client_phone != '' OR p.wholesaler_id IS NOT NULL)
         AND COALESCE(p.expires_override, a.expires_at) > a.expires_at) AS stayers
    FROM access_accounts a
    LEFT JOIN catalog_products c ON UPPER(TRIM(c.platform)) = a.platform
    WHERE a.expires_at >= ? AND a.expires_at <= ?
      AND (a.brain_action = '' OR a.brain_action_for IS NULL OR a.brain_action_for != a.expires_at)
    GROUP BY a.id
    ORDER BY a.expires_at ASC, a.platform ASC
  `).all(addDays(today, -GRACE_DAYS), addDays(today, 7)) as any[])
    .filter(r => isBrainPlatform(r.platform) && !isRotatePlatform(r.platform) && r.stayers > 0)
    .map(r => {
      const daysLeft = Math.round((Date.parse(r.providerDate) - Date.parse(today)) / 86400e3);
      return { ...r, daysLeft, decideOn: daysLeft <= 1 ? today : addDays(r.providerDate, -1), plans: planMixOf(r.accountId, r.providerDate) };
    });
  return { today, renew, lastRun, pinTasks, passwordTasks, totalCostUSDT: Math.round(totalCostUSDT * 100) / 100, upcoming };
}

/** «✅ Ya la renové»: la cuenta suma 30 días con el proveedor (desde su fecha
 *  si sigue vigente, o desde hoy si ya venció). No toca la fecha de los clientes. */
export function markProviderRenewed(accountId: number): { ok: true; expiresAt: string } | { ok: false; message: string } {
  const acc = db.prepare(`SELECT id, expires_at FROM access_accounts WHERE id = ?`).get(accountId) as { id: number; expires_at: string | null } | undefined;
  if (!acc) return { ok: false, message: "Cuenta no encontrada." };
  const today = limaToday();
  const base = acc.expires_at && acc.expires_at >= today ? acc.expires_at : today;
  const expiresAt = addDays(base, PROVIDER_PERIOD_DAYS);
  db.prepare(`
    UPDATE access_accounts SET expires_at = ?, brain_action = '', brain_action_for = NULL, renewal_pending_at = NULL,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(expiresAt, acc.id);
  return { ok: true, expiresAt };
}

// ─────────────────────────────────────────────────────────────
// MIGRACIÓN (una sola vez): las cuentas del cerebro pasan a fecha propia
// por cliente; «Crunchyroll Anual» se une a «Crunchyroll».
// ─────────────────────────────────────────────────────────────

const DEFAULT_PROVIDER_COST: Record<string, string> = {
  "NETFLIX PREMIUN": "10", "CRUNCHYROLL": "1.5", "AMAZON": "1.5", "HBO": "2", "PARAMOUNT": "4.5",
  "DISNEY+ PLUS": "3.8", "DISNEY PREMIUN CON ESPN": "8", "CHATGPT": "11", "CAPCUT PRO": "2", "VIX": "0.8", "SPOTIFY PREMIUN": "2",
};

/** Quita el «Pagar» de cuentas sin clientes que sigan (decisiones de antes
 *  de nov-2026, cuando se renovaba para tener stock). Se corre al arrancar. */
export function clearEmptyRenewDecisions(): number {
  return db.prepare(`
    UPDATE access_accounts SET brain_action = '', brain_action_for = NULL
    WHERE brain_action = 'renew' AND NOT EXISTS (
      SELECT 1 FROM access_profiles p WHERE p.account_id = access_accounts.id
        AND (p.client_phone != '' OR p.wholesaler_id IS NOT NULL)
        AND COALESCE(p.expires_override, access_accounts.expires_at) > access_accounts.expires_at)
  `).run().changes;
}

/** Pasa cuentas al cerebro: cada cliente queda con su fecha propia (la que
 *  tenía; +30 si ya había pagado la renovación) y la cuenta con la fecha que
 *  se le pagó al proveedor. Usado por las migraciones brain-v1 y brain-v2. */
function migrateAccountsToBrain(accounts: any[], today: string): { fixed: number; providerMoved: number; paidRenewals: number } {
  let fixed = 0, providerMoved = 0, paidRenewals = 0;
  for (const a of accounts) {
    // Cuenta con el ciclo ya confirmado: quien no pagó vence en la fecha vieja.
    if (a.renewal_cleanup_due_at) {
      db.prepare(`
        UPDATE access_profiles SET expires_override = ?
        WHERE account_id = ? AND client_phone != '' AND expires_override IS NULL AND COALESCE(renewal_status, '') != 'yes'
      `).run(a.renewal_cleanup_due_at, a.id);
    } else {
      // Pagaron la renovación y esperaban la confirmación: se les suman sus 30 días.
      const yes = db.prepare(`SELECT id FROM access_profiles WHERE account_id = ? AND client_phone != '' AND renewal_status = 'yes'`).all(a.id) as { id: number }[];
      for (const p of yes) {
        const cur = (db.prepare(`SELECT COALESCE(expires_override, ?) AS d FROM access_profiles WHERE id = ?`).get(a.expires_at, p.id) as { d: string | null }).d;
        const base = cur && cur >= today ? cur : today;
        db.prepare(`UPDATE access_profiles SET expires_override = ? WHERE id = ?`).run(addDays(base, 30), p.id);
        paidRenewals++;
      }
    }
    if (a.expires_at) {
      fixed += db.prepare(`
        UPDATE access_profiles SET expires_override = ?
        WHERE account_id = ? AND client_phone != '' AND expires_override IS NULL
      `).run(a.expires_at, a.id).changes;
    }
    db.prepare(`UPDATE access_profiles SET renewal_status = '' WHERE account_id = ?`).run(a.id);
    // Las que se pagaban mes a mes en «Renovaciones con proveedor» (anuales):
    // la cuenta queda con la fecha pagada al proveedor; el cerebro pide renovarla.
    let expires = a.expires_at;
    if (a.provider_renewal_enabled === 1 && a.provider_renewal_next_date && (!expires || a.provider_renewal_next_date < expires)) {
      // Si la próxima fecha ya pasó sin marcarla, vence hoy: el cerebro la
      // pide renovar esta noche (nunca mueve a los anuales por eso).
      expires = a.provider_renewal_next_date < today ? today : a.provider_renewal_next_date;
      providerMoved++;
    }
    db.prepare(`
      UPDATE access_accounts SET expires_at = ?, renewal_cleanup_due_at = NULL, renewal_pending_at = NULL,
        provider_renewal_enabled = CASE WHEN ? = 1 THEN 0 ELSE provider_renewal_enabled END
      WHERE id = ?
    `).run(expires, a.provider_renewal_enabled === 1 && a.provider_renewal_next_date ? 1 : 0, a.id);
  }
  return { fixed, providerMoved, paidRenewals };
}

export function runBrainMigration(): string[] {
  const done = db.prepare(`SELECT 1 FROM app_migrations WHERE name = ?`).get("brain-v1");
  if (done) return runBrainMigrationV2();
  const log: string[] = [];
  // Copia de seguridad de la base ANTES de tocar nada (una sola vez), por si
  // hay que volver atrás: data/payments-antes-del-cerebro.db.
  try {
    const backup = path.join(path.dirname(db.name), "payments-antes-del-cerebro.db");
    if (!fs.existsSync(backup)) {
      db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
      log.push("Copia de seguridad: " + path.basename(backup));
    }
  } catch (err: any) {
    // El resto del sistema ya trabaja con fecha por cliente: se migra igual.
    log.push("⚠️ No se pudo hacer la copia de seguridad: " + (err?.message ?? "error"));
  }
  const today = limaToday();
  db.transaction(() => {
    // Crunchyroll Anual → Crunchyroll (sus clientes quedan como plan de 12 meses).
    const anual = db.prepare(`SELECT id FROM access_accounts WHERE UPPER(TRIM(platform)) = 'CRUNCHYROLL ANUAL'`).all() as { id: number }[];
    for (const a of anual) {
      db.prepare(`UPDATE access_profiles SET plan_months = 12 WHERE account_id = ? AND (client_phone != '' OR wholesaler_id IS NOT NULL)`).run(a.id);
      db.prepare(`UPDATE access_accounts SET platform = 'CRUNCHYROLL' WHERE id = ?`).run(a.id);
    }
    db.prepare(`UPDATE catalog_products SET active = 0, title = 'CRUNCHYROLL ANUAL (unido a Crunchyroll)' WHERE UPPER(TRIM(platform)) = 'CRUNCHYROLL ANUAL'`).run();
    if (anual.length) log.push(`Crunchyroll Anual unido a Crunchyroll: ${anual.length} cuentas`);
    invalidateBrainPlatforms();

    const platforms = brainPlatforms();
    const accounts = (db.prepare(`SELECT * FROM access_accounts`).all() as any[]).filter(a => platforms.has(String(a.platform).trim().toUpperCase()));
    const c = migrateAccountsToBrain(accounts, today);
    const { fixed, providerMoved, paidRenewals } = c;
    for (const [platform, cost] of Object.entries(DEFAULT_PROVIDER_COST)) {
      db.prepare(`UPDATE catalog_products SET provider_cost = ? WHERE UPPER(TRIM(platform)) = ? AND provider_cost = ''`).run(cost, platform);
    }
    log.push(`Clientes con fecha propia: ${fixed}`, `Renovaciones pagadas aplicadas: ${paidRenewals}`, `Cuentas con fecha de proveedor: ${providerMoved}`);
    db.prepare(`INSERT INTO app_migrations (name) VALUES ('brain-v1')`).run();
    // Con todo ya en el cerebro, la v2 no tiene nada que hacer.
    db.prepare(`INSERT OR IGNORE INTO app_migrations (name) VALUES ('brain-v2-spotify')`).run();
  })();
  return log;
}

/** brain-v2 (nov-2026): Spotify entra al cerebro como cuenta individual con
 *  planes por meses. Sus clientes conservan su fecha; la cuenta queda como lo
 *  pagado al proveedor (2 USDT al mes). Una sola vez. */
function runBrainMigrationV2(): string[] {
  if (db.prepare(`SELECT 1 FROM app_migrations WHERE name = 'brain-v2-spotify'`).get()) return [];
  const today = limaToday();
  let out: string[] = [];
  invalidateBrainPlatforms();
  db.transaction(() => {
    const accounts = (db.prepare(`SELECT * FROM access_accounts WHERE UPPER(platform) LIKE '%SPOTIFY%'`).all() as any[]);
    const c = migrateAccountsToBrain(accounts, today);
    db.prepare(`UPDATE catalog_products SET provider_cost = '2' WHERE UPPER(platform) LIKE '%SPOTIFY%' AND provider_cost = ''`).run();
    out = [`Spotify al cerebro: ${accounts.length} cuentas · ${c.fixed} clientes con fecha propia · ${c.paidRenewals} renovaciones pagadas aplicadas`];
    db.prepare(`INSERT INTO app_migrations (name) VALUES ('brain-v2-spotify')`).run();
  })();
  return out;
}
