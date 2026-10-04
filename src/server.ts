import Anthropic from "@anthropic-ai/sdk";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db/index.js";
import { startScheduler } from "./scheduler.js";
import { twilioMessenger } from "./whatsapp.js";

// En tu PC lee el archivo .env; en un hosting las variables ya vienen configuradas.
try {
  process.loadEnvFile();
} catch {}

const config = loadConfig();
const db = createPool(config.databaseUrl);
await migrate(db);

const services = { config, db, messenger: twilioMessenger(config) };
const anthropic = new Anthropic(); // usa ANTHROPIC_API_KEY

createApp(services, anthropic).listen(config.port, () => {
  console.log(`${config.assistantName} escuchando en el puerto ${config.port} (${config.baseUrl})`);
});
startScheduler(services);
