# Changelog

Newest first. Each entry matches a merged pull request.

## Unreleased

- History titles: Jarvis names each new conversation in a few words after its first reply, instead of using the first 60 characters. `TITLE_MODEL` picks the model, defaulting to `FAST_MODEL`.
- Tasks: running tasks show the agent's latest message, and each task shows what it cost.
- Files: tap ＋, then **Choose a file**, to send up to 2 PDFs or text files (txt, md, csv, json) and ask about them. PDFs go through the Files API once, and text goes inline.
- Voice: replies use the best installed voice for your language. Download a Premium or Enhanced Siri voice in iOS Settings, under Accessibility, Spoken Content, Voices, for a more natural Jarvis.
- Web version: the backend now serves the app at its own URL, so you can use Jarvis in a browser, or add it to your iPhone home screen, before setting up an Apple Developer account. It uses browser dialogs and local storage where phones use native ones, and skips push. The Docker image builds it, and CI exports it.
- Chat errors now say what went wrong: a bad API key, rate limiting, or Claude being unreachable.
- Sign-in: an 8-letter app token is no longer mistaken for a pairing code.
- Reliability: overlapping turns in one conversation (a double send, or a scheduled job landing mid-reply) now queue instead of interleaving. `/health` checks the database, so Render restarts a broken instance. Request bodies are size limited (32 MB for chat with photos, 1 MB elsewhere). Errors and unknown routes return JSON without internals. The OAuth page sends secure headers.
- Dependabot opens weekly backend dependency updates.
- Approve or deny a background task's request right from the notification. Approving requires Face ID or your passcode.
- Tapping a task or reminder notification opens its conversation, including when the app was closed.
- Routines: **Add routine** in the Tasks tab sets up a weekday morning briefing or a daily evening wrap-up in one tap. `POST /api/reminders` takes a local `HH:MM` time.
- The backend forgets push tokens for phones that uninstalled the app.
- Location (opt-in): turn on **Share approximate location** in Settings and Jarvis can answer "what's open near me" and "will it rain here". Coordinates are rounded to about 1 km, sent only with your messages, and never delay a message by more than about 3 seconds.
- Formatting: Jarvis's replies render bold, italics, code, lists, headings and tappable links.
- Hold any message to copy it. The mic gives a light haptic tap when it starts.
- Recall across chats: Jarvis has a `search_past_chats` tool, so "what was that restaurant you found last week?" works even in a new conversation. History has a search box that highlights matches and opens the conversation they came from. Search is Postgres full-text with an index.
- Per-device sign-in: the app swaps `JARVIS_APP_TOKEN` for its own device token at setup, and existing installs upgrade on next launch. **Pair another device** in Settings shows a one-time 8-character code that's valid for 10 minutes, and **Signed-in devices** lists each one so you can sign it out. Pairing is rate limited, and "Disconnect this phone" now revokes its token too.
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
