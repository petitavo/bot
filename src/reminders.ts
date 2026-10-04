import type { Config } from "./config.js";
import {
  claimReminder,
  finishReminder,
  getReminder,
  getUser,
  updateUser,
  upcomingCallReminders,
  dueReminders,
  type Db,
  type Reminder,
  type User,
} from "./db/index.js";
import { nextOccurrence } from "./time.js";
import type { Messenger } from "./whatsapp.js";

/** Meta da 72 h para llamar después de que el usuario acepta; pedimos permiso dentro de esa ventana. */
export const CALL_PERMISSION_WINDOW_MS = 72 * 60 * 60 * 1000;

export interface Services {
  config: Config;
  db: Db;
  messenger: Messenger;
}

/**
 * Si hay una llamada programada dentro de las próximas 72 h y no pedimos permiso recientemente,
 * mandamos el botón "Permitir llamadas". Meta limita estas solicitudes (1 por día, 2 por semana),
 * así que solo la repetimos cuando el permiso anterior ya habría caducado.
 */
export async function ensureCallPermission(s: Services, user: User, remindAt: Date, now = new Date()): Promise<boolean> {
  if (remindAt.getTime() - now.getTime() > CALL_PERMISSION_WINDOW_MS) return false;
  const last = user.call_permission_requested_at ? new Date(user.call_permission_requested_at).getTime() : 0;
  if (now.getTime() - last < CALL_PERMISSION_WINDOW_MS) return false;
  const sent = await s.messenger.requestCallPermission(user.phone);
  if (sent) await updateUser(s.db, user.id, { call_permission_requested_at: now });
  return sent;
}

export function reminderText(user: User, r: Reminder, assistantName: string): string {
  const saludo = user.name ? `Hola ${user.name}` : "Hola";
  return `⏰ ${saludo}, soy ${assistantName}. Te recuerdo: ${r.message}`;
}

/** Envía un recordatorio vencido: llamada por WhatsApp o mensaje. */
export async function deliverReminder(s: Services, r: Reminder, now = new Date()): Promise<void> {
  if (!(await claimReminder(s.db, r.id))) return; // otro proceso ya lo tomó
  const user = await getUser(s.db, r.user_id);
  if (!user) return;
  try {
    if (r.channel === "call") {
      try {
        await s.messenger.placeCall(
          user.phone,
          `${s.config.baseUrl}/voice/reminder/${r.id}`,
          `${s.config.baseUrl}/voice/status/${r.id}`,
        );
      } catch (err) {
        // Sin permiso, número sin llamadas habilitadas, etc. → plan B inmediato.
        console.warn(`No se pudo llamar para el recordatorio ${r.id}:`, err);
        await s.messenger.sendNotice(user, `📞 Intenté llamarte pero no pude.\n${reminderText(user, r, s.config.assistantName)}`);
      }
    } else {
      await s.messenger.sendNotice(user, reminderText(user, r, s.config.assistantName));
    }
  } finally {
    await finishReminder(s.db, r.id, nextOccurrence(r.remind_at, r.recurrence, user.timezone, now));
  }
}

/** Twilio avisa cómo terminó la llamada; si no contestaste, va el plan B por mensaje. */
export async function handleCallStatus(s: Services, reminderId: number, callStatus: string): Promise<void> {
  if (!["busy", "failed", "no-answer", "canceled"].includes(callStatus)) return;
  const r = await getReminder(s.db, reminderId);
  if (!r) return;
  const user = await getUser(s.db, r.user_id);
  if (!user) return;
  await s.messenger.sendNotice(user, `📞 Te llamé y no contestaste.\n${reminderText(user, r, s.config.assistantName)}`);
}

/** Una vuelta del programador: envía lo vencido y pide permisos de llamada a tiempo. */
export async function tick(s: Services, now = new Date()): Promise<void> {
  for (const r of await dueReminders(s.db, now)) {
    try {
      await deliverReminder(s, r, now);
    } catch (err) {
      console.error(`Error enviando recordatorio ${r.id}`, err);
    }
  }

  const soon = await upcomingCallReminders(s.db, new Date(now.getTime() + CALL_PERMISSION_WINDOW_MS));
  const seen = new Set<number>();
  for (const r of soon) {
    if (seen.has(r.user_id)) continue;
    seen.add(r.user_id);
    const user = await getUser(s.db, r.user_id);
    if (user) {
      await ensureCallPermission(s, user, r.remind_at, now).catch((err) =>
        console.error("Error pidiendo permiso de llamada", err),
      );
    }
  }
}
