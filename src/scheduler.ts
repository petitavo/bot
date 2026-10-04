import { DateTime } from "luxon";
import { calendarsFor, listAllEvents } from "./calendar/index.js";
import { listPendingReminders, listUsers, updateUser, type User } from "./db/index.js";
import { tick, type Services } from "./reminders.js";
import { isoLocal } from "./time.js";

/** Texto del resumen de la mañana: eventos y recordatorios de hoy. */
export async function dailySummaryText(s: Services, user: User, now: Date): Promise<string> {
  const local = DateTime.fromJSDate(now).setZone(user.timezone);
  const from = local.startOf("day").toJSDate();
  const to = local.endOf("day").toJSDate();

  const lines: string[] = [`☀️ Buenos días${user.name ? ` ${user.name}` : ""}! Esto tienes hoy:`];
  const clients = await calendarsFor(s.config, s.db, user);
  if (clients.length) {
    const { events } = await listAllEvents(clients, from, to);
    if (events.length) {
      for (const e of events) lines.push(`• ${e.allDay ? "Todo el día" : isoLocal(e.start, user.timezone).slice(11)} — ${e.title}`);
    } else {
      lines.push("• Sin eventos en el calendario.");
    }
  }
  const reminders = (await listPendingReminders(s.db, user.id)).filter((r) => r.remind_at >= from && r.remind_at <= to);
  for (const r of reminders) {
    lines.push(`• ${isoLocal(r.remind_at, user.timezone).slice(11)} ⏰ ${r.message}${r.channel === "call" ? " (te llamo)" : ""}`);
  }
  if (lines.length === 1) lines.push("Nada programado. ¡Día libre! 🎉");
  return lines.join("\n");
}

export async function sendDailySummaries(s: Services, now = new Date()): Promise<void> {
  for (const user of await listUsers(s.db)) {
    if (!user.daily_summary_time) continue;
    const local = DateTime.fromJSDate(now).setZone(user.timezone);
    const today = local.toISODate()!;
    const [h, m] = user.daily_summary_time.split(":").map(Number);
    const minutesLate = local.hour * 60 + local.minute - (h * 60 + m);
    // Solo dentro de la hora siguiente: si lo activas por la tarde, empieza mañana.
    if (user.last_summary_date === today || minutesLate < 0 || minutesLate >= 60) continue;
    try {
      await updateUser(s.db, user.id, { last_summary_date: today });
      await s.messenger.sendNotice(user, await dailySummaryText(s, user, now));
    } catch (err) {
      console.error(`Error enviando resumen a ${user.phone}`, err);
    }
  }
}

/** Revisa cada 30 segundos si hay algo que enviar. */
export function startScheduler(s: Services, intervalMs = 30_000): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick(s);
      await sendDailySummaries(s);
    } catch (err) {
      console.error("Error en el programador", err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  void run();
  return () => clearInterval(timer);
}
