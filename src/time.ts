import { DateTime } from "luxon";
import type { Recurrence } from "./db/index.js";

/**
 * Interpreta una fecha/hora local escrita por la IA (ej. "2026-10-09T15:00") en la zona
 * horaria del usuario. Si trae zona explícita (Z o +hh:mm) se respeta.
 */
export function parseLocal(value: string, timezone: string): Date {
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  const dt = hasZone ? DateTime.fromISO(value, { setZone: true }) : DateTime.fromISO(value, { zone: timezone });
  if (!dt.isValid) throw new Error(`Fecha inválida: "${value}". Usa el formato yyyy-MM-ddTHH:mm.`);
  return dt.toJSDate();
}

/** Formato legible en español: "jueves 9 de octubre, 15:00". */
export function formatLocal(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date).setZone(timezone).setLocale("es").toFormat("cccc d 'de' LLLL, HH:mm");
}

/** ISO local sin zona, para mostrarle a la IA. */
export function isoLocal(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date).setZone(timezone).toFormat("yyyy-MM-dd'T'HH:mm");
}

export function nowDescription(timezone: string, now = new Date()): string {
  const dt = DateTime.fromJSDate(now).setZone(timezone).setLocale("es");
  return `${dt.toFormat("cccc d 'de' LLLL 'de' yyyy, HH:mm")} (${dt.toFormat("yyyy-MM-dd'T'HH:mm")}, zona ${timezone})`;
}

/** Siguiente ocurrencia de un recordatorio repetido, estrictamente después de `after`. */
export function nextOccurrence(previous: Date, recurrence: Recurrence, timezone: string, after = new Date()): Date | null {
  if (recurrence === "none") return null;
  let dt = DateTime.fromJSDate(previous).setZone(timezone);
  const step = () => {
    switch (recurrence) {
      case "daily":
        dt = dt.plus({ days: 1 });
        break;
      case "weekly":
        dt = dt.plus({ weeks: 1 });
        break;
      case "monthly":
        dt = dt.plus({ months: 1 });
        break;
      case "weekdays":
        do dt = dt.plus({ days: 1 });
        while (dt.weekday > 5);
        break;
    }
  };
  step();
  while (dt.toJSDate() <= after) step();
  return dt.toJSDate();
}

export function isValidTimezone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}
