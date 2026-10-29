-- Jarvis memory. Single-user for now; user_id columns leave room for more.

CREATE TABLE IF NOT EXISTS conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every turn sent to or returned by Claude, stored as the exact content
-- blocks so thinking and compaction blocks are passed back unchanged.
-- `display_text` is what the app renders; `kind` separates API turns from
-- background-task updates, which are folded into the next user turn.
CREATE TABLE IF NOT EXISTS messages (
  id            BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  kind          TEXT NOT NULL DEFAULT 'turn' CHECK (kind IN ('turn', 'task_update')),
  content       JSONB NOT NULL,
  display_text  TEXT,
  source        TEXT NOT NULL DEFAULT 'text' CHECK (source IN ('text', 'voice', 'system')),
  consumed      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, id);

-- Long-term facts Claude saves with the remember tool.
CREATE TABLE IF NOT EXISTS facts (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  fact        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Background tasks run by the task-lane agent.
CREATE TABLE IF NOT EXISTS tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  instructions    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'waiting_approval', 'done', 'failed')),
  session_id      TEXT,
  result          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Approval requests raised while a task runs (purchases, sends, submits).
CREATE TABLE IF NOT EXISTS approvals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_id    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('tool_confirmation', 'custom_tool')),
  summary     TEXT NOT NULL,
  decision    TEXT CHECK (decision IN ('allow', 'deny')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ
);

-- Expo push tokens for the user's devices.
CREATE TABLE IF NOT EXISTS push_tokens (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 0.2: tasks survive restarts. Approvals are answered straight to the
-- session, so nothing waits in memory; replays must not double-insert.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_message TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS approvals_task_event_idx ON approvals (task_id, event_id);

-- 0.3: reminders and scheduled jobs.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id     TEXT PRIMARY KEY,
  timezone    TEXT NOT NULL DEFAULT 'UTC',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- action 'notify' sends the text as a push; 'run' runs it as a prompt
-- (for example a morning briefing) and pushes Jarvis's answer.
CREATE TABLE IF NOT EXISTS reminders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  text            TEXT NOT NULL,
  action          TEXT NOT NULL DEFAULT 'notify' CHECK (action IN ('notify', 'run')),
  due_at          TIMESTAMPTZ NOT NULL,
  repeat          TEXT CHECK (repeat IN ('daily', 'weekdays', 'weekends', 'weekly', 'biweekly', 'monthly')),
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  status          TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'done', 'cancelled')),
  last_fired_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (due_at) WHERE status = 'scheduled';
-- Weekends, every two weeks and monthly. A monthly reminder keeps its day of the month
-- in month_day, so one on the 31st comes back to the 31st after a shorter month.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS month_day SMALLINT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reminders_repeat_check' AND pg_get_constraintdef(oid) LIKE '%monthly%') THEN
    ALTER TABLE reminders DROP CONSTRAINT IF EXISTS reminders_repeat_check;
    ALTER TABLE reminders ADD CONSTRAINT reminders_repeat_check CHECK (repeat IN ('daily', 'weekdays', 'weekends', 'weekly', 'biweekly', 'monthly'));
  END IF;
END $$;
-- "Keep reminding me until I do it": after firing, a one-off copy comes back every nag_minutes
-- until the user taps Done. Copies point at the reminder they repeat (nag_of) and count down nags_left.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS nag_minutes SMALLINT;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS nag_of UUID;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS nags_left SMALLINT;

