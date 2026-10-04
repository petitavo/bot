import type Anthropic from "@anthropic-ai/sdk";
import twilio from "twilio";
import { runAgent, type ChatTurn } from "./agent/agent.js";
import { addChatMessage, findOrCreateUser, getReminder, getUser, type User } from "./db/index.js";
import type { Services } from "./reminders.js";
import { normalizePhone } from "./security.js";

const { VoiceResponse } = twilio.twiml;

interface CallSession {
  userId: number;
  history: ChatTurn[];
  updatedAt: number;
}

/** Conversaciones de voz en curso, por CallSid. Se limpian solas después de 1 h. */
export class CallSessions {
  private sessions = new Map<string, CallSession>();

  get(sid: string): CallSession | undefined {
    return this.sessions.get(sid);
  }

  set(sid: string, s: CallSession) {
    s.updatedAt = Date.now();
    this.sessions.set(sid, s);
    for (const [k, v] of this.sessions) if (Date.now() - v.updatedAt > 60 * 60 * 1000) this.sessions.delete(k);
  }

  delete(sid: string) {
    this.sessions.delete(sid);
  }
}

function sayAndListen(s: Services, text: string): string {
  const vr = new VoiceResponse();
  const gather = vr.gather({
    input: ["speech"],
    language: s.config.speechLanguage as any,
    speechTimeout: "auto",
    action: `${s.config.baseUrl}/voice/turn`,
    method: "POST",
  });
  gather.say({ voice: s.config.ttsVoice as any, language: s.config.speechLanguage as any }, text);
  // Si no responde nada, nos despedimos.
  vr.say({ voice: s.config.ttsVoice as any, language: s.config.speechLanguage as any }, "Bueno, te dejo. ¡Hasta luego!");
  vr.hangup();
  return vr.toString();
}

function sayAndHangup(s: Services, text: string): string {
  const vr = new VoiceResponse();
  vr.say({ voice: s.config.ttsVoice as any, language: s.config.speechLanguage as any }, text);
  vr.hangup();
  return vr.toString();
}

/** Contestaste la llamada de un recordatorio: te lo decimos y te escuchamos. */
export async function reminderCallTwiml(s: Services, sessions: CallSessions, reminderId: number, callSid: string) {
  const r = await getReminder(s.db, reminderId);
  const user = r ? await getUser(s.db, r.user_id) : undefined;
  if (!r || !user) return sayAndHangup(s, "Hola, te llamaba para un recordatorio, pero ya no lo encuentro. ¡Hasta luego!");

  const name = user.name ? ` ${user.name}` : "";
  const greeting = `Hola${name}, soy ${s.config.assistantName}. Te llamo para recordarte: ${r.message}. ¿Quieres que te lo recuerde más tarde, o necesitas algo más?`;
  sessions.set(callSid, {
    userId: user.id,
    history: [
      { role: "user", content: `(Contesté la llamada del recordatorio #${r.id}: "${r.message}")` },
      { role: "assistant", content: greeting },
    ],
    updatedAt: Date.now(),
  });
  await addChatMessage(s.db, user.id, "assistant", `📞 (llamada) ${greeting}`);
  return sayAndListen(s, greeting);
}

/** Llamada entrante: el usuario llama al número del bot por WhatsApp. */
export async function inboundCallTwiml(s: Services, sessions: CallSessions, from: string, callSid: string) {
  const phone = normalizePhone(from);
  if (s.config.allowedNumbers.length && !s.config.allowedNumbers.map(normalizePhone).includes(phone)) {
    return sayAndHangup(s, "Lo siento, este número no está autorizado.");
  }
  const user = await findOrCreateUser(s.db, phone, s.config.defaultTimezone);
  const greeting = `Hola${user.name ? ` ${user.name}` : ""}, soy ${s.config.assistantName}. ¿En qué te ayudo?`;
  sessions.set(callSid, {
    userId: user.id,
    history: [
      { role: "user", content: "(Llamé por WhatsApp)" },
      { role: "assistant", content: greeting },
    ],
    updatedAt: Date.now(),
  });
  return sayAndListen(s, greeting);
}

/** Cada vez que el usuario habla en la llamada. */
export async function voiceTurnTwiml(
  s: Services,
  anthropic: Anthropic,
  sessions: CallSessions,
  callSid: string,
  speech: string,
): Promise<string> {
  const session = sessions.get(callSid);
  const user: User | undefined = session ? await getUser(s.db, session.userId) : undefined;
  if (!session || !user) return sayAndHangup(s, "Perdona, se me cortó la conversación. ¡Hasta luego!");
  if (!speech.trim()) return sayAndListen(s, "Perdona, no te escuché bien. ¿Me lo repites?");

  const voice = { hangup: false };
  let reply: string;
  try {
    reply = await runAgent(anthropic, { ...s, user, now: new Date(), voice }, session.history, speech);
  } catch (err) {
    console.error("Error del asistente en llamada", err);
    reply = "Perdona, tuve un problema. Te escribo por WhatsApp en un momento.";
    voice.hangup = true;
  }
  session.history.push({ role: "user", content: speech }, { role: "assistant", content: reply });
  sessions.set(callSid, session);
  await addChatMessage(s.db, user.id, "user", `📞 (llamada) ${speech}`);
  await addChatMessage(s.db, user.id, "assistant", `📞 (llamada) ${reply}`);

  if (voice.hangup) {
    sessions.delete(callSid);
    return sayAndHangup(s, reply);
  }
  return sayAndListen(s, reply);
}
