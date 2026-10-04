import type Anthropic from "@anthropic-ai/sdk";
import express, { type NextFunction, type Request, type Response } from "express";
import twilio from "twilio";
import { GOOGLE_SCOPES, googleOAuthClient } from "./calendar/google.js";
import { exchangeMicrosoftCode, microsoftAuthorizeUrl } from "./calendar/microsoft.js";
import { PROVIDER_NAMES } from "./calendar/index.js";
import { ChatHandler } from "./chat.js";
import { getUser, listCalendarAccounts, updateUser, upsertCalendarAccount, type Provider } from "./db/index.js";
import { handleCallStatus, type Services } from "./reminders.js";
import { signToken, verifyToken } from "./security.js";
import { CallSessions, inboundCallTwiml, reminderCallTwiml, voiceTurnTwiml } from "./voice.js";

export function createApp(s: Services, anthropic: Anthropic) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const chat = new ChatHandler(s, anthropic);
  const calls = new CallSessions();

  /** Rechaza peticiones que no vienen firmadas por Twilio. */
  const twilioOnly = (req: Request, res: Response, next: NextFunction) => {
    if (!s.config.validateTwilioSignature) return next();
    const signature = req.header("X-Twilio-Signature") ?? "";
    const url = `${s.config.baseUrl}${req.originalUrl}`;
    if (twilio.validateRequest(s.config.twilioAuthToken, signature, url, req.body ?? {})) return next();
    res.status(403).send("Firma de Twilio inválida");
  };

  const xml = (res: Response, body: string) => res.type("text/xml").send(body);
  const field = (req: Request, name: string) => String((req.body as Record<string, unknown>)?.[name] ?? "");

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // ---------- WhatsApp: mensajes entrantes ----------
  app.post("/webhooks/whatsapp", twilioOnly, (req, res) => {
    // Respondemos de inmediato (Twilio espera máx. 15 s) y contestamos por la API cuando la IA termine.
    xml(res, new twilio.twiml.MessagingResponse().toString());
    void chat.handle({
      from: field(req, "From"),
      body: field(req, "Body") || field(req, "ButtonText"),
      mediaUrl: field(req, "MediaUrl0") || undefined,
      mediaType: field(req, "MediaContentType0") || undefined,
    });
  });

  // ---------- Voz: llamadas de WhatsApp ----------
  app.post("/voice/reminder/:id", twilioOnly, async (req, res) => {
    xml(res, await reminderCallTwiml(s, calls, Number(req.params.id), field(req, "CallSid")));
  });

  app.post("/voice/inbound", twilioOnly, async (req, res) => {
    xml(res, await inboundCallTwiml(s, calls, field(req, "From"), field(req, "CallSid")));
  });

  app.post("/voice/turn", twilioOnly, async (req, res) => {
    xml(res, await voiceTurnTwiml(s, anthropic, calls, field(req, "CallSid"), field(req, "SpeechResult")));
  });

  app.post("/voice/status/:id", twilioOnly, async (req, res) => {
    res.sendStatus(204);
    await handleCallStatus(s, Number(req.params.id), field(req, "CallStatus")).catch((err) =>
      console.error("Error manejando estado de llamada", err),
    );
  });

  // ---------- Conectar calendarios ----------
  const userFromToken = async (token: unknown) => {
    const data = typeof token === "string" ? verifyToken<{ uid: number }>(s.config.appSecret, token) : null;
    return data ? getUser(s.db, data.uid) : undefined;
  };

  app.get("/conectar", async (req, res) => {
    const user = await userFromToken(req.query.t);
    if (!user) return void res.status(400).send(page("Enlace vencido", "<p>Pídele a tu asistente un enlace nuevo por WhatsApp.</p>"));
    const connected = new Set((await listCalendarAccounts(s.db, user.id)).map((a) => a.provider));
    const t = encodeURIComponent(String(req.query.t));
    const button = (p: Provider, enabled: boolean) =>
      enabled
        ? `<a class="btn ${p}" href="/auth/${p}/start?t=${t}">${connected.has(p) ? "✅ Reconectar" : "Conectar"} ${PROVIDER_NAMES[p]}</a>`
        : "";
    res.send(
      page(
        `Conecta tu calendario`,
        `<p>${s.config.assistantName} podrá ver tus eventos, crear nuevos y recordártelos.</p>
         ${button("google", Boolean(s.config.googleClientId))}
         ${button("microsoft", Boolean(s.config.microsoftClientId))}
         <p class="small">Puedes conectar los dos. Para desconectar, revoca el acceso desde tu cuenta de Google o Microsoft.</p>`,
      ),
    );
  });

  app.get("/auth/google/start", async (req, res) => {
    const user = await userFromToken(req.query.t);
    if (!user) return void res.status(400).send(page("Enlace vencido", "<p>Pide un enlace nuevo.</p>"));
    const url = googleOAuthClient(s.config).generateAuthUrl({
      access_type: "offline",
      prompt: "consent", // fuerza a Google a darnos refresh_token
      scope: GOOGLE_SCOPES,
      state: signToken(s.config.appSecret, { uid: user.id }, 600),
    });
    res.redirect(url);
  });

  app.get("/auth/google/callback", async (req, res) => {
    const user = await userFromToken(req.query.state);
    if (!user || typeof req.query.code !== "string") return void res.status(400).send(page("Error", "<p>Enlace inválido o vencido.</p>"));
    try {
      const { tokens } = await googleOAuthClient(s.config).getToken(req.query.code);
      if (!tokens.refresh_token) throw new Error("Google no devolvió refresh_token");
      await upsertCalendarAccount(s.db, {
        user_id: user.id,
        provider: "google",
        access_token: tokens.access_token ?? null,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      });
      await afterConnect(user.id, "google");
      res.send(page("¡Listo! ✅", "<p>Google Calendar quedó conectado. Ya puedes volver a WhatsApp.</p>"));
    } catch (err) {
      console.error("Error conectando Google", err);
      res.status(500).send(page("Error", "<p>No se pudo conectar Google Calendar. Inténtalo de nuevo.</p>"));
    }
  });

  app.get("/auth/microsoft/start", async (req, res) => {
    const user = await userFromToken(req.query.t);
    if (!user) return void res.status(400).send(page("Enlace vencido", "<p>Pide un enlace nuevo.</p>"));
    res.redirect(microsoftAuthorizeUrl(s.config, signToken(s.config.appSecret, { uid: user.id }, 600)));
  });

  app.get("/auth/microsoft/callback", async (req, res) => {
    const user = await userFromToken(req.query.state);
    if (!user || typeof req.query.code !== "string") return void res.status(400).send(page("Error", "<p>Enlace inválido o vencido.</p>"));
    try {
      const t = await exchangeMicrosoftCode(s.config, req.query.code);
      if (!t.refresh_token) throw new Error("Microsoft no devolvió refresh_token");
      await upsertCalendarAccount(s.db, {
        user_id: user.id,
        provider: "microsoft",
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: new Date(Date.now() + t.expires_in * 1000),
      });
      await afterConnect(user.id, "microsoft");
      res.send(page("¡Listo! ✅", "<p>Outlook/Teams quedó conectado. Ya puedes volver a WhatsApp.</p>"));
    } catch (err) {
      console.error("Error conectando Microsoft", err);
      res.status(500).send(page("Error", "<p>No se pudo conectar Outlook/Teams. Inténtalo de nuevo.</p>"));
    }
  });

  async function afterConnect(userId: number, provider: Provider) {
    let user = (await getUser(s.db, userId))!;
    if (!user.default_calendar) user = await updateUser(s.db, userId, { default_calendar: provider });
    await s.messenger
      .sendNotice(user, `✅ ${PROVIDER_NAMES[provider]} conectado. Prueba preguntarme: "¿qué tengo esta semana?"`)
      .catch((err) => console.error("No se pudo confirmar por WhatsApp", err));
  }

  return app;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f4f6f8;color:#1f2933;margin:0;padding:16px;display:flex;justify-content:center}
  main{background:#fff;max-width:420px;width:100%;margin-top:40px;padding:28px;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  h1{font-size:1.4rem;margin-top:0}
  .btn{display:block;text-align:center;padding:14px;margin:12px 0;border-radius:10px;color:#fff;text-decoration:none;font-weight:600}
  .google{background:#1a73e8}.microsoft{background:#5b5fc7}
  .small{font-size:.85rem;color:#616e7c}
  @media (prefers-color-scheme:dark){body{background:#111827;color:#e5e7eb}main{background:#1f2937}.small{color:#9ca3af}}
</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
}
