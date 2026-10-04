# 🤖 Recordatorios Bot: tu asistente personal en WhatsApp

Le escribes por WhatsApp como a una persona, y una IA (Claude) se encarga de:

- 📅 **Consultar tu calendario**: "¿qué tengo esta semana?" (Google Calendar y/o Outlook/Teams)
- ➕ **Agregar, mover o borrar eventos**: "agrega almuerzo con Carlos el viernes a la 1"
- ⏰ **Recordatorios por mensaje**: "recuérdame mañana a las 5 pagar la luz"
- 📞 **Recordatorios con llamada de WhatsApp**: "llámame una hora antes del dentista". Contestas, la IA te habla y le puedes responder ("posponlo 15 minutos", "ya lo hice").
- 🔁 **Recordatorios que se repiten**: "cada día de semana a las 8 recuérdame tomar la pastilla"
- ☀️ **Resumen de la mañana** (opcional): "mándame mi agenda todos los días a las 7"
- 🎤 **Notas de voz** (opcional): le hablas en vez de escribir
- 🛟 **Plan B**: si la llamada no se puede hacer o no contestas, te llega el recordatorio por mensaje

```
Tú:    qué tengo en mi calendario esta semana?
Sofía: Esta semana tienes:
       • martes 6, 10:00 – Reunión con el equipo
       • jueves 8, 16:00 – Dentista
Tú:    llámame el jueves una hora antes del dentista
Sofía: ¡Hecho! 📞 El jueves 8 a las 15:00 te llamo por WhatsApp. Te mandé un botón
       para permitir llamadas: acéptalo para que pueda llamarte.
Tú:    agrega al calendario: almuerzo con Carlos el viernes a la 1
Sofía: Agregado ✅ viernes 9, 13:00 – Almuerzo con Carlos (Google Calendar).
```

---

## Cómo funciona

```
WhatsApp ──► Twilio ──► este servidor ──► Claude (IA) ──► herramientas:
   ▲                        │                               • Google Calendar / Outlook
   │                        │                               • recordatorios (Postgres)
   └──── mensajes y ◄───────┘
         llamadas de WhatsApp   (cada 30 s revisa qué recordatorios tocan)
```

| Carpeta / archivo | Qué hace |
|---|---|
| `src/agent/` | La IA: personalidad, instrucciones y herramientas (calendario, recordatorios, preferencias) |
| `src/chat.ts` | Recibe tus mensajes de WhatsApp y responde |
| `src/voice.ts` | Las llamadas de WhatsApp: te dice el recordatorio y conversa contigo |
| `src/reminders.ts` | Envía los recordatorios a tiempo, pide permiso de llamada y activa el plan B |
| `src/scheduler.ts` | Revisa cada 30 s y manda el resumen diario |
| `src/calendar/` | Conexión con Google Calendar y Outlook/Teams |
| `src/app.ts` | Las rutas web (webhooks de Twilio y la página para conectar calendarios) |

---

## ⚠️ Antes de empezar: reglas de WhatsApp para llamadas

Las llamadas de WhatsApp desde un negocio tienen condiciones que pone Meta:

1. **El número del bot no puede ser de EE. UU., Canadá, Egipto, Nigeria, Turquía ni Vietnam** si quieres que llame. Usa, por ejemplo, un número de tu país.
2. **Tienes que darle permiso para que te llame.** El bot te manda un botón "Permitir llamadas" y tú lo aceptas. El permiso dura un tiempo limitado (unas 72 h), así que el bot lo vuelve a pedir solo cuando hay una llamada próxima. Meta limita estas solicitudes (1 al día, 2 por semana).
3. **Meta puede exigir un volumen mínimo de mensajes** antes de activar las llamadas en un número nuevo. Si tu número aún no tiene llamadas, **el bot funciona igual**: en vez de llamarte, te escribe.
4. Si no contestas 4 llamadas seguidas, WhatsApp quita el permiso y hay que darlo otra vez.
5. **Ventana de 24 horas:** si no le escribiste al bot en las últimas 24 h, WhatsApp solo deja que el bot te escriba con **plantillas aprobadas**. Para eso existe la plantilla de recordatorio (paso 2.4).