-- 0.4: usage and cost tracking.
CREATE TABLE IF NOT EXISTS usage_events (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            TEXT NOT NULL,
  model              TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  web_searches       INTEGER NOT NULL DEFAULT 0,
  cost_usd           NUMERIC(12, 6) NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_user_time_idx ON usage_events (user_id, created_at);
-- List cost reported by the Managed Agents session (tokens and sandbox time).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0;

-- 0.5: account connectors. Tokens are encrypted with CONNECTOR_SECRET.
CREATE TABLE IF NOT EXISTS connectors (
  user_id        TEXT NOT NULL,
  provider       TEXT NOT NULL,
  account_email  TEXT,
  tokens         TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  provider    TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

-- 0.6: remote MCP servers the user adds (Notion, Linear, Zapier...). Tokens encrypted with CONNECTOR_SECRET.
CREATE TABLE IF NOT EXISTS mcp_servers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  token       TEXT,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

-- 0.7: per-device tokens, so the master JARVIS_APP_TOKEN never has to live on a phone.
CREATE TABLE IF NOT EXISTS devices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash   TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

-- 0.8: full-text search over past chats (the search_past_chats tool and the History search box).
CREATE INDEX IF NOT EXISTS messages_display_text_fts_idx
  ON messages USING GIN (to_tsvector('english', coalesce(display_text, '')));

-- A vault Jarvis creates for one task to hold its MCP server tokens; deleted when the task ends.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS vault_id TEXT;

-- OAuth sign-in for MCP servers: tokens per server, and the pending sign-in's PKCE verifier and client.
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS oauth TEXT;
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS data TEXT;

-- Tasks the user stops from the app.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('queued', 'running', 'waiting_approval', 'done', 'failed', 'cancelled'));

-- Chats pinned to the top of History.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;

-- One "nearly at today's cap" notification per local day.
CREATE TABLE IF NOT EXISTS budget_alerts (
  user_id  TEXT NOT NULL,
  day      DATE NOT NULL,
  PRIMARY KEY (user_id, day)
);

-- Files a background task's agent saved to /mnt/session/outputs/, kept in the Files API.
CREATE TABLE IF NOT EXISTS task_files (
  file_id     TEXT PRIMARY KEY,
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size_bytes  BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which optional notifications the user wants. Approvals and reminders always notify.
CREATE TABLE IF NOT EXISTS notify_settings (
  user_id   TEXT PRIMARY KEY,
  replies   BOOLEAN NOT NULL DEFAULT true,
  tasks     BOOLEAN NOT NULL DEFAULT true,
  spending  BOOLEAN NOT NULL DEFAULT true
);

-- Lists the user keeps with Jarvis: shopping, packing, to-dos. One row per item.
CREATE TABLE IF NOT EXISTS list_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  list        TEXT NOT NULL,
  text        TEXT NOT NULL,
  done        BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS list_items_user_list ON list_items (user_id, list, created_at);

-- Notes the user takes by voice ("take a note: …") or saves from a reply.
CREATE TABLE IF NOT EXISTS notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_user_updated ON notes (user_id, updated_at DESC);

-- Named places ("home", "work") for reminders that go off on arriving or leaving.
CREATE TABLE IF NOT EXISTS places (
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  latitude    DOUBLE PRECISION NOT NULL,
  longitude   DOUBLE PRECISION NOT NULL,
  -- How big an area to watch: small for a spot saved from the phone, larger for an approximate one.
  radius_m    INTEGER NOT NULL DEFAULT 150,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, name)
);

-- "Remind me when I get home": the phone watches the area and tells the server when it arrives or leaves.
CREATE TABLE IF NOT EXISTS place_reminders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT NOT NULL,
  conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
  text             TEXT NOT NULL,
  place_name       TEXT NOT NULL,
  latitude         DOUBLE PRECISION NOT NULL,
  longitude        DOUBLE PRECISION NOT NULL,
  radius_m         INTEGER NOT NULL,
  on_event         TEXT NOT NULL CHECK (on_event IN ('arrive', 'leave')),
  every_time       BOOLEAN NOT NULL DEFAULT false,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'cancelled')),
  last_fired_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS place_reminders_active ON place_reminders (user_id) WHERE status = 'active';

-- The chat that "Ask Jarvis" from Siri continues, so a follow-up a minute later has context.
CREATE TABLE IF NOT EXISTS ask_sessions (
  user_id          TEXT PRIMARY KEY,
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What Jarvis did on the user's accounts (drafts, calendar changes, connected apps), for Settings.
CREATE TABLE IF NOT EXISTS activity (
  id               BIGSERIAL PRIMARY KEY,
  user_id          TEXT NOT NULL,
  conversation_id  UUID,
  kind             TEXT NOT NULL,
  summary          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_user_created ON activity (user_id, created_at DESC);

-- Chats imported from a Claude.ai data export keep the export's id, so importing again skips them.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS import_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS conversations_import_ref ON conversations (user_id, import_ref) WHERE import_ref IS NOT NULL;

-- How long to keep chats, in days since they were last used. NULL keeps them for good.
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS chat_retention_days INTEGER CHECK (chat_retention_days > 0);
-- "How Jarvis should reply": the user's own instructions, sent with every chat.
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS custom_instructions TEXT;

-- "Tell me when Sam replies": a Gmail search checked every few minutes, with a notification for each new match.
CREATE TABLE IF NOT EXISTS mail_watches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT NOT NULL,
  conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
  query            TEXT NOT NULL,
  about            TEXT NOT NULL,
  once             BOOLEAN NOT NULL DEFAULT true,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'cancelled', 'expired')),
  seen_ids         TEXT[] NOT NULL DEFAULT '{}',
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_watches_active ON mail_watches (checked_at) WHERE status = 'active';

-- "Tell me when tickets go on sale": a web page fetched every half hour, with a notification
-- when the words appear (look_for) or, without them, when its text changes.
CREATE TABLE IF NOT EXISTS page_watches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT NOT NULL,
  conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
  url              TEXT NOT NULL,
  look_for         TEXT,
  about            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'cancelled', 'expired')),
  last_hash        TEXT,
  failures         INTEGER NOT NULL DEFAULT 0,
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS page_watches_active ON page_watches (checked_at) WHERE status = 'active';

-- "Snooze this until Monday": emails archived now and put back in the inbox, unread, at due_at.
CREATE TABLE IF NOT EXISTS mail_snoozes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT NOT NULL,
  conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
  message_ids      TEXT[] NOT NULL,
  about            TEXT NOT NULL,
  due_at           TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'snoozed' CHECK (status IN ('snoozed', 'back', 'failed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_snoozes_due ON mail_snoozes (due_at) WHERE status = 'snoozed';
