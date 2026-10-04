# CONTEXTO DEL PROYECTO (para continuar en una sesión local de Claude Code)

> Este archivo resume TODO lo hecho hasta ahora, las decisiones tomadas, lo que falta y
> los pasos exactos para ponerlo en marcha en la PC del usuario. Léelo completo antes de actuar.
> El usuario habla español: responde siempre en español, con pasos simples.

---

## 1. Qué es esto

Un **asistente personal por WhatsApp con IA** ("Sofía" por defecto). El usuario le escribe por
WhatsApp en lenguaje natural y el bot:

- Consulta su calendario: "¿qué tengo esta semana?" (Google Calendar y/o Outlook/Teams).
- Agrega, mueve o borra eventos del calendario.
- Programa recordatorios **por mensaje** o **por llamada de WhatsApp** (en la llamada la IA habla
  y el usuario puede responder: "posponlo 15 minutos").
- Recordatorios ligados a eventos: "llámame 1 hora antes del dentista".
- Recordatorios repetidos (diario, días de semana, semanal, mensual).
- Resumen diario de la agenda a la hora que elija.
- Notas de voz (opcional, con OpenAI Whisper).
- **Plan B**: si la llamada falla o no contesta, manda el recordatorio por mensaje.

Uso previsto: **personal** (el usuario y quizá su familia), con **costo bajo**.

## 2. Dónde está el código

- Repositorio: **https://github.com/petitavo/bot** (privado).
- Rama con todo el trabajo: **`claude/exciting-hypatia-6yvu6m`** (todavía no está en `main`).
- Commits:
  - `7c93929` Asistente completo (chat, calendario, recordatorios, llamadas, OAuth, pruebas).
  - `a81b746` Permite Claude Haiku (no acepta `effort`/`fallbacks`) y lee `.env` al arrancar.
- Estado: **compila sin errores** (`npm run typecheck`) y **34 pruebas pasan** (`npm test`).
  Se probó el arranque del servidor y la capa de base de datos contra **Postgres real**.
- **NO se ha probado contra servicios reales** (WhatsApp/Twilio, Google, Microsoft, Claude):
  las pruebas usan imitaciones. Es esperable tener que ajustar cosas en la primera puesta en marcha.

## 3. Tecnología

- Node.js 22 + TypeScript (ESM, `module: NodeNext`), Express 5.
- IA: **Claude** vía `@anthropic-ai/sdk` con el *tool runner* (`client.beta.messages.toolRunner` +
  `betaZodTool` con Zod 4). Modelo por variable `CLAUDE_MODEL` (por defecto `claude-opus-5-5`;
  para costo bajo usar `claude-haiku-4-5`).
- WhatsApp y llamadas: **Twilio** (`twilio` SDK). Llamadas de WhatsApp con Twilio Programmable
  Voice (`calls.create` con `to/from = whatsapp:+...`) y TwiML `<Gather input="speech">` + `<Say>`.
- Base de datos: **PostgreSQL** (`pg`). El esquema se aplica solo al arrancar (`src/db/schema.sql`).
- Calendarios: Google (`googleapis`) y Microsoft Graph (fetch directo, OAuth2).
- Fechas: `luxon`. Pruebas: `vitest` + `pg-mem`.

## 4. Mapa de archivos

