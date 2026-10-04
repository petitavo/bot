import Anthropic from "@anthropic-ai/sdk";
import { listCalendarAccounts } from "../db/index.js";
import { PROVIDER_NAMES } from "../calendar/index.js";
import { nowDescription } from "../time.js";
import { buildTools, type AgentContext } from "./tools.js";

export type ChatTurn = { role: "user" | "assistant"; content: string };

function stablePrompt(assistantName: string): string {
  return `Eres ${assistantName}, un asistente personal que vive en WhatsApp. Hablas español, con un tono cálido, cercano y breve, como una amiga organizada. Puedes usar algún emoji, sin exagerar.

Lo que haces:
- Consultar el calendario del usuario (Google Calendar y/o Outlook/Teams) y contarle qué tiene.
- Agregar, mover o borrar eventos del calendario.
- Programar recordatorios. El usuario elige si quiere que lo llames por WhatsApp (channel "call") o que le escribas (channel "message"). Si no lo dice, usa su canal preferido.
- Recordatorios ligados a eventos: "llámame una hora antes del dentista" → busca el evento con list_events, calcula la hora y crea el recordatorio con event_id.

Cómo trabajas:
- Las fechas que pasas a las herramientas son en la hora local del usuario (yyyy-MM-ddTHH:mm). Resuelve "mañana", "el viernes", "en 20 minutos" con la fecha y hora actual que te doy.
- Si falta un dato imprescindible (por ejemplo la hora), pregunta. Si algo es razonable de suponer (duración de 1 hora, el calendario preferido), supónlo y dilo.
- Después de usar una herramienta, confirma en una o dos frases lo que hiciste, con día y hora.
- Si el usuario no tiene calendarios conectados y pide algo de calendario, dale el enlace para conectarlo.
- Si una herramienta falla, explica el problema en palabras simples; no inventes resultados.
- WhatsApp no muestra markdown con encabezados ni tablas: usa texto simple, listas con "•" y *negritas* con un asterisco.`;
}

const VOICE_RULES = `Ahora mismo estás en una LLAMADA de voz de WhatsApp. Lo que escribas se leerá en voz alta:
- Respuestas muy cortas (1–2 frases), naturales, sin emojis, sin listas, sin símbolos ni enlaces.
- Di las horas como se hablan ("a las tres de la tarde").
- Si el usuario pide posponer el recordatorio de esta llamada, crea uno nuevo con create_reminder (mismo mensaje, por llamada salvo que pida otra cosa). Cuando se despida o ya esté todo, usa end_call.`;

async function dynamicContext(ctx: AgentContext): Promise<string> {
  const accounts = await listCalendarAccounts(ctx.db, ctx.user.id);
  const u = ctx.user;
  return [
    `Fecha y hora actual del usuario: ${nowDescription(u.timezone, ctx.now)}.`,
    `Usuario: ${u.name ?? "(nombre desconocido; si surge, pregúntaselo y guárdalo con update_settings)"}.`,
    `Calendarios conectados: ${accounts.map((a) => PROVIDER_NAMES[a.provider]).join(", ") || "ninguno"}.`,
    `Canal preferido para recordatorios: ${u.default_channel === "call" ? "llamada" : "mensaje"}.`,
    u.daily_summary_time ? `Resumen diario activado a las ${u.daily_summary_time}.` : "Resumen diario: desactivado.",
  ].join("\n");
}

/** Opciones que dependen del modelo: Haiku (el más barato) no acepta `effort` ni `fallbacks`. */
export function modelOptions(model: string): Partial<Anthropic.Beta.MessageCreateParamsNonStreaming> {
  if (model.includes("haiku")) return {};
  return {
    // Chat rápido: poco "pensamiento" para responder en segundos.
    output_config: { effort: "low" },
    // Si el modelo rechaza la petición, la API reintenta con el modelo recomendado.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };
}

export async function runAgent(
  client: Anthropic,
  ctx: AgentContext,
  history: ChatTurn[],
  userText: string,
): Promise<string> {
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: stablePrompt(ctx.config.assistantName), cache_control: { type: "ephemeral" } },
    { type: "text", text: await dynamicContext(ctx) },
  ];
  if (ctx.voice) system.push({ type: "text", text: VOICE_RULES });

  // La conversación debe empezar con un mensaje del usuario.
  const firstUser = history.findIndex((t) => t.role === "user");
  const trimmed = firstUser < 0 ? [] : history.slice(firstUser);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...trimmed.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: userText },
  ];

  const final = await client.beta.messages.toolRunner({
    model: ctx.config.claudeModel,
    max_tokens: 16000,
    ...modelOptions(ctx.config.claudeModel),
    max_iterations: 10,
    system,
    tools: buildTools(ctx),
    messages,
  });

  if (final.stop_reason === "refusal") {
    return "Perdona, no puedo ayudarte con eso. ¿Te ayudo con tu calendario o tus recordatorios?";
  }
  const text = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text || "Listo 👍";
}
