# Roadmap

Goal: a personal agent on your phone that answers instantly, remembers you, and can get real work done on your accounts with your approval.

## In progress / next

| Feature | Why |
| --- | --- |
| Backend tests in CI | Catch regressions overnight without a phone |
| Resume background tasks after a restart | Today a restart strands a task waiting for approval |
| App: conversation list, memory screen, tasks screen | See and manage what Jarvis knows and is doing |
| Reminders and scheduled jobs | "Remind me at 5" and "every morning, brief me" |
| Photos and camera input | Ask about what you're looking at |
| Usage and cost tracking | Know what Jarvis costs per day |
| Deploy setup (Docker, Render blueprint) | Run the backend somewhere your phone can reach |
| Gmail and Calendar connectors | Read your inbox and schedule; draft, don't send |
| Siri / Shortcuts / Action button links, tap-to-talk | Reach Jarvis without opening the app |
| Connected apps via MCP servers | Plug in GitHub, Zapier and other tools without new code |

## Later

- OAuth sign-in for MCP servers that need it (Notion, Linear)
- Give the background task agent the same MCP servers
- Sign in with Apple/Google instead of the shared app token
- Streaming speech provider for more natural voice; continuous conversation mode
- Native App Intents so Siri answers without opening the app
- Share sheet: send a link or screenshot to Jarvis

## Needs Kavin (can't be done from code alone)

These cost money, need an outside account, or need your credentials:

- [ ] Claude Console API key (`ANTHROPIC_API_KEY`) and a monthly spend limit
- [ ] Hosting for the backend and a Postgres database (Render, Fly, Neon, Supabase…)
- [ ] Run `npm run setup-agent` once to create the task agent, and decide on sandbox networking
- [ ] A vault with any website logins you want the task agent to use
- [ ] Apple Developer account for TestFlight and push certificates; `eas init` for the Expo project ID
- [ ] Google OAuth client for Gmail/Calendar connectors (steps in `docs/DEPLOY.md` section 5)
