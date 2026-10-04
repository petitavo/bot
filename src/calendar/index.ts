import type { Config } from "../config.js";
import { listCalendarAccounts, type Db, type Provider, type User } from "../db/index.js";
import { googleClient } from "./google.js";
import { microsoftClient } from "./microsoft.js";
import type { CalendarClient, CalendarEvent } from "./types.js";

export type { CalendarClient, CalendarEvent, EventInput } from "./types.js";

export const PROVIDER_NAMES: Record<Provider, string> = {
  google: "Google Calendar",
  microsoft: "Outlook/Teams",
};

/** Clientes de todos los calendarios que el usuario conectó. */
export async function calendarsFor(config: Config, db: Db, user: User): Promise<CalendarClient[]> {
  const accounts = await listCalendarAccounts(db, user.id);
  return accounts.map((a) =>
    a.provider === "google"
      ? googleClient(config, db, a, user.timezone)
      : microsoftClient(config, db, a, user.timezone),
  );
}

/** Eventos de todos los calendarios conectados, ordenados por hora. Los errores de un proveedor no tumban a los demás. */
export async function listAllEvents(
  clients: CalendarClient[],
  from: Date,
  to: Date,
): Promise<{ events: CalendarEvent[]; errors: string[] }> {
  const results = await Promise.allSettled(clients.map((c) => c.listEvents(from, to)));
  const events: CalendarEvent[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") events.push(...r.value);
    else errors.push(`${PROVIDER_NAMES[clients[i].provider]}: ${String(r.reason)}`);
  });
  events.sort((a, b) => a.start.getTime() - b.start.getTime());
  return { events, errors };
}

/** Elige el calendario donde crear un evento: el pedido, el predeterminado o el único conectado. */
export function pickCalendar(clients: CalendarClient[], user: User, requested?: Provider): CalendarClient | undefined {
  if (requested) return clients.find((c) => c.provider === requested);
  if (user.default_calendar) {
    const preferred = clients.find((c) => c.provider === user.default_calendar);
    if (preferred) return preferred;
  }
  return clients[0];
}
