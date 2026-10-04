import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

/** Lo mínimo que necesitamos de un pool de Postgres (también lo cumple pg-mem en los tests). */
export interface Db {
  query<R extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
}

export function createPool(databaseUrl: string): pg.Pool {
  const ssl = /sslmode=require|render\.com|neon\.tech|supabase/.test(databaseUrl)
    ? { rejectUnauthorized: false }
    : undefined;
  return new pg.Pool({ connectionString: databaseUrl, ssl });
}

export function schemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "schema.sql"), "utf8");
}

export async function migrate(db: Db): Promise<void> {
  await db.query(schemaSql());
}

// ---------- Tipos de filas ----------

export type Channel = "message" | "call";
export type Recurrence = "none" | "daily" | "weekdays" | "weekly" | "monthly";
export type Provider = "google" | "microsoft";

export interface User {
  id: number;
  phone: string;
  name: string | null;
  timezone: string;
  default_channel: Channel;
  default_calendar: Provider | null;
  daily_summary_time: string | null;
  last_summary_date: string | null;
  last_inbound_at: Date | null;
  call_permission_requested_at: Date | null;
}

export interface Reminder {
  id: number;
  user_id: number;
  message: string;
  remind_at: Date;
  channel: Channel;
  recurrence: Recurrence;
  event_ref: string | null;
  status: "pending" | "sending" | "done" | "cancelled";
}

export interface CalendarAccount {
  id: number;
  user_id: number;
  provider: Provider;
  access_token: string | null;
  refresh_token: string;
  expires_at: Date | null;
}

// ---------- Usuarios ----------

export async function findOrCreateUser(db: Db, phone: string, timezone: string): Promise<User> {
  const existing = await db.query<User>("SELECT * FROM users WHERE phone = $1", [phone]);
  if (existing.rows[0]) return existing.rows[0];
  const created = await db.query<User>(
    "INSERT INTO users (phone, timezone) VALUES ($1, $2) RETURNING *",
    [phone, timezone],
  );
  return created.rows[0];
}

export async function getUser(db: Db, id: number): Promise<User | undefined> {
  const res = await db.query<User>("SELECT * FROM users WHERE id = $1", [id]);
  return res.rows[0];
}

export async function listUsers(db: Db): Promise<User[]> {
  return (await db.query<User>("SELECT * FROM users ORDER BY id")).rows;
}

const USER_FIELDS = [
  "name",
  "timezone",
  "default_channel",
  "default_calendar",
  "daily_summary_time",
  "last_summary_date",
  "last_inbound_at",
  "call_permission_requested_at",
] as const;
type UserField = (typeof USER_FIELDS)[number];

export async function updateUser(db: Db, id: number, fields: Partial<Pick<User, UserField>>): Promise<User> {
  const entries = Object.entries(fields).filter(([k, v]) => USER_FIELDS.includes(k as UserField) && v !== undefined);
  if (entries.length === 0) return (await getUser(db, id))!;
  const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(", ");
  const res = await db.query<User>(`UPDATE users SET ${sets} WHERE id = $1 RETURNING *`, [
    id,
    ...entries.map(([, v]) => v),
  ]);
  return res.rows[0];
}

// ---------- Recordatorios ----------

