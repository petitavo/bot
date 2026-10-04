-- Esquema de la base de datos. Se aplica automáticamente al arrancar (idempotente).

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,              -- E.164, ej. +51987654321
  name TEXT,
  timezone TEXT NOT NULL,
  default_channel TEXT NOT NULL DEFAULT 'message',   -- 'message' | 'call'
  default_calendar TEXT,                   -- 'google' | 'microsoft' | NULL
  daily_summary_time TEXT,                 -- 'HH:mm' local, NULL = desactivado
  last_summary_date TEXT,                  -- 'yyyy-MM-dd' del último resumen enviado
  last_inbound_at TIMESTAMPTZ,             -- para saber si estamos dentro de la ventana de 24 h
  call_permission_requested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calendar_accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,                  -- 'google' | 'microsoft'
  access_token TEXT,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

CREATE TABLE IF NOT EXISTS reminders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  remind_at TIMESTAMPTZ NOT NULL,
  channel TEXT NOT NULL,                   -- 'message' | 'call'
  recurrence TEXT NOT NULL DEFAULT 'none', -- 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly'
  event_ref TEXT,                          -- 'google:<id>' / 'microsoft:<id>' si está ligado a un evento
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'sending' | 'done' | 'cancelled'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (status, remind_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,                      -- 'user' | 'assistant'
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_user_idx ON chat_messages (user_id, id);
