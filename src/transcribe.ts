import type { Config } from "./config.js";

/**
 * Convierte una nota de voz de WhatsApp en texto (opcional: requiere OPENAI_API_KEY).
 * Devuelve null si no está configurado o falla.
 */
export async function transcribeVoiceNote(config: Config, mediaUrl: string, contentType: string): Promise<string | null> {
  if (!config.openaiApiKey) return null;
  try {
    // Los adjuntos de Twilio requieren autenticación con la cuenta.
    const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString("base64");
    const media = await fetch(mediaUrl, { headers: { Authorization: `Basic ${auth}` } });
    if (!media.ok) throw new Error(`descarga ${media.status}`);
    const audio = await media.blob();

    const ext = contentType.includes("ogg") ? "ogg" : contentType.includes("mpeg") ? "mp3" : "m4a";
    const form = new FormData();
    form.append("file", new File([audio], `nota.${ext}`, { type: contentType }));
    form.append("model", "whisper-1");
    form.append("language", config.speechLanguage.slice(0, 2));

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openaiApiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`transcripción ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { text?: string };
    return data.text?.trim() || null;
  } catch (err) {
    console.error("No se pudo transcribir la nota de voz", err);
    return null;
  }
}