export async function createReminder(
  db: Db,
  r: Pick<Reminder, "user_id" | "message" | "remind_at" | "channel" | "recurrence" | "event_ref">,
): Promise<Reminder> {
  const res = await db.query<Reminder>(
    `INSERT INTO reminders (user_id, message, remind_at, channel, recurrence, event_ref)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [r.user_id, r.message, r.remind_at, r.channel, r.recurrence, r.event_ref],
  );
  return res.rows[0];
}

export async function getReminder(db: Db, id: number): Promise<Reminder | undefined> {
  return (await db.query<Reminder>("SELECT * FROM reminders WHERE id = $1", [id])).rows[0];
}

export async function listPendingReminders(db: Db, userId: number): Promise<Reminder[]> {
  const res = await db.query<Reminder>(
    "SELECT * FROM reminders WHERE user_id = $1 AND status = 'pending' ORDER BY remind_at",
    [userId],
  );
  return res.rows;
}

export async function cancelReminder(db: Db, userId: number, id: number): Promise<boolean> {
  const res = await db.query(
    "UPDATE reminders SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING id",
    [id, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function updateReminderTime(db: Db, userId: number, id: number, remindAt: Date): Promise<boolean> {
  const res = await db.query(
    "UPDATE reminders SET remind_at = $3 WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING id",
    [id, userId, remindAt],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Recordatorios que ya vencieron y siguen pendientes. */
export async function dueReminders(db: Db, now: Date): Promise<Reminder[]> {
  const res = await db.query<Reminder>(
    "SELECT * FROM reminders WHERE status = 'pending' AND remind_at <= $1 ORDER BY remind_at LIMIT 50",
    [now],
  );
  return res.rows;
}

/** Marca un recordatorio como "enviando" solo si nadie más lo tomó (evita duplicados). */
export async function claimReminder(db: Db, id: number): Promise<boolean> {
  const res = await db.query(
    "UPDATE reminders SET status = 'sending' WHERE id = $1 AND status = 'pending' RETURNING id",
    [id],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function finishReminder(db: Db, id: number, nextAt: Date | null): Promise<void> {
  if (nextAt) {
    await db.query("UPDATE reminders SET status = 'pending', remind_at = $2 WHERE id = $1", [id, nextAt]);
  } else {
    await db.query("UPDATE reminders SET status = 'done' WHERE id = $1", [id]);
  }
}

/** Recordatorios por llamada que vencen antes de `until` (para pedir permiso de llamada a tiempo). */
export async function upcomingCallReminders(db: Db, until: Date): Promise<Reminder[]> {
  const res = await db.query<Reminder>(
    "SELECT * FROM reminders WHERE status = 'pending' AND channel = 'call' AND remind_at <= $1",
    [until],
  );
  return res.rows;
}

// ---------- Cuentas de calendario ----------

export async function upsertCalendarAccount(
  db: Db,
  a: Pick<CalendarAccount, "user_id" | "provider" | "access_token" | "refresh_token" | "expires_at">,
): Promise<void> {
  await db.query("DELETE FROM calendar_accounts WHERE user_id = $1 AND provider = $2", [a.user_id, a.provider]);
  await db.query(
    `INSERT INTO calendar_accounts (user_id, provider, access_token, refresh_token, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [a.user_id, a.provider, a.access_token, a.refresh_token, a.expires_at],
  );
}

export async function listCalendarAccounts(db: Db, userId: number): Promise<CalendarAccount[]> {
  return (
    await db.query<CalendarAccount>("SELECT * FROM calendar_accounts WHERE user_id = $1 ORDER BY provider", [userId])
  ).rows;
}

export async function updateCalendarTokens(
  db: Db,
  id: number,
  accessToken: string,
  expiresAt: Date,
  refreshToken?: string,
): Promise<void> {
  if (refreshToken) {
    await db.query(
      "UPDATE calendar_accounts SET access_token = $2, expires_at = $3, refresh_token = $4 WHERE id = $1",
      [id, accessToken, expiresAt, refreshToken],
    );
  } else {
    await db.query("UPDATE calendar_accounts SET access_token = $2, expires_at = $3 WHERE id = $1", [
      id,
      accessToken,
      expiresAt,
    ]);
  }
}

// ---------- Historial de chat ----------

export async function addChatMessage(db: Db, userId: number, role: "user" | "assistant", content: string) {
  await db.query("INSERT INTO chat_messages (user_id, role, content) VALUES ($1, $2, $3)", [userId, role, content]);
}

export async function recentChatMessages(
  db: Db,
  userId: number,
  limit: number,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const res = await db.query<{ role: "user" | "assistant"; content: string }>(
    "SELECT role, content FROM chat_messages WHERE user_id = $1 ORDER BY id DESC LIMIT $2",
    [userId, limit],
  );
  return res.rows.reverse();
}