| Archivo | Qué hace |
|---|---|
| `src/server.ts` | Punto de entrada. Carga `.env` (si existe), migra la BD, levanta Express y el programador. |
| `src/config.ts` | Lee todas las variables de entorno. |
| `src/app.ts` | Rutas HTTP: webhooks de Twilio, voz, página `/conectar`, OAuth de Google/Microsoft, `/health`. |
| `src/chat.ts` | Atiende cada mensaje de WhatsApp (cola por usuario, historial, notas de voz) y responde. |
| `src/agent/agent.ts` | Prompt del asistente (personalidad, reglas), reglas de voz, llamada a Claude. `modelOptions()` quita `effort`/`fallbacks` para Haiku. |
| `src/agent/tools.ts` | Herramientas de la IA: `list_events`, `create_event`, `update_event`, `delete_event`, `create_reminder`, `list_reminders`, `cancel_reminder`, `reschedule_reminder`, `calendar_connect_link`, `update_settings`, `end_call` (solo en llamadas). |
| `src/reminders.ts` | Envía recordatorios vencidos (mensaje o llamada), plan B, pide permiso de llamada (ventana 72 h). |
| `src/scheduler.ts` | Cada 30 s ejecuta `tick()` y el resumen diario. |
| `src/voice.ts` | Llamadas: saludo del recordatorio, turnos de conversación por voz, llamada entrante al bot. Sesiones de llamada en memoria (Map por CallSid). |
| `src/whatsapp.ts` | Envío por Twilio: texto (parte mensajes >1500 car.), plantillas fuera de 24 h, permiso de llamada, llamadas. |
| `src/calendar/*.ts` | Clientes de Google y Microsoft con una interfaz común (`CalendarClient`). |
| `src/db/index.ts`, `schema.sql` | Tablas `users`, `reminders`, `calendar_accounts`, `chat_messages` y sus consultas. |
| `src/security.ts` | Tokens firmados (HMAC) para enlaces/OAuth, normalizar teléfonos, lista de números permitidos. |
| `src/time.ts` | Zona horaria del usuario, formato en español, siguiente repetición. |
| `src/transcribe.ts` | Notas de voz → texto con OpenAI (opcional). |
| `test/*.test.ts` | Pruebas (unitarias, recordatorios/herramientas, app HTTP con Claude y Twilio falsos). |
| `README.md` | Guía larga (incluye producción con Render, número propio y llamadas). |
| `render.yaml` | Despliegue en Render (opcional, de pago ~$7/mes + BD). |
| `.env.example` | Todas las variables con explicación. |

### Rutas HTTP
- `POST /webhooks/whatsapp` → mensajes entrantes (Twilio). Responde vacío al instante y contesta por API.
- `POST /voice/reminder/:id` → TwiML cuando el usuario contesta la llamada de un recordatorio.
- `POST /voice/turn` → cada frase del usuario en la llamada.
- `POST /voice/inbound` → el usuario llama al bot.
- `POST /voice/status/:id` → estado final de la llamada (si `no-answer`/`busy`/`failed` → plan B).
- `GET /conectar?t=...` → página con botones para conectar Google / Microsoft.
- `GET /auth/google/start|callback`, `GET /auth/microsoft/start|callback` → OAuth.
- `GET /health` → `{"ok":true}`.
- Todas las rutas de Twilio validan la firma `X-Twilio-Signature` usando `BASE_URL` + ruta
  (por eso `BASE_URL` debe ser EXACTAMENTE la URL pública).

## 5. Decisiones ya tomadas con el usuario

- Llamadas **por WhatsApp** (no llamada telefónica normal). Plan B = **mensaje de WhatsApp**.
- Calendarios: **Google y Outlook/Teams** (los dos).
- Repo nuevo y privado: `petitavo/bot`.
- Prioridad actual: **probar con costo bajo**. Ruta acordada para empezar:
  **PC del usuario + Twilio WhatsApp Sandbox + Neon (Postgres gratis) + ngrok (URL gratis)
  + Claude Haiku + Google Calendar**. Llamadas y Microsoft quedan para después.
- El usuario usará **su número personal como usuario** del bot (en `ALLOWED_NUMBERS`), NO como
  número del bot (registrar un número en la API de WhatsApp lo quita de la app normal).

## 6. Limitaciones / cosas no verificadas (importante)

1. **Llamadas de WhatsApp (lo más incierto)**: Meta exige que el usuario acepte un permiso
   (plantilla con botón `VOICE_CALL_REQUEST`), que el número del bot NO sea de EE. UU./Canadá/
   Egipto/Nigeria/Turquía/Vietnam, y puede exigir un volumen mínimo de mensajes antes de habilitar
   llamadas. No se pudo leer la documentación de Twilio (bloqueada en la sesión en la nube), así que
   no está confirmado que `<Gather input="speech">` funcione en llamadas de WhatsApp. El
   **sandbox de Twilio NO permite llamadas** (número de EE. UU.): si se pide una llamada,
   salta el plan B por mensaje.
2. **Ventana de 24 h**: fuera de ella WhatsApp solo deja enviar plantillas aprobadas
   (`TWILIO_REMINDER_CONTENT_SID`). En el sandbox no hay plantillas propias → los recordatorios
   solo llegan si el usuario escribió al bot en las últimas 24 h.
