import { newDb } from "pg-mem";
import type { Config } from "../src/config.js";
import { schemaSql, type Db, type User } from "../src/db/index.js";
import type { Messenger } from "../src/whatsapp.js";

export async function memoryDb(): Promise<Db> {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  await pool.query(schemaSql());
  return pool;
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    baseUrl: "https://bot.example.com",
    appSecret: "secreto-de-prueba",
    databaseUrl: "",
    assistantName: "Sofía",
    defaultTimezone: "America/Lima",
    allowedNumbers: [],
    claudeModel: "claude-opus-5-5",
    twilioAccountSid: "AC123",
    twilioAuthToken: "token",
    twilioWhatsappNumber: "+51900000000",
    callPermissionContentSid: "HXpermiso",
    reminderContentSid: "HXrecordatorio",
    validateTwilioSignature: false,
    ttsVoice: "Polly.Mia-Neural",
    speechLanguage: "es-MX",
    googleClientId: "google-id",
    googleClientSecret: "google-secret",
    microsoftClientId: "ms-id",
    microsoftClientSecret: "ms-secret",
    microsoftTenant: "common",
    openaiApiKey: "",
    ...overrides,
  };
}

export interface FakeMessenger extends Messenger {
  texts: { phone: string; body: string }[];
  notices: { phone: string; body: string }[];
  permissionRequests: string[];
  calls: { phone: string; twimlUrl: string; statusCallbackUrl: string }[];
  failCalls: boolean;
}

export function fakeMessenger(): FakeMessenger {
  const m: FakeMessenger = {
    texts: [],
    notices: [],
    permissionRequests: [],
    calls: [],
    failCalls: false,
    async sendText(phone, body) {
      m.texts.push({ phone, body });
    },
    async sendNotice(user: User, body) {
      m.notices.push({ phone: user.phone, body });
    },
    async requestCallPermission(phone) {
      m.permissionRequests.push(phone);
      return true;
    },
    async placeCall(phone, twimlUrl, statusCallbackUrl) {
      if (m.failCalls) throw new Error("sin permiso de llamada");
      m.calls.push({ phone, twimlUrl, statusCallbackUrl });
      return "CA123";
    },
  };
  return m;
}
