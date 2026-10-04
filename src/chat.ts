import type Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "./agent/agent.js";
import { addChatMessage, findOrCreateUser, recentChatMessages, updateUser } from "./db/index.js";
import type { Services } from "./reminders.js";
import { isAllowed, normalizePhone } from "./security.js";
import { transcribeVoiceNote } from "./transcribe.js";

export interface IncomingMessage {
  from: string;
  body: string;
  mediaUrl?: string;
  mediaType?: string;
}

const HISTORY_TURNS = 20;

/** Procesa un mensaje de WhatsApp y responde. Los mensajes de un mismo usuario se atienden en orden. */
export class ChatHandler {
  private queues = new Map<string, Promise<void>>();

  constructor(
    private s: Services,
    private anthropic: Anthropic,
  ) {}

  handle(msg: IncomingMessage): Promise<void> {
    const phone = normalizePhone(msg.from);
    const prev = this.queues.get(phone) ?? Promise.resolve();
    const next = prev
      .then(() => this.process(phone, msg))
      .catch((err) => console.error(`Error atendiendo a ${phone}`, err))
      .finally(() => {
        if (this.queues.get(phone) === next) this.queues.delete(phone);
      });
    this.queues.set(phone, next);
    return next;
  }

  private async process(phone: string, msg: IncomingMessage): Promise<void> {
    const { config, db, messenger } = this.s;
    if (!isAllowed(config.allowedNumbers, phone)) {
      console.warn(`Mensaje ignorado de un número no autorizado: ${phone}`);
      return;
    }

    let user = await findOrCreateUser(db, phone, config.defaultTimezone);
    user = await updateUser(db, user.id, { last_inbound_at: new Date() });

    let text = msg.body.trim();
    if (msg.mediaUrl && msg.mediaType?.startsWith("audio/")) {
      const transcript = await transcribeVoiceNote(config, msg.mediaUrl, msg.mediaType);
      if (!transcript) {
        await messenger.sendText(phone, "Todavía no puedo escuchar notas de voz 🙈 ¿Me lo escribes?");
        return;
      }
      text = text ? `${text}\n${transcript}` : transcript;
      text = `🎤 ${text}`;
    }
    if (!text) return;

    const history = await recentChatMessages(db, user.id, HISTORY_TURNS);
    let reply: string;
    try {
      reply = await runAgent(this.anthropic, { ...this.s, user, now: new Date() }, history, text);
    } catch (err) {
      console.error("Error del asistente", err);
      reply = "Uy, tuve un problema para procesar eso 😕 ¿Lo intentas de nuevo en un momento?";
    }
    await addChatMessage(db, user.id, "user", text);
    await addChatMessage(db, user.id, "assistant", reply);
    await messenger.sendText(phone, reply);
  }
}