3. **Outlook**: los eventos de "todo el día" podrían quedar corridos de zona horaria. Sin probar.
4. **Google en modo "Prueba"**: el permiso caduca cada 7 días (se reconecta pidiéndoselo al bot).
5. **Una sola instancia**: colas por usuario y sesiones de llamada viven en memoria.
6. **Tokens de calendario sin cifrar** en la BD. Para uso personal está bien.
7. La PC (y ngrok) deben estar **encendidos** para que salgan los recordatorios.
8. Latencia de llamadas: Twilio espera máx. 15 s por respuesta.

## 7. Costos estimados (aprox., uso personal ~20 mensajes/día)

- Claude Haiku: ~$1–2/semana (Opus: ~$4–8/semana). Estimación, no medida.
- Twilio sandbox: usa el crédito de prueba de Twilio (~$0.005 por mensaje).
- Neon, ngrok, Google Cloud: gratis.
- Más adelante (producción): número propio para el bot, plantillas de Meta, hosting.

---

## 8. QUÉ HACER AHORA EN LOCAL (paso a paso)

### 8.1 Lo que puede hacer Claude local (en la PC)
1. Verificar Node ≥ 22 (`node -v`) y Git. Si falta Node, indicar al usuario que instale
   Node 22 LTS desde https://nodejs.org.
2. Clonar y preparar:
   ```bash
   git clone -b claude/exciting-hypatia-6yvu6m https://github.com/petitavo/bot.git
   cd bot
   npm install
   npm run typecheck
   npm test
   ```
3. Generar `APP_SECRET`:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
4. Crear el archivo `.env` (a partir de `.env.example`) con los valores que el usuario entregue
   (ver plantilla en 8.3). **No subir `.env` a GitHub** (ya está en `.gitignore`).
5. Instalar/configurar ngrok si el usuario lo permite (ver 8.2 paso C).
6. Arrancar y verificar: `npm run dev` y abrir `https://<dominio-ngrok>/health`.
7. Leer los errores de la consola y corregir el código si algo falla (correr `npm test` y
   `npm run typecheck` antes de cada commit; commits en la misma rama).

### 8.2 Lo que debe hacer el USUARIO (requiere sus cuentas, tarjeta o celular)
**A. Base de datos (Neon, gratis)**
1. Crear cuenta en https://neon.tech → crear proyecto.
2. Copiar el *connection string* (`postgresql://...?sslmode=require`) → `DATABASE_URL`.

**B. IA (Anthropic)**
1. https://console.anthropic.com → crear cuenta → *Billing*: cargar saldo mínimo.
2. *API Keys* → crear clave → `ANTHROPIC_API_KEY`.

**C. URL pública (ngrok, gratis)**
1. Crear cuenta en https://ngrok.com, instalar ngrok, ejecutar
   `ngrok config add-authtoken <token>` (el comando aparece en su panel).
2. En el panel → *Domains* → reclamar el dominio gratis (ej. `algo.ngrok-free.app`).
3. `BASE_URL=https://algo.ngrok-free.app` (sin `/` al final).

**D. WhatsApp (Twilio Sandbox)**
1. Crear cuenta en https://www.twilio.com → copiar *Account SID* y *Auth Token*.
2. *Messaging → Try it out → Send a WhatsApp message*.
3. Desde **su WhatsApp personal** enviar `join <código>` al número del sandbox
   (normalmente +1 415 523 8886). Se renueva cada ~3 días.
4. Pestaña *Sandbox settings* → "When a message comes in":
   `https://algo.ngrok-free.app/webhooks/whatsapp`, método **POST** → *Save*.

**E. Google Calendar**
1. https://console.cloud.google.com → crear proyecto.
2. *APIs y servicios → Biblioteca* → habilitar **Google Calendar API**.
3. *Pantalla de consentimiento OAuth* → Externo → agregar su Gmail como *usuario de prueba*.
4. *Credenciales → Crear ID de cliente OAuth* → *Aplicación web* →
   URI de redirección: `https://algo.ngrok-free.app/auth/google/callback`.
5. Copiar ID y secreto → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

