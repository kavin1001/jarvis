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
