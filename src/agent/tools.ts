import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import {
  calendarsFor,
  listAllEvents,
  pickCalendar,
  PROVIDER_NAMES,
  type CalendarClient,
  type CalendarEvent,
} from "../calendar/index.js";
import {
  cancelReminder,
  createReminder,
  listCalendarAccounts,
  listPendingReminders,
  updateReminderTime,
  updateUser,
  type Provider,
  type User,
} from "../db/index.js";
import { ensureCallPermission, type Services } from "../reminders.js";
import { signToken } from "../security.js";
import { formatLocal, isoLocal, isValidTimezone, parseLocal } from "../time.js";

export interface AgentContext extends Services {
  user: User;
  now: Date;
  /** En una llamada, la IA puede colgar con la herramienta end_call. */
  voice?: { hangup: boolean };
}

const provider = z.enum(["google", "microsoft"]);
const localDateTime = z
  .string()
  .describe("Fecha y hora local del usuario en formato yyyy-MM-ddTHH:mm (ej. 2026-10-09T15:00)");

function describeEvent(e: CalendarEvent, tz: string): string {
  const when = e.allDay
    ? `${formatLocal(e.start, tz).split(",")[0]} (todo el día)`
    : `${formatLocal(e.start, tz)}–${isoLocal(e.end, tz).slice(11)}`;
  return `• [${e.provider}:${e.id}] ${when} — ${e.title}${e.location ? ` @ ${e.location}` : ""}`;
}

function splitEventId(id: string): { provider: Provider; rawId: string } {
  const i = id.indexOf(":");
  const p = id.slice(0, i);
  if (i < 0 || (p !== "google" && p !== "microsoft")) {
    throw new Error(`event_id debe verse como "google:<id>" o "microsoft:<id>", recibí "${id}"`);
  }
  return { provider: p, rawId: id.slice(i + 1) };
}

export function connectLink(ctx: Services, user: User): string {
  const token = signToken(ctx.config.appSecret, { uid: user.id }, 60 * 60 * 24);
  return `${ctx.config.baseUrl}/conectar?t=${encodeURIComponent(token)}`;
}