Estas reglas cambian a veces. Revisa la [documentación de Twilio sobre llamadas de WhatsApp](https://www.twilio.com/docs/voice/whatsapp-business-calling).

---

## Puesta en marcha, paso a paso

Vas a necesitar cuentas en: **Anthropic** (la IA), **Twilio** (WhatsApp), un **hosting** (Render) y, para el calendario, **Google Cloud** y/o **Microsoft Azure**. Todas cobran por uso o tienen capa gratuita. Para uso personal, el gasto es bajo.

### 1. Claude (la IA)
1. Entra a [console.anthropic.com](https://console.anthropic.com), crea una cuenta y agrega saldo.
2. En **API Keys**, crea una clave. Esa clave es `ANTHROPIC_API_KEY`.

### 2. Twilio (WhatsApp y llamadas)
1. Crea una cuenta en [twilio.com](https://www.twilio.com). En el panel principal copia el **Account SID** y el **Auth Token** (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`).
2. **Registra un número como "WhatsApp Sender"** (Messaging → Senders → WhatsApp senders). Tendrás que conectar una cuenta de Meta Business. Ese número es `TWILIO_WHATSAPP_NUMBER` (ej. `+51987654321`).
   - Para probar rápido puedes usar el *WhatsApp Sandbox* de Twilio, pero el sandbox **no permite llamadas ni plantillas propias**.
3. **Activa las llamadas de voz** para ese sender (WhatsApp Business Calling) desde la configuración del sender en Twilio.
4. **Crea 2 plantillas** en *Messaging → Content Template Builder* y mándalas a aprobación de WhatsApp:
   - **Recordatorio** (categoría *Utility*), por ejemplo: `⏰ Recordatorio: {{1}}`. Su SID (`HX...`) va en `TWILIO_REMINDER_CONTENT_SID`.
   - **Permiso de llamada**, con un botón de tipo **"Voice call request"** (`VOICE_CALL_REQUEST`), por ejemplo: `Para llamarte con tus recordatorios necesito tu permiso 📞`. Su SID va en `TWILIO_CALL_PERMISSION_CONTENT_SID`.
5. Cuando tengas la URL pública del bot (paso 3), configura en el sender:
   - **Mensajes entrantes** (webhook, POST): `https://TU-URL/webhooks/whatsapp`
   - **Llamadas entrantes** (voice URL, POST): `https://TU-URL/voice/inbound`. Con esto también puedes **llamar tú al bot** y hablarle.

### 3. Publicar el servidor (Render)
1. Crea una cuenta en [render.com](https://render.com) y conecta tu GitHub.
2. **New → Blueprint** y elige este repositorio. Render lee `render.yaml` y crea el servidor y la base de datos.
3. Rellena las variables que te pide (las de `.env.example`).
   - `BASE_URL` es la URL que te da Render, por ejemplo `https://recordatorios-bot.onrender.com`.
4. ⚠️ Usa un plan que **no se duerma** (el gratuito se apaga y los recordatorios no saldrían).
5. Comprueba que `https://TU-URL/health` responde `{"ok":true}`.

> También funciona en Railway, Fly.io o un VPS. Solo necesitas Node 20+ y Postgres. Ejecuta `npm ci && npm run build && npm start`.

### 4. Google Calendar (opcional)
1. En [console.cloud.google.com](https://console.cloud.google.com) crea un proyecto.
2. **APIs y servicios → Biblioteca**: habilita **Google Calendar API**.
3. **Pantalla de consentimiento OAuth**: tipo *Externo*, agrega tu correo y el permiso `.../auth/calendar.events`.
   - ⚠️ Si la dejas en modo *Prueba*, Google desconecta el calendario cada 7 días. Cámbiala a **"En producción"**. Verás un aviso de "app no verificada" al conectar; es normal en una app personal: pulsa *Avanzado → Ir a la app*.
4. **Credenciales → Crear ID de cliente OAuth** (tipo *Aplicación web*), con URI de redirección `https://TU-URL/auth/google/callback`.
5. Copia el ID y el secreto en `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.

### 5. Outlook / Teams (opcional)
1. En [portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID → Registros de aplicaciones → Nuevo registro**.
2. Tipos de cuenta: *Cuentas de cualquier organización y cuentas personales de Microsoft*.
3. URI de redirección (Web): `https://TU-URL/auth/microsoft/callback`.
4. **Certificados y secretos → Nuevo secreto de cliente**. Copia el valor en `MICROSOFT_CLIENT_SECRET`, y el *ID de aplicación (cliente)* en `MICROSOFT_CLIENT_ID`.
5. **Permisos de API → Microsoft Graph → Delegados**: `Calendars.ReadWrite`, `offline_access`, `User.Read`.

Los eventos se crean en tu calendario de Outlook, que es el mismo que usa Teams.

### 6. ¡A usarlo!
1. Escríbele "hola" al número del bot por WhatsApp.
2. Dile "conecta mi calendario". Te manda un enlace para conectar Google y/o Outlook.
3. Dile tu nombre y, si quieres, "mándame mi agenda cada mañana a las 7".

---

## Desarrollo local

```bash
npm install
cp .env.example .env      # y rellénalo
npm run dev               # servidor con recarga automática
npm test                  # pruebas
npm run typecheck
```

Para que Twilio llegue a tu computadora usa un túnel como [ngrok](https://ngrok.com) (`ngrok http 3000`) y pon esa URL en `BASE_URL` y en los webhooks de Twilio.

## Seguridad y privacidad

- Solo atiende peticiones firmadas por Twilio (`VALIDATE_TWILIO_SIGNATURE=true`).
- Con `ALLOWED_NUMBERS` solo tus números pueden usar el bot. **Recomendado.**
- Los tokens de Google y Microsoft se guardan en tu base de datos. Puedes revocarlos cuando quieras desde tu cuenta de Google o Microsoft.
- Tus mensajes se envían a Claude (Anthropic) para entenderlos y, si activas las notas de voz, el audio se envía a OpenAI para transcribirlo.

## Ideas para después

- Recordarle algo a otra persona ("recuérdale a mi mamá su cita"); necesita su permiso.
- Escalar: si no lees el mensaje en 10 min, te llama.
- Listas (súper, pendientes) y búsqueda en la web.
