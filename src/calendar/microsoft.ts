import { DateTime } from "luxon";
import type { Config } from "../config.js";
import { updateCalendarTokens, type CalendarAccount, type Db } from "../db/index.js";
import type { CalendarClient, CalendarEvent, EventInput } from "./types.js";

// Outlook / Teams (Microsoft 365 o cuenta personal) vía Microsoft Graph.
export const MICROSOFT_SCOPES = ["offline_access", "User.Read", "Calendars.ReadWrite"];
const GRAPH = "https://graph.microsoft.com/v1.0";

export function microsoftAuthorizeUrl(config: Config, state: string): string {
  const params = new URLSearchParams({
    client_id: config.microsoftClientId,
    response_type: "code",
    redirect_uri: `${config.baseUrl}/auth/microsoft/callback`,
    response_mode: "query",
    scope: MICROSOFT_SCOPES.join(" "),
    state,
    prompt: "select_account",
  });
  return `https://login.microsoftonline.com/${config.microsoftTenant}/oauth2/v2.0/authorize?${params}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function tokenRequest(config: Config, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`https://login.microsoftonline.com/${config.microsoftTenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.microsoftClientId,
      client_secret: config.microsoftClientSecret,
      scope: MICROSOFT_SCOPES.join(" "),
      ...body,
    }),
  });
  if (!res.ok) throw new Error(`Microsoft token error ${res.status}: ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

export function exchangeMicrosoftCode(config: Config, code: string): Promise<TokenResponse> {
  return tokenRequest(config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: `${config.baseUrl}/auth/microsoft/callback`,
  });
}

interface GraphEvent {
  id: string;
  subject?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location?: { displayName?: string };
}

export function microsoftClient(config: Config, db: Db, account: CalendarAccount, timezone: string): CalendarClient {
  let accessToken = account.access_token;
  let expiresAt = account.expires_at;

  async function token(): Promise<string> {
    if (accessToken && expiresAt && expiresAt.getTime() - Date.now() > 60_000) return accessToken;
    const t = await tokenRequest(config, { grant_type: "refresh_token", refresh_token: account.refresh_token });
    accessToken = t.access_token;
    expiresAt = new Date(Date.now() + t.expires_in * 1000);
    await updateCalendarTokens(db, account.id, accessToken, expiresAt, t.refresh_token);
    return accessToken;
  }

  async function graph<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${GRAPH}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await token()}`,
        "Content-Type": "application/json",
        // Pedimos las horas en UTC para no depender de nombres de zona de Windows.
        Prefer: 'outlook.timezone="UTC"',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Microsoft Graph ${method} ${path} → ${res.status}: ${await res.text()}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  const parse = (v: { dateTime: string }) => DateTime.fromISO(v.dateTime, { zone: "UTC" }).toJSDate();

  const toEvent = (e: GraphEvent): CalendarEvent => {
    const allDay = Boolean(e.isAllDay);
    let start = parse(e.start);
    let end = parse(e.end);
    if (allDay) {
      // Los eventos de día completo vienen a medianoche UTC: los llevamos a medianoche local.
      const local = (d: Date) =>
        DateTime.fromISO(DateTime.fromJSDate(d, { zone: "UTC" }).toISODate()!, { zone: timezone }).toJSDate();
      start = local(start);
      end = local(end);
    }
    return {
      id: e.id,
      provider: "microsoft",
      title: e.subject || "(sin título)",
      start,
      end,
      allDay,
      location: e.location?.displayName || undefined,
    };
  };

  const toBody = (input: Partial<EventInput>) => {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.subject = input.title;
    if (input.location !== undefined) body.location = { displayName: input.location };
    if (input.description !== undefined) body.body = { contentType: "text", content: input.description };
    if (input.allDay !== undefined) body.isAllDay = input.allDay;
    const when = (d: Date) =>
      input.allDay
        ? { dateTime: `${DateTime.fromJSDate(d).setZone(timezone).toISODate()}T00:00:00`, timeZone: timezone }
        : { dateTime: DateTime.fromJSDate(d, { zone: "UTC" }).toFormat("yyyy-MM-dd'T'HH:mm:ss"), timeZone: "UTC" };
    if (input.start) body.start = when(input.start);
    if (input.end) body.end = when(input.end);
    return body;
  };

  return {
    provider: "microsoft",
    async listEvents(from, to) {
      const params = new URLSearchParams({
        startDateTime: from.toISOString(),
        endDateTime: to.toISOString(),
        $orderby: "start/dateTime",
        $top: "100",
        $select: "id,subject,isAllDay,isCancelled,start,end,location",
      });
      const res = await graph<{ value: GraphEvent[] }>("GET", `/me/calendarView?${params}`);
      return res.value.filter((e) => !e.isCancelled).map(toEvent);
    },
    async createEvent(input) {
      return toEvent(await graph<GraphEvent>("POST", "/me/events", toBody(input)));
    },
    async updateEvent(id, input) {
      return toEvent(await graph<GraphEvent>("PATCH", `/me/events/${encodeURIComponent(id)}`, toBody(input)));
    },
    async deleteEvent(id) {
      await graph("DELETE", `/me/events/${encodeURIComponent(id)}`);
    },
  };
}