export function buildTools(ctx: AgentContext) {
  const tz = () => ctx.user.timezone;
  let clientsCache: CalendarClient[] | undefined;
  const clients = async () => (clientsCache ??= await calendarsFor(ctx.config, ctx.db, ctx.user));
  const noCalendar = () =>
    `El usuario no tiene calendarios conectados. Ofrécele este enlace para conectar Google Calendar u Outlook/Teams: ${connectLink(ctx, ctx.user)}`;

  const tools = [
    betaZodTool({
      name: "list_events",
      description:
        "Lista los eventos de los calendarios conectados (Google y/o Outlook/Teams) entre dos fechas. Úsalo para responder '¿qué tengo hoy/mañana/esta semana?' y para encontrar un evento antes de crear un recordatorio ligado a él.",
      inputSchema: z.object({ from: localDateTime, to: localDateTime }),
      run: async ({ from, to }) => {
        const cs = await clients();
        if (cs.length === 0) return noCalendar();
        const { events, errors } = await listAllEvents(cs, parseLocal(from, tz()), parseLocal(to, tz()));
        const lines = events.map((e) => describeEvent(e, tz()));
        if (errors.length) lines.push(`(Errores: ${errors.join("; ")})`);
        return lines.length ? lines.join("\n") : "No hay eventos en ese rango.";
      },
    }),

    betaZodTool({
      name: "create_event",
      description: "Crea un evento en el calendario del usuario.",
      inputSchema: z.object({
        title: z.string(),
        start: localDateTime,
        end: localDateTime.optional().describe("Si no se indica, dura 1 hora (o todo el día si all_day)."),
        all_day: z.boolean().optional(),
        location: z.string().optional(),
        notes: z.string().optional(),
        calendar: provider.optional().describe("Solo si el usuario pide un calendario concreto."),
      }),
      run: async (input) => {
        const cs = await clients();
        if (cs.length === 0) return noCalendar();
        const cal = pickCalendar(cs, ctx.user, input.calendar);
        if (!cal) return `Ese calendario no está conectado. Conectados: ${cs.map((c) => c.provider).join(", ")}`;
        const allDay = Boolean(input.all_day);
        const start = parseLocal(input.start, tz());
        const end = input.end
          ? parseLocal(input.end, tz())
          : new Date(start.getTime() + (allDay ? 24 : 1) * 60 * 60 * 1000);
        const ev = await cal.createEvent({
          title: input.title,
          start,
          end,
          allDay,
          location: input.location,
          description: input.notes,
        });
        return `Evento creado en ${PROVIDER_NAMES[cal.provider]}:\n${describeEvent(ev, tz())}`;
      },
    }),

    betaZodTool({
      name: "update_event",
      description: "Cambia un evento existente (título, hora, lugar). event_id viene de list_events, ej. 'google:abc123'.",
      inputSchema: z.object({
        event_id: z.string(),
        title: z.string().optional(),
        start: localDateTime.optional(),
        end: localDateTime.optional(),
        location: z.string().optional(),
      }),
      run: async (input) => {
        const { provider: p, rawId } = splitEventId(input.event_id);
        const cal = (await clients()).find((c) => c.provider === p);
        if (!cal) return `El calendario ${p} no está conectado.`;
        const ev = await cal.updateEvent(rawId, {
          title: input.title,
          location: input.location,
          start: input.start ? parseLocal(input.start, tz()) : undefined,
          end: input.end ? parseLocal(input.end, tz()) : undefined,
        });
        return `Evento actualizado:\n${describeEvent(ev, tz())}`;
      },
    }),

    betaZodTool({
      name: "delete_event",
      description: "Borra un evento. Confirma con el usuario antes de borrar si hay alguna duda sobre cuál es.",
      inputSchema: z.object({ event_id: z.string() }),
      run: async ({ event_id }) => {
        const { provider: p, rawId } = splitEventId(event_id);
        const cal = (await clients()).find((c) => c.provider === p);
        if (!cal) return `El calendario ${p} no está conectado.`;
        await cal.deleteEvent(rawId);
        return "Evento borrado.";
      },
    }),

    betaZodTool({
      name: "create_reminder",
      description:
        "Programa un recordatorio. channel='call' llama al usuario por WhatsApp a esa hora (la IA le habla); channel='message' le escribe. Para 'avísame 1 hora antes del dentista', busca el evento con list_events y calcula la hora.",
      inputSchema: z.object({
        message: z.string().describe("Qué hay que recordar, redactado para decírselo al usuario."),
        when: localDateTime,
        channel: z.enum(["call", "message"]),
        recurrence: z.enum(["none", "daily", "weekdays", "weekly", "monthly"]).optional(),
        event_id: z.string().optional().describe("Evento relacionado, si lo hay."),
      }),
      run: async (input) => {
        const remindAt = parseLocal(input.when, tz());
        if (remindAt.getTime() < ctx.now.getTime() - 60_000) {
          return `Esa hora (${formatLocal(remindAt, tz())}) ya pasó. Pregunta al usuario otra hora.`;
        }
        const r = await createReminder(ctx.db, {
          user_id: ctx.user.id,
          message: input.message,
          remind_at: remindAt,
          channel: input.channel,
          recurrence: input.recurrence ?? "none",
          event_ref: input.event_id ?? null,
        });
        let note = "";
        if (input.channel === "call") {
          const asked = await ensureCallPermission(ctx, ctx.user, remindAt, ctx.now);
          note = asked
            ? "\nSe le envió al usuario el botón de WhatsApp para permitir llamadas: dile que lo acepte para que la llamada funcione."
            : "";
        }
        return `Recordatorio #${r.id} programado: ${formatLocal(remindAt, tz())}, por ${input.channel === "call" ? "llamada de WhatsApp" : "mensaje"}${r.recurrence !== "none" ? `, se repite (${r.recurrence})` : ""}.${note}`;
      },
    }),

    betaZodTool({
      name: "list_reminders",
      description: "Lista los recordatorios pendientes del usuario.",
      inputSchema: z.object({}),
      run: async () => {
        const rs = await listPendingReminders(ctx.db, ctx.user.id);
        if (rs.length === 0) return "No hay recordatorios pendientes.";
        return rs
          .map(
            (r) =>
              `#${r.id} ${formatLocal(r.remind_at, tz())} — ${r.message} (${r.channel === "call" ? "llamada" : "mensaje"}${r.recurrence !== "none" ? `, ${r.recurrence}` : ""})`,
          )
          .join("\n");
      },
    }),

    betaZodTool({
      name: "cancel_reminder",
      description: "Cancela un recordatorio pendiente por su número.",
      inputSchema: z.object({ id: z.number().int() }),
      run: async ({ id }) =>
        (await cancelReminder(ctx.db, ctx.user.id, id)) ? `Recordatorio #${id} cancelado.` : `No encontré el recordatorio #${id}.`,
    }),

    betaZodTool({
      name: "reschedule_reminder",
      description: "Cambia la hora de un recordatorio pendiente (también para 'posponlo 10 minutos').",
      inputSchema: z.object({ id: z.number().int(), when: localDateTime }),
      run: async ({ id, when }) => {
        const at = parseLocal(when, tz());
        return (await updateReminderTime(ctx.db, ctx.user.id, id, at))
          ? `Recordatorio #${id} movido a ${formatLocal(at, tz())}.`
          : `No encontré el recordatorio #${id}.`;
      },
    }),

    betaZodTool({
      name: "calendar_connect_link",
      description: "Devuelve el enlace para que el usuario conecte (o reconecte) Google Calendar u Outlook/Teams, y qué calendarios tiene conectados.",
      inputSchema: z.object({}),
      run: async () => {
        const accounts = await listCalendarAccounts(ctx.db, ctx.user.id);
        const connected = accounts.map((a) => PROVIDER_NAMES[a.provider]).join(", ") || "ninguno";
        return `Conectados: ${connected}. Enlace (válido 24 h): ${connectLink(ctx, ctx.user)}`;
      },
    }),

    betaZodTool({
      name: "update_settings",
      description:
        "Guarda preferencias del usuario: su nombre, zona horaria (IANA, ej. America/Lima), canal preferido para recordatorios, calendario preferido para crear eventos, y la hora del resumen diario ('HH:mm' o 'off').",
      inputSchema: z.object({
        name: z.string().optional(),
        timezone: z.string().optional(),
        default_channel: z.enum(["call", "message"]).optional(),
        default_calendar: provider.optional(),
        daily_summary_time: z.string().optional(),
      }),
      run: async (input) => {
        if (input.timezone && !isValidTimezone(input.timezone)) return `Zona horaria inválida: ${input.timezone}`;
        let summary: string | null | undefined = undefined;
        if (input.daily_summary_time !== undefined) {
          if (input.daily_summary_time === "off") summary = null;
          else if (/^([01]\d|2[0-3]):[0-5]\d$/.test(input.daily_summary_time)) summary = input.daily_summary_time;
          else return "daily_summary_time debe ser 'HH:mm' o 'off'.";
        }
        ctx.user = await updateUser(ctx.db, ctx.user.id, {
          name: input.name,
          timezone: input.timezone,
          default_channel: input.default_channel,
          default_calendar: input.default_calendar,
          daily_summary_time: summary,
        });
        return "Preferencias guardadas.";
      },
    }),
  ];

  if (ctx.voice) {
    const voice = ctx.voice;
    tools.push(
      betaZodTool({
        name: "end_call",
        description: "Cuelga la llamada después de tu respuesta. Úsalo cuando el usuario se despide o ya no necesita nada.",
        inputSchema: z.object({}),
        run: async () => {
          voice.hangup = true;
          return "La llamada terminará después de tu respuesta. Despídete brevemente.";
        },
      }),
    );
  }

  return tools;
}
