# Jarvis

A personal voice and text assistant on your phone, powered by Claude.

```
Jarvis app (Expo)  ──►  backend (Hono + Postgres)  ──►  Fast lane: Claude API, streaming
                                   │                     web search, web fetch, memory, start_task
                                   └──────────────────►  Task lane: Claude Managed Agents session
                                                          sandbox, headless browser, vaulted logins,
                                                          approvals pushed to your phone
```

- **Fast lane:** every message (typed or spoken) goes to the Claude API and streams back. Voice replies are read aloud sentence by sentence.
- **Task lane:** when a request needs logins, forms, bookings or scraping, Claude calls `start_task`. A Managed Agents session does the work in a sandbox and pushes the result to your phone. Before anything irreversible it asks for your approval.
- **Memory:** full conversation history in Postgres (with server-side compaction for long chats), long-term facts Claude saves with `remember`, and task records.

## Layout

| Path | What |
| --- | --- |
| `backend/src/assistant.ts` | Fast lane: streaming turn loop and tools |
| `backend/src/tasks.ts` | Task lane: Managed Agents session runner and approvals |
| `backend/src/memory.ts` | Conversations, messages, facts |
| `backend/src/index.ts` | HTTP API (chat over server-sent events) |
| `backend/schema.sql` | Database schema |
| `backend/scripts/setup-agent.ts` | One-time creation of the task agent and its sandbox |
| `app/` | Expo app (iOS and Android): chat, hold-to-talk voice, push, approvals |

## Run it

To put Jarvis on your phone for real, follow [docs/DEPLOY.md](docs/DEPLOY.md). The steps below are for running it locally.

### Backend

1. Get an API key from the [Claude Console](https://platform.claude.com). A Pro/Max subscription login won't work here.
2. Create a Postgres database (Neon, Supabase, Render or local).
3. Configure and start:

```bash
cd backend
npm install
cp .env.example .env        # fill in ANTHROPIC_API_KEY, DATABASE_URL, JARVIS_APP_TOKEN
node --env-file=.env node_modules/.bin/tsx scripts/migrate.ts
node --env-file=.env node_modules/.bin/tsx src/index.ts
```

4. Task lane (optional until you want background jobs):

```bash
TASK_ALLOWED_HOSTS=example.com,another.com node --env-file=.env node_modules/.bin/tsx scripts/setup-agent.ts
# paste the printed TASK_AGENT_ID and TASK_ENVIRONMENT_ID into .env, then restart
```

By default the task sandbox can only reach package registries and the hosts you list. `--unrestricted` opens the whole internet, which a general assistant usually needs, but then anything running in the sandbox could send data anywhere. Keep logins in a vault (below), never in prompts.

**Website logins:** create a vault in the Console and add each login as an environment-variable credential (for example `AMAZON_PASSWORD`) limited to that site's hosts. The agent only ever sees a placeholder; the real value is swapped in when the request leaves the sandbox. Put the vault ID in `TASK_VAULT_ID`.

### App

```bash
cd app
npm install
npx expo run:ios            # or run:android; needs Xcode / Android Studio
```

Speech recognition and push notifications need a development build, not Expo Go. On first launch, enter your backend URL and `JARVIS_APP_TOKEN`. For push notifications run `npx eas init` once so the app has a project ID.

## Known limits (MVP)

- Single user. The master `JARVIS_APP_TOKEN` is only used once per device: the app trades it, or a pairing code, for its own revocable device token. You can manage devices in Settings. Multi-user accounts are not built yet.
- Voice uses on-device speech recognition and the phone's built-in voice. A streaming speech provider would sound better.
- The fast lane defaults to `claude-opus-5-5` at low effort. Set `FAST_MODEL=claude-sonnet-5-5` if replies feel slow.
