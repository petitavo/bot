import twilio from "twilio";
import type { Config } from "./config.js";
import type { User } from "./db/index.js";

/** Todo lo que el bot hace hacia afuera por WhatsApp. Se puede reemplazar por un falso en los tests. */
export interface Messenger {
  /** Respuesta normal dentro de una conversación (ventana de 24 h abierta). */
  sendText(phone: string, body: string): Promise<void>;
  /** Aviso iniciado por el bot (recordatorio, resumen). Usa plantilla si la ventana de 24 h está cerrada. */
  sendNotice(user: User, body: string): Promise<void>;
  /** Envía la plantilla con botón "Permitir llamadas" de WhatsApp. */
  requestCallPermission(phone: string): Promise<boolean>;
  /** Llama por WhatsApp. Devuelve el CallSid. */
  placeCall(phone: string, twimlUrl: string, statusCallbackUrl: string): Promise<string>;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_BODY = 1500; // Twilio corta los mensajes de WhatsApp a 1600 caracteres.

export function insideSessionWindow(user: User, now = new Date()): boolean {
  return Boolean(user.last_inbound_at && now.getTime() - new Date(user.last_inbound_at).getTime() < WINDOW_MS - 60_000);
}

export function splitMessage(body: string, max = MAX_BODY): string[] {
  if (body.length <= max) return [body];
  const parts: string[] = [];
  let rest = body;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function twilioMessenger(config: Config): Messenger {
  const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
  const from = `whatsapp:${config.twilioWhatsappNumber}`;
  const to = (phone: string) => `whatsapp:${phone}`;

  async function sendText(phone: string, body: string) {
    for (const part of splitMessage(body)) {
      await client.messages.create({ from, to: to(phone), body: part });
    }
  }

  return {
    sendText,

    async sendNotice(user, body) {
      if (insideSessionWindow(user) || !config.reminderContentSid) {
        await sendText(user.phone, body);
        return;
      }
      // Fuera de las 24 h, WhatsApp solo permite plantillas aprobadas.
      await client.messages.create({
        from,
        to: to(user.phone),
        contentSid: config.reminderContentSid,
        contentVariables: JSON.stringify({ 1: body.slice(0, 900) }),
      });
    },

    async requestCallPermission(phone) {
      if (!config.callPermissionContentSid) return false;
      await client.messages.create({ from, to: to(phone), contentSid: config.callPermissionContentSid });
      return true;
    },

    async placeCall(phone, twimlUrl, statusCallbackUrl) {
      const call = await client.calls.create({
        from,
        to: to(phone),
        url: twimlUrl,
        method: "POST",
        statusCallback: statusCallbackUrl,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["completed"],
        timeout: 30,
      });
      return call.sid;
    },
  };
}