### 8.3 Plantilla de `.env` para la prueba local
```
PORT=3000
BASE_URL=https://algo.ngrok-free.app
APP_SECRET=<generado en 8.1 paso 3>
DATABASE_URL=postgresql://...neon...?sslmode=require

ASSISTANT_NAME=Sofía
DEFAULT_TIMEZONE=America/Lima
ALLOWED_NUMBERS=+51XXXXXXXXX

ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-haiku-4-5

TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_NUMBER=+14155238886
TWILIO_CALL_PERMISSION_CONTENT_SID=
TWILIO_REMINDER_CONTENT_SID=
VALIDATE_TWILIO_SIGNATURE=true

GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
```
(`DEFAULT_TIMEZONE`: zona del usuario; `ALLOWED_NUMBERS`: su número con código de país, sin espacios.)

### 8.4 Arrancar
Dos terminales en la carpeta `bot`:
```bash
npm run dev                                   # terminal 1: el bot
ngrok http --url=algo.ngrok-free.app 3000     # terminal 2 (si --url no existe: --domain=)
```
Comprobar `https://algo.ngrok-free.app/health` → `{"ok":true}`.

### 8.5 Prueba por WhatsApp (en orden)
1. `hola, me llamo <nombre>`
2. `conecta mi calendario` → abrir el enlace → conectar Google.
3. `qué tengo esta semana?`
4. `agrega al calendario reunión mañana a las 10`
5. `recuérdame en 2 minutos tomar agua` → debe llegar a los 2 min.
6. `mándame mi agenda cada mañana a las 7`

### 8.6 Problemas comunes
| Síntoma | Causa / solución |
|---|---|
| No responde y la consola no muestra nada | ngrok apagado o URL del webhook mal puesta en Twilio |
| ngrok muestra **403** | `BASE_URL` distinto a la URL real (https, sin `/` final) → falla la firma de Twilio |
| Error de Anthropic 400 con Haiku | Verificar que `CLAUDE_MODEL` contenga "haiku" (así se omiten `effort`/`fallbacks`) |
| `redirect_uri_mismatch` (Google) | La URI de redirección no coincide exactamente con `BASE_URL/auth/google/callback` |
| Dejó de responder tras días | El sandbox caducó → reenviar `join <código>` |
| No llega un recordatorio | PC/ngrok apagados, o pasaron >24 h sin escribirle al bot (sandbox sin plantillas) |
| Error SSL con la BD | La URL de Neon debe terminar en `?sslmode=require` |

---

## 9. Próximos pasos posibles (cuando lo básico funcione)

1. **Pasar a `main`**: abrir un pull request de `claude/exciting-hypatia-6yvu6m` a `main`.
2. **Modelo gratis (opcional)**: hacer la IA configurable con `AI_PROVIDER=ollama|anthropic`
   (Ollama expone una API compatible con OpenAI con *tool calling*; modelos sugeridos: `qwen3:8b`,
   `llama3.1:8b`). Requiere reescribir `src/agent/agent.ts` y `tools.ts` para un bucle de
   herramientas propio. Calidad menor que Claude, sobre todo con fechas.
3. **Llamadas de WhatsApp**: número propio para el bot (chip aparte, país permitido), registrarlo
   como *WhatsApp Sender* en Twilio, activar *Business Calling*, crear y aprobar las plantillas
   (recordatorio con `{{1}}` y permiso con botón `VOICE_CALL_REQUEST`), y poner la *voice URL*
   en `https://.../voice/inbound`. Verificar en la documentación actual de Twilio.
4. **Microsoft Outlook/Teams**: registro de app en Azure (ver README) y probar eventos de todo el día.
5. **Publicar sin depender de la PC**: Render (`render.yaml`, de pago), Oracle Cloud Always Free,
   o Vercel + un cron externo cada minuto (cron-job.org) llamando a un endpoint de `tick`
   (habría que añadir ese endpoint, guardar las sesiones de llamada en BD y usar `waitUntil`).
6. Ahorro: conectar directo a la **WhatsApp Cloud API de Meta** en vez de Twilio.

## 10. Reglas para el Claude local

- Responder en **español**, pasos cortos y concretos; el usuario no es necesariamente programador.
- Nunca pedir ni guardar contraseñas; las claves van solo en `.env` (no se suben a GitHub).
- No hacer pagos ni verificaciones por el usuario (tarjeta, SMS, `join` de WhatsApp).
- Antes de cada commit: `npm run typecheck` y `npm test`. Seguir el estilo del código existente
  (comentarios breves en español, nombres en inglés).
- Trabajar en la rama `claude/exciting-hypatia-6yvu6m` salvo que el usuario diga otra cosa.
