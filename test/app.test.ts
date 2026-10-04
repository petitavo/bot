import type Anthropic from "@anthropic-ai/sdk";
import type { AddressInfo } from "node:net";
import twilio from "twilio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { connectLink } from "../src/agent/tools.js";
import { createReminder, findOrCreateUser, recentChatMessages, type Db } from "../src/db/index.js";
import type { Services } from "../src/reminders.js";
import { parseLocal } from "../src/time.js";
import { fakeMessenger, memoryDb, testConfig, type FakeMessenger } from "./helpers.js";

let db: Db;
let messenger: FakeMessenger;
let s: Services;
let calls: any[];
let replyText: string;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base: string;

/** Claude falso: registra la petición y responde un texto fijo. */
const fakeAnthropic = {
  beta: {
    messages: {
      toolRunner: async (params: any) => {
        calls.push(params);
        return { stop_reason: "end_turn", content: [{ type: "text", text: replyText }] };
      },
    },
  },
} as unknown as Anthropic;

async function start(overrides = {}) {
  s = { config: testConfig(overrides), db, messenger };
  server = createApp(s, fakeAnthropic).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const form = (data: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data).toString(),
});

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};

beforeEach(async () => {
  db = await memoryDb();
  messenger = fakeMessenger();
  calls = [];
  replyText = "¡Hola! ¿En qué te ayudo? 😊";
});

afterEach(() => {
  server?.close();
});

describe("webhook de WhatsApp", () => {
  it("responde con la IA y guarda el historial", async () => {
    await start();
    const res = await fetch(`${base}/webhooks/whatsapp`, form({ From: "whatsapp:+51987654321", Body: "hola" }));
    expect(res.status).toBe(200);
    await waitFor(() => messenger.texts.length === 1);
    expect(messenger.texts[0]).toEqual({ phone: "+51987654321", body: replyText });

    const params = calls[0];
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.messages.at(-1)).toEqual({ role: "user", content: "hola" });
    expect(params.system[1].text).toContain("zona America/Lima");
    expect(params.tools.map((t: any) => t.name)).toContain("create_reminder");

    // El segundo mensaje lleva el historial del primero.
    replyText = "Listo";
    await fetch(`${base}/webhooks/whatsapp`, form({ From: "whatsapp:+51987654321", Body: "gracias" }));
    await waitFor(() => messenger.texts.length === 2);
    expect(calls[1].messages.map((m: any) => m.content)).toEqual(["hola", "¡Hola! ¿En qué te ayudo? 😊", "gracias"]);

    const user = await findOrCreateUser(db, "+51987654321", "America/Lima");
    expect(await recentChatMessages(db, user.id, 10)).toHaveLength(4);
  });

  it("ignora números no autorizados", async () => {
    await start({ allowedNumbers: ["+51911111111"] });
    await fetch(`${base}/webhooks/whatsapp`, form({ From: "whatsapp:+51987654321", Body: "hola" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(0);
    expect(messenger.texts).toHaveLength(0);
  });

  it("rechaza peticiones sin firma de Twilio", async () => {
    await start({ validateTwilioSignature: true });
    const res = await fetch(`${base}/webhooks/whatsapp`, form({ From: "whatsapp:+51987654321", Body: "hola" }));
    expect(res.status).toBe(403);
  });

  it("acepta peticiones firmadas por Twilio", async () => {
    await start({ validateTwilioSignature: true });
    const params = { From: "whatsapp:+51987654321", Body: "hola" };
    const signature = twilio.getExpectedTwilioSignature("token", "https://bot.example.com/webhooks/whatsapp", params);
    const res = await fetch(`${base}/webhooks/whatsapp`, {
      ...form(params),
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
    });
    expect(res.status).toBe(200);
    await waitFor(() => messenger.texts.length === 1);
  });
});

describe("llamadas de voz", () => {
  it("al contestar te dice el recordatorio y escucha; la IA puede colgar", async () => {
    await start();
    const user = await findOrCreateUser(db, "+51987654321", "America/Lima");
    const r = await createReminder(db, {
      user_id: user.id,
      message: "ir al dentista",
      remind_at: parseLocal("2026-10-09T15:00", "America/Lima"),
      channel: "call",
      recurrence: "none",
      event_ref: null,
    });

    const twiml = await (await fetch(`${base}/voice/reminder/${r.id}`, form({ CallSid: "CA1" }))).text();
    expect(twiml).toContain("<Gather");
    expect(twiml).toContain("Te llamo para recordarte: ir al dentista");
    expect(twiml).toContain('language="es-MX"');

    replyText = "Claro, te vuelvo a llamar a las tres y media.";
    const turn = await (await fetch(`${base}/voice/turn`, form({ CallSid: "CA1", SpeechResult: "recuérdamelo en media hora" }))).text();
    expect(turn).toContain(replyText);
    expect(turn).toContain("<Gather");
    expect(calls[0].system.at(-1).text).toContain("LLAMADA");
    expect(calls[0].messages.at(-1).content).toBe("recuérdamelo en media hora");
    expect(calls[0].tools.map((t: any) => t.name)).toContain("end_call");
  });

  it("si la llamada se perdió, cuelga con amabilidad", async () => {
    await start();
    const twiml = await (await fetch(`${base}/voice/turn`, form({ CallSid: "desconocida", SpeechResult: "hola" }))).text();
    expect(twiml).toContain("<Hangup");
  });

  it("si no contestas, manda el mensaje", async () => {
    await start();
    const user = await findOrCreateUser(db, "+51987654321", "America/Lima");
    const r = await createReminder(db, {
      user_id: user.id,
      message: "ir al dentista",
      remind_at: new Date(),
      channel: "call",
      recurrence: "none",
      event_ref: null,
    });
    const res = await fetch(`${base}/voice/status/${r.id}`, form({ CallStatus: "no-answer" }));
    expect(res.status).toBe(204);
    await waitFor(() => messenger.notices.length === 1);
  });
});

describe("conectar calendario", () => {
  it("muestra los botones con un enlace válido y rechaza uno falso", async () => {
    await start();
    const user = await findOrCreateUser(db, "+51987654321", "America/Lima");
    const link = connectLink(s, user).replace("https://bot.example.com", base);
    const ok = await fetch(link);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("Conectar Google Calendar");
    expect(html).toContain("Conectar Outlook/Teams");

    const bad = await fetch(`${base}/conectar?t=falso`);
    expect(bad.status).toBe(400);
  });

  it("redirige a Google y Microsoft para iniciar sesión", async () => {
    await start();
    const user = await findOrCreateUser(db, "+51987654321", "America/Lima");
    const t = new URL(connectLink(s, user)).searchParams.get("t")!;
    const g = await fetch(`${base}/auth/google/start?t=${encodeURIComponent(t)}`, { redirect: "manual" });
    expect(g.status).toBe(302);
    expect(g.headers.get("location")).toContain("accounts.google.com");
    expect(g.headers.get("location")).toContain("access_type=offline");
    const m = await fetch(`${base}/auth/microsoft/start?t=${encodeURIComponent(t)}`, { redirect: "manual" });
    expect(m.headers.get("location")).toContain("login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(m.headers.get("location")).toContain("Calendars.ReadWrite");
  });
});
