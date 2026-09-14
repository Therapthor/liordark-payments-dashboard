import {
  getDailyTotals,
  getTotalForDate,
  getTotalForMonth,
  getAllTimeTotal,
} from "../db/payments.repository";
import { getAllManualEntries, getManualEntry } from "../db/ledger.repository";

/** Fecha de hoy en horario Lima, formato YYYY-MM-DD. */
export function getLimaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
}

/** Mes actual en horario Lima, formato YYYY-MM. */
export function getLimaMonth(): string {
  return getLimaToday().slice(0, 7);
}

export type SummaryStats = {
  today:   { date: string; total: number; count: number };
  month:   { date: string; total: number; count: number };
  allTime: { total: number; count: number };
};

export function getSummary(): SummaryStats {
  const today = getLimaToday();
  const month = getLimaMonth();

  const todayTotals = getTotalForDate(today) ?? { date: today, total: 0, count: 0 };
  const monthTotals = getTotalForMonth(month);
  const allTime     = getAllTimeTotal();

  return {
    today:   todayTotals,
    month:   monthTotals,
    allTime: { total: allTime.total, count: allTime.count },
  };
}

export type HistoryDay = {
  date:   string;
  total:  number;
  count:  number;
  source: "auto" | "manual" | "none";
  note?:  string;
};

/**
 * Historial de los últimos N días — combina datos automáticos (pagos reales
 * sincronizados) con entradas manuales para días sin datos (backfill).
 * Si un día tiene AMBOS, el automático manda (es el dato real).
 */
export function getHistory(daysBack: number): HistoryDay[] {
  const autoDays  = getDailyTotals(daysBack);
  const autoByDate = new Map(autoDays.map(d => [d.date, d]));
  const manualEntries = getAllManualEntries();
  const manualByDate  = new Map(manualEntries.map(e => [e.date, e]));

  const allDates = new Set<string>([...autoByDate.keys(), ...manualByDate.keys()]);

  const today = new Date();
  for (let i = 0; i < daysBack; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(d);
    allDates.add(ymd);
  }

  const result: HistoryDay[] = [];
  for (const date of allDates) {
    const auto = autoByDate.get(date);
    if (auto && auto.count > 0) {
      result.push({ date, total: auto.total, count: auto.count, source: "auto" });
      continue;
    }
    const manual = manualByDate.get(date);
    if (manual) {
      result.push({ date, total: manual.amount, count: 0, source: "manual", note: manual.note });
      continue;
    }
    result.push({ date, total: 0, count: 0, source: "none" });
  }

  return result.sort((a, b) => b.date.localeCompare(a.date));
}

export function getDayInfo(date: string): HistoryDay {
  const auto = getTotalForDate(date);
  if (auto && auto.count > 0) {
    return { date, total: auto.total, count: auto.count, source: "auto" };
  }
  const manual = getManualEntry(date);
  if (manual) {
    return { date, total: manual.amount, count: 0, source: "manual", note: manual.note };
  }
  return { date, total: 0, count: 0, source: "none" };
}
