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
  repeat          TEXT CHECK (repeat IN ('daily', 'weekdays', 'weekly')),
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  status          TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'done', 'cancelled')),
  last_fired_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (due_at) WHERE status = 'scheduled';

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
