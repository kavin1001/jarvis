# Roadmap

Goal: a personal agent on your phone that answers instantly, remembers you, and can get real work done on your accounts with your approval.

## Built

- **Talk or type:** streaming replies, tap or hold to talk, hands-free conversation, talking over Jarvis stops its speech, the best installed voice, a stop button, a choice of when replies are read aloud and how fast.
- **Knows you:** long-term memory you can edit, shopping, packing and to-do lists you keep by voice or in the Lists tab, notes ("take a note…", or save any reply) you can search and edit, full chat history with search (including chats imported from Claude.ai), conversation titles and renaming, approximate location when you allow it.
- **Your accounts:** Gmail (drafts and forwards with attachments, never sends; archive, labels, snooze, unsubscribe links, save attachments to Drive), Google Calendar (add one-off, repeating and all-day events with optional Meet links, move and delete events, attach docs to them, find free time, reply to invitations, shared calendars) and Google Contacts (look up numbers and addresses, save new ones), Google Drive (search, read Docs, Sheets, Slides and PDFs, make new Docs and Sheets, and add to the ones it made), any MCP server (Notion and Linear with sign-in, GitHub, Zapier, Pipedream…) for both quick answers and background tasks. Changes Jarvis makes to your email, calendar and Drive (archiving, drafts, snoozes, new, moved and deleted events, new docs and sheets, rows added to a sheet, saved attachments) can be undone from Settings for a week.
- **Everyday answers:** weather forecasts for where you are or anywhere else, without a web search.
- **Gets things done:** background tasks on Claude Managed Agents with approve or deny from the notification and files you can open from Tasks, reminders and routines with snooze, alerts when a particular email arrives (or a nudge when it hasn't by a deadline) or a web page changes, reminders for when you arrive or leave a place, a "coming up" card on a new chat, a status line while tools run.
- **Inputs:** photos, camera, PDFs and text files, meeting recordings written up as notes, "Hey Siri, Ask Jarvis" through a Shortcut that speaks the answer, Siri and Shortcuts links, Android share sheet (web app).
- **Phone-ready:** app icon and launch screen, dark mode, device pairing and revoking, an installable web app, an offline banner, and messages sent offline go out once the connection is back, push notifications with quiet hours.
- **Running it:** Docker image and Render blueprint, `/health`, spend tracking with a daily cap, a setup checklist in Settings, data export and erase, CI with backend tests.

## Next

| Feature | Why |
| --- | --- |
| Native App Intents | Siri asks without the Shortcut setup (the Shortcut already answers without opening the app) |
| iOS share extension | Share a link or screenshot to Jarvis from any app on iPhone |
| Streaming speech provider | A more natural voice than the system one |

## Later

- Multi-user accounts (Sign in with Apple) if Jarvis is ever shared
- Widgets (today's reminders and running tasks on the home screen)
- Apple Watch quick ask

## Needs Kavin (can't be done from code alone)

These cost money, need an outside account, or need your credentials. Settings, **Setup** shows which ones the server is still missing.

- [ ] Claude Console API key (`ANTHROPIC_API_KEY`) and a monthly spend limit in the Console; `DAILY_BUDGET_USD` for Jarvis's own cap
- [ ] Hosting for the backend and a Postgres database (Render, Fly, Neon, Supabase…)
- [ ] `CONNECTOR_SECRET`: a long random string, so Google and MCP tokens can be stored encrypted
- [ ] Run `npm run setup-agent` once to create the task agent, and decide on sandbox networking
- [ ] A vault with any website logins you want the task agent to use
- [ ] Apple Developer account for TestFlight and push certificates; `eas init` for the Expo project ID
- [ ] Google OAuth client for Gmail/Calendar connectors (steps in `docs/DEPLOY.md` section 5)
- [ ] Optional: your own app icon in `app/assets/icon.png`
