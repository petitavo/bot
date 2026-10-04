// Configuración leída de variables de entorno (ver .env.example).

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function list(name: string): string[] {
  return optional(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Config {
  port: number;
  baseUrl: string;
  appSecret: string;
  databaseUrl: string;

  assistantName: string;
  defaultTimezone: string;
  allowedNumbers: string[];

  claudeModel: string;

  twilioAccountSid: string;
  twilioAuthToken: string;
  /** Número de WhatsApp del bot, en formato E.164 sin prefijo (ej. +51987654321). */
  twilioWhatsappNumber: string;
  /** Plantilla aprobada con botón VOICE_CALL_REQUEST para pedir permiso de llamada. */
  callPermissionContentSid: string;
  /** Plantilla aprobada para recordatorios fuera de la ventana de 24 h. Variable {{1}} = texto. */
  reminderContentSid: string;
  validateTwilioSignature: boolean;

  ttsVoice: string;
  speechLanguage: string;

  googleClientId: string;
  googleClientSecret: string;
  microsoftClientId: string;
  microsoftClientSecret: string;
  microsoftTenant: string;

  openaiApiKey: string;
}

export function loadConfig(): Config {
  return {
    port: Number(optional("PORT", "3000")),
    baseUrl: required("BASE_URL").replace(/\/$/, ""),
    appSecret: required("APP_SECRET"),
    databaseUrl: required("DATABASE_URL"),

    assistantName: optional("ASSISTANT_NAME", "Sofía"),
    defaultTimezone: optional("DEFAULT_TIMEZONE", "America/Lima"),
    allowedNumbers: list("ALLOWED_NUMBERS"),

    claudeModel: optional("CLAUDE_MODEL", "claude-opus-5-5"),

    twilioAccountSid: required("TWILIO_ACCOUNT_SID"),
    twilioAuthToken: required("TWILIO_AUTH_TOKEN"),
    twilioWhatsappNumber: required("TWILIO_WHATSAPP_NUMBER"),
    callPermissionContentSid: optional("TWILIO_CALL_PERMISSION_CONTENT_SID"),
    reminderContentSid: optional("TWILIO_REMINDER_CONTENT_SID"),
    validateTwilioSignature: optional("VALIDATE_TWILIO_SIGNATURE", "true") !== "false",

    ttsVoice: optional("TTS_VOICE", "Polly.Mia-Neural"),
    speechLanguage: optional("SPEECH_LANGUAGE", "es-MX"),

    googleClientId: optional("GOOGLE_CLIENT_ID"),
    googleClientSecret: optional("GOOGLE_CLIENT_SECRET"),
    microsoftClientId: optional("MICROSOFT_CLIENT_ID"),
    microsoftClientSecret: optional("MICROSOFT_CLIENT_SECRET"),
    microsoftTenant: optional("MICROSOFT_TENANT", "common"),

    openaiApiKey: optional("OPENAI_API_KEY"),
  };
}
