import { beforeEach, describe, expect, it } from "vitest";
import { buildTools } from "../src/agent/tools.js";
import {
  createReminder,
  findOrCreateUser,
  getReminder,
  getUser,
  listPendingReminders,
  updateUser,
  type Db,
  type User,
} from "../src/db/index.js";
import { handleCallStatus, tick, type Services } from "../src/reminders.js";
import { sendDailySummaries } from "../src/scheduler.js";
import { parseLocal } from "../src/time.js";
import { fakeMessenger, memoryDb, testConfig, type FakeMessenger } from "./helpers.js";

const TZ = "America/Lima";
let db: Db;
let messenger: FakeMessenger;
let s: Services;
let user: User;

beforeEach(async () => {
  db = await memoryDb();
  messenger = fakeMessenger();
  s = { config: testConfig(), db, messenger };
  user = await findOrCreateUser(db, "+51987654321", TZ);
  user = await updateUser(db, user.id, { name: "Gus" });
});

function tool(name: string, now: Date) {
  const t = buildTools({ ...s, user, now }).find((t) => t.name === name);
  if (!t) throw new Error(`no existe ${name}`);
  return (input: unknown) => t.run(input as any) as Promise<string>;
}

describe("programador de recordatorios", () => {
  it("envía un recordatorio por mensaje cuando vence", async () => {
    await createReminder(db, {
      user_id: user.id,
      message: "pagar la luz",
      remind_at: parseLocal("2026-10-05T17:00", TZ),
      channel: "message",
      recurrence: "none",
      event_ref: null,
    });
    await tick(s, parseLocal("2026-10-05T16:59", TZ));
    expect(messenger.notices).toHaveLength(0);

    await tick(s, parseLocal("2026-10-05T17:00", TZ));
    expect(messenger.notices).toHaveLength(1);
    expect(messenger.notices[0].body).toContain("pagar la luz");
    expect(messenger.notices[0].body).toContain("Gus");

    // No se repite.
    await tick(s, parseLocal("2026-10-05T17:01", TZ));
    expect(messenger.notices).toHaveLength(1);
  });

  it("llama por WhatsApp y, si la llamada falla, manda el mensaje (plan B)", async () => {
    const r = await createReminder(db, {
      user_id: user.id,
      message: "dentista",
      remind_at: parseLocal("2026-10-09T15:00", TZ),
      channel: "call",
      recurrence: "none",
      event_ref: null,
    });
    await tick(s, parseLocal("2026-10-09T15:00", TZ));
    expect(messenger.calls).toEqual([
      {
        phone: "+51987654321",
        twimlUrl: `https://bot.example.com/voice/reminder/${r.id}`,
        statusCallbackUrl: `https://bot.example.com/voice/status/${r.id}`,
      },
    ]);
    expect(messenger.notices).toHaveLength(0);

    // No contestó → mensaje.
    await handleCallStatus(s, r.id, "no-answer");
    expect(messenger.notices).toHaveLength(1);
    expect(messenger.notices[0].body).toContain("no contestaste");

    // Contestó → nada más.
    await handleCallStatus(s, r.id, "completed");
    expect(messenger.notices).toHaveLength(1);
  });

  it("si no se puede llamar, manda el mensaje de inmediato", async () => {
    messenger.failCalls = true;
    await createReminder(db, {
      user_id: user.id,
      message: "dentista",
      remind_at: parseLocal("2026-10-09T15:00", TZ),
      channel: "call",
      recurrence: "none",
      event_ref: null,
    });
    await tick(s, parseLocal("2026-10-09T15:00", TZ));
    expect(messenger.notices).toHaveLength(1);
    expect(messenger.notices[0].body).toContain("Intenté llamarte");
  });

  it("reprograma los recordatorios que se repiten", async () => {
    const r = await createReminder(db, {
      user_id: user.id,
      message: "tomar la pastilla",
      remind_at: parseLocal("2026-10-05T08:00", TZ),
      channel: "message",
      recurrence: "daily",
      event_ref: null,
    });
    await tick(s, parseLocal("2026-10-05T08:00", TZ));
    const after = await getReminder(db, r.id);
    expect(after?.status).toBe("pending");
    expect(after?.remind_at.toISOString()).toBe(parseLocal("2026-10-06T08:00", TZ).toISOString());
  });

  it("pide permiso de llamada cuando la llamada está a menos de 72 h, una sola vez", async () => {
    await createReminder(db, {
      user_id: user.id,
      message: "reunión",
      remind_at: parseLocal("2026-10-20T10:00", TZ),
      channel: "call",
      recurrence: "none",
      event_ref: null,
    });
    await tick(s, parseLocal("2026-10-10T10:00", TZ)); // faltan 10 días
    expect(messenger.permissionRequests).toHaveLength(0);
    await tick(s, parseLocal("2026-10-18T10:00", TZ)); // faltan 2 días
    expect(messenger.permissionRequests).toEqual(["+51987654321"]);
    await tick(s, parseLocal("2026-10-19T10:00", TZ));
    expect(messenger.permissionRequests).toHaveLength(1);
  });
});

