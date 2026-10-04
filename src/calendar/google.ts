import { google, type calendar_v3 } from "googleapis";
import { DateTime } from "luxon";
import type { Config } from "../config.js";
import { updateCalendarTokens, type CalendarAccount, type Db } from "../db/index.js";
import type { CalendarClient, CalendarEvent, EventInput } from "./types.js";

export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "openid", "email"];

export function googleOAuthClient(config: Config) {
  return new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    `${config.baseUrl}/auth/google/callback`,
  );
}

export function googleClient(config: Config, db: Db, account: CalendarAccount, timezone: string): CalendarClient {
  const auth = googleOAuthClient(config);
  auth.setCredentials({
    refresh_token: account.refresh_token,
    access_token: account.access_token ?? undefined,
    expiry_date: account.expires_at ? account.expires_at.getTime() : undefined,
  });
  // googleapis renueva el token solo; guardamos el nuevo para la próxima vez.
  auth.on("tokens", (tokens) => {
    if (tokens.access_token && tokens.expiry_date) {
      updateCalendarTokens(db, account.id, tokens.access_token, new Date(tokens.expiry_date), tokens.refresh_token ?? undefined)
        .catch((err) => console.error("No se pudo guardar el token de Google", err));
    }
  });
  const api = google.calendar({ version: "v3", auth });

  const toEvent = (e: calendar_v3.Schema$Event): CalendarEvent => {
    const allDay = Boolean(e.start?.date);
    const start = allDay
      ? DateTime.fromISO(e.start!.date!, { zone: timezone }).toJSDate()
      : new Date(e.start!.dateTime!);
    const end = allDay
      ? DateTime.fromISO(e.end!.date!, { zone: timezone }).toJSDate()
      : new Date(e.end!.dateTime!);
    return {
      id: e.id!,
      provider: "google",
      title: e.summary ?? "(sin título)",
      start,
      end,
      allDay,
      location: e.location ?? undefined,
    };
  };

  const toBody = (input: Partial<EventInput>): calendar_v3.Schema$Event => {
    const body: calendar_v3.Schema$Event = {};
    if (input.title !== undefined) body.summary = input.title;
    if (input.location !== undefined) body.location = input.location;
    if (input.description !== undefined) body.description = input.description;
    const when = (d: Date): calendar_v3.Schema$EventDateTime =>
      input.allDay
        ? { date: DateTime.fromJSDate(d).setZone(timezone).toISODate()! }
        : { dateTime: d.toISOString(), timeZone: timezone };
    if (input.start) body.start = when(input.start);
    if (input.end) body.end = when(input.end);
    return body;
  };

  return {
    provider: "google",
    async listEvents(from, to) {
      const res = await api.events.list({
        calendarId: "primary",
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 100,
      });
      return (res.data.items ?? []).filter((e) => e.status !== "cancelled").map(toEvent);
    },
    async createEvent(input) {
      const res = await api.events.insert({ calendarId: "primary", requestBody: toBody(input) });
      return toEvent(res.data);
    },
    async updateEvent(id, input) {
      const res = await api.events.patch({ calendarId: "primary", eventId: id, requestBody: toBody(input) });
      return toEvent(res.data);
    },
    async deleteEvent(id) {
      await api.events.delete({ calendarId: "primary", eventId: id });
    },
  };
}
