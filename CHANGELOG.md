# Changelog

Newest first. Each entry matches a merged pull request.

## Unreleased

- Hands-free conversations: tap **Hands-free** in chat, or open `jarvis://listen?handsfree=1`. After each spoken answer Jarvis listens again. The conversation ends when you go quiet or say "stop", "that's all" or "thanks Jarvis".
- Connected apps: add any remote MCP server (URL plus an optional token) in Settings, and Jarvis can use its tools through the Claude API's MCP connector. Tokens are encrypted at rest and never sent back to the app. You can switch servers on and off or remove them. See `docs/MCP.md`.
- App: error messages from the backend now show up in alerts instead of a bare status code.
- Siri, Shortcuts and the Action button: Jarvis opens `jarvis://listen`, `jarvis://ask?text=...&voice=1` and `jarvis://new` links, so "Hey Siri, Jarvis" or one press of the Action button gets you a listening Jarvis. Recipes are in `docs/SHORTCUTS.md`.
- Voice: tap **Talk** for hands-free input that stops when you pause. Holding and releasing still works.
- Gmail and Google Calendar: connect Google in Settings, then ask Jarvis to find emails, read one, draft a reply (saved to Gmail, never sent), check your schedule or add an event. Tokens are encrypted at rest with `CONNECTOR_SECRET`, refresh automatically, and are revoked when you disconnect. Email bodies are marked as untrusted so instructions inside them are ignored. Setup in `docs/DEPLOY.md`.
- Deploy: backend Dockerfile, Render Blueprint (web service + Postgres), EAS build profiles for the app, and a step-by-step guide in `docs/DEPLOY.md`. The schema now applies itself on boot, requests are logged, and the server shuts down cleanly on SIGTERM. CI builds the Docker image.
- Usage and cost: every Claude call is logged with tokens and an estimated cost; background tasks record the list cost Managed Agents reports. Settings shows today's spend, the last 7 days and the month. `DAILY_BUDGET_USD` makes Jarvis pause for the rest of the day once the cap is reached.
- Photos: tap ＋ in chat to take a photo or pick up to 4 from your library and ask Jarvis about them. Images are resized on the phone and uploaded once through the Files API, so long chats don't resend the pixels.
- Reminders and scheduled jobs: "remind me at 5", "every weekday at 8, brief me on the news". Jarvis has `set_reminder`, `list_reminders` and `cancel_reminder` tools; reminders push to your phone, and `run` jobs run the prompt and push the answer. Repeats keep local time across daylight-saving changes and skip missed days after an outage. The Tasks tab lists upcoming ones (tap to cancel).
- Jarvis now knows your local time: the app sends its time zone and each turn carries the current time.
- App: tab bar with History (switch or delete conversations), Tasks (status, results, tap-to-approve, live polling), Memory (see, add and forget facts) and Settings (disconnect). A badge shows approvals waiting on you.
- Backend: `POST /api/facts`, `DELETE /api/conversations/:id`.
- CI: the app's iOS bundle is built on every PR.
- Background tasks survive backend restarts: on boot the server replays each running session's events, picks up approval requests it missed, and finishes tasks that ended while it was down. Approvals go straight to the agent's session, and unanswered ones are denied after `APPROVAL_TIMEOUT_MINUTES`.
- Backend tests (vitest + Postgres): memory, the chat turn loop with a fake Claude client, and HTTP auth and validation. Run in CI.
- CI: type-check backend and app on every push and pull request.
- Docs: roadmap and contributor notes.

## 0.1.0, 2026-10-29

- First scaffold: Expo app with chat, hold-to-talk voice, push and approvals; backend fast lane (streaming Claude API with web search, web fetch and memory tools); Managed Agents task lane with approval gates; Postgres memory.