describe("herramientas de la IA", () => {
  const now = parseLocal("2026-10-04T12:00", TZ);

  it("crea, lista, mueve y cancela recordatorios", async () => {
    const created = await tool("create_reminder", now)({
      message: "llamar al dentista",
      when: "2026-10-04T17:00",
      channel: "message",
    });
    expect(created).toContain("programado");
    expect(created).toContain("domingo 4 de octubre, 17:00");

    const [r] = await listPendingReminders(db, user.id);
    expect(r.remind_at.toISOString()).toBe("2026-10-04T22:00:00.000Z");

    expect(await tool("list_reminders", now)({})).toContain("llamar al dentista");
    expect(await tool("reschedule_reminder", now)({ id: r.id, when: "2026-10-04T18:30" })).toContain("18:30");
    expect(await tool("cancel_reminder", now)({ id: r.id })).toContain("cancelado");
    expect(await listPendingReminders(db, user.id)).toHaveLength(0);
  });

  it("no programa recordatorios en el pasado", async () => {
    const res = await tool("create_reminder", now)({ message: "x", when: "2026-10-04T09:00", channel: "message" });
    expect(res).toContain("ya pasó");
    expect(await listPendingReminders(db, user.id)).toHaveLength(0);
  });

  it("al programar una llamada cercana pide el permiso de WhatsApp", async () => {
    const res = await tool("create_reminder", now)({ message: "dentista", when: "2026-10-05T15:00", channel: "call" });
    expect(res).toContain("permitir llamadas");
    expect(messenger.permissionRequests).toEqual(["+51987654321"]);
  });

  it("sin calendarios conectados ofrece el enlace", async () => {
    const res = await tool("list_events", now)({ from: "2026-10-04T00:00", to: "2026-10-05T00:00" });
    expect(res).toContain("https://bot.example.com/conectar?t=");
  });

  it("guarda preferencias y valida la zona horaria", async () => {
    expect(await tool("update_settings", now)({ timezone: "Marte/Olympus" })).toContain("inválida");
    expect(await tool("update_settings", now)({ timezone: "America/Bogota", daily_summary_time: "07:30" })).toContain(
      "guardadas",
    );
    const u = await getUser(db, user.id);
    expect(u?.timezone).toBe("America/Bogota");
    expect(u?.daily_summary_time).toBe("07:30");
  });

  it("end_call solo existe en llamadas", () => {
    expect(buildTools({ ...s, user, now }).some((t) => t.name === "end_call")).toBe(false);
    expect(buildTools({ ...s, user, now, voice: { hangup: false } }).some((t) => t.name === "end_call")).toBe(true);
  });
});

describe("resumen diario", () => {
  it("se envía una vez al día, a la hora elegida", async () => {
    await updateUser(db, user.id, { daily_summary_time: "07:00" });
    await createReminder(db, {
      user_id: user.id,
      message: "gimnasio",
      remind_at: parseLocal("2026-10-05T18:00", TZ),
      channel: "message",
      recurrence: "none",
      event_ref: null,
    });
    await sendDailySummaries(s, parseLocal("2026-10-05T06:59", TZ));
    expect(messenger.notices).toHaveLength(0);
    await sendDailySummaries(s, parseLocal("2026-10-05T07:00", TZ));
    expect(messenger.notices).toHaveLength(1);
    expect(messenger.notices[0].body).toContain("18:00 ⏰ gimnasio");
    await sendDailySummaries(s, parseLocal("2026-10-05T07:30", TZ));
    expect(messenger.notices).toHaveLength(1);
  });

  it("si se activa por la tarde, empieza al día siguiente", async () => {
    await updateUser(db, user.id, { daily_summary_time: "07:00" });
    await sendDailySummaries(s, parseLocal("2026-10-05T15:00", TZ));
    expect(messenger.notices).toHaveLength(0);
  });
});
