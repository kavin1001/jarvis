# Changelog

Newest first. Each entry matches a merged pull request.

## Unreleased

- Reliability: the server keeps running when the database restarts for maintenance or a background job fails unexpectedly. Before, either one could stop the whole server until the host restarted it. Requests now give up after 10 seconds while the database can't be reached, instead of hanging.
- Follow up on a finished background task: "now book the cheapest one" goes back to the same agent, which still has everything it found. The task shows as running again, and you get a notification when it's done. Connected-app sign-ins aren't passed to a follow-up; start a new task when it needs them.
- Timers: "set a timer for 10 minutes" goes off within a few seconds of the right time. Jarvis now schedules "in N minutes" from the exact second, and the server checks for due reminders every 5 seconds instead of every 30.
- Settings, **Notifications**: turn off notifications for replies, finished tasks or spending. Approvals and reminders always notify. `GET` and `PATCH /api/notifications`.
- Background tasks can hand you files. When the agent makes a spreadsheet, report, chart or document, it shows up under the task in **Tasks**. Tap it to save or share it from the phone's share sheet, or to download it in a browser. The finished-task message lists the file names, and **Erase everything** deletes the files too. Needs a new app build, since it adds `expo-sharing`.
- Spending: with `DAILY_BUDGET_USD` set, Jarvis sends one notification a day when today's spend passes 80% of the cap, so the cap doesn't arrive mid-task as a surprise. Background-task costs count too.
- "Call Mom", "text Sam I'm running late", "email Ana": Jarvis answers with a tappable 📞, 💬 or ✉️ link that opens your phone's dialer, Messages or Mail with everything filled in. Nothing is dialed or sent until you confirm on the phone. Jarvis only uses numbers and addresses you gave it or it saved.
- Tables in replies (flights, prices, comparisons) show as real tables with a header row, and scroll sideways when they're wide. Read aloud, a table is spoken one row at a time, without the pipes and dashes.
- Web app on a computer: **Enter** sends and **Shift+Enter** starts a new line. The cursor goes back to the message box once Jarvis has replied.
- Reply from the notification: on a "Jarvis replied", finished-task or routine notification, press and hold (or swipe down) and choose **Reply**. What you type is sent in that chat. A message sent from a link or a notification while the chat is still loading no longer disappears.
- Gmail: Jarvis can archive, mark read or unread, and star email, up to 50 at a time ("archive all the newsletters from this week"). Nothing is deleted. If you connected Google before this change, Settings asks you to **Connect again** to grant the new permission, and the Google consent screen needs the `gmail.modify` scope (docs/DEPLOY.md, section 5).
- Settings, **Lock Jarvis** (iPhone and Android): Jarvis asks for Face ID, Touch ID or your passcode when you open it, and again after more than a minute away. The app switcher shows a blank screen instead of your chats. A reply that's still coming in keeps going behind the lock. Needs a new app build, since it adds a native module.
- History is no longer cut off at 50 chats: **Load older chats** at the bottom brings in the next 50. `GET /api/conversations` takes `?before=&before_id=` from the last chat shown. A malformed id in a URL now gets a 404 instead of a server error, and a body that isn't JSON gets a 400.
- History: hold a chat and choose **Pin to top** to keep it above newer chats, marked 📌. `PATCH /api/conversations/:id` takes `{ pinned }` as well as `{ title }`.
- Calendar: Jarvis can move, rename and delete events ("push my 3pm to 4"). Moving only the start keeps the event's length. Guests aren't notified, as with new events, and Jarvis deletes an event only when you've clearly asked.
- Offline: messages you send while the server can't be reached wait above the message box and go out by themselves, in order, once it answers again (while the app stays open). Tap one to take it back and edit it. Before, the message went back into the box for you to send again.
- Memory: tap a fact to **Edit** or **Forget** it. When something about you changes ("I moved to Boston"), Jarvis now corrects the saved fact instead of keeping both. `PATCH /api/facts/:id` takes `{ fact }`.
- Settings has **Read replies aloud** (when you speak, always, or never) and **Speaking speed** (slower to fastest, with a sample when you pick one). Replies are read without Markdown symbols, voice input follows your phone's language and region, and speech no longer waits forever in browsers that have no voice list.
- A new chat's coming-up card also shows your next calendar events when Google is connected. `GET /api/agenda` returns them.
- Lock your phone or switch apps mid-reply and Jarvis still finishes. The answer arrives as a "Jarvis replied" notification, and it's in the chat when you come back. Only the Stop button stops a reply now, through `POST /api/conversations/:id/stop`.
- Security: after 20 failed sign-ins in a minute from one address, the API answers 429 for the rest of that minute, which makes a short `JARVIS_APP_TOKEN` much harder to guess. Every response now has standard security headers. Rate limits use the address your host's proxy adds, which a client can't fake.
- Stop a background task: open it in Tasks and tap **Stop this task**, or ask Jarvis ("stop the price watch"). Jarvis interrupts the agent, closes any approval it was waiting on, and notes it in the chat. Tasks have a new **Cancelled** status, and `POST /api/tasks/:id/cancel` does the same.
- History: hold a chat and choose **Share transcript** to send the whole conversation as text. Browsers without a share sheet copy it instead. VoiceOver and TalkBack read each message as "You: …" or "Jarvis: …", and offer the copy, read aloud and share actions. Buttons in the chat screen are labelled.
- Connected apps: servers that use OAuth, such as Notion's and Linear's hosted MCP servers, can now be added without a token. Jarvis opens their sign-in page, registers itself, and keeps the token refreshed. This needs `PUBLIC_URL` and `CONNECTOR_SECRET`.
- Offline: when the server can't be reached, a banner says so, with **Retry**, and clears by itself once the server answers again. A message that never reached the server goes back into the message box, photos and files included, so you can send it again.
- While Jarvis works, a line under the chat says what it's doing: "Searching the web…", "Checking your calendar…", "Using notion…". Tapping the mic while Jarvis is speaking now stops the speech, so you can talk over it.
- A new chat shows what's coming up: reminders in the next 24 hours, and background tasks that are working or waiting for your OK.
- Reminder notifications have **Snooze 10 min** and **Snooze 1 hour** buttons. A snooze makes a one-off copy, so a daily reminder keeps its usual time. `POST /api/reminders/:id/snooze` takes `{ minutes }`.
- Settings, **Setup** shows what the server has ready and what's left, with the fix for each item: a working API key, a daily spending cap, background tasks, token encryption, Google, and notifications. A rejected API key is shown straight away. `GET /api/status` returns the same checks, as booleans only.
- Hold a message for **Copy**, **Read aloud** and **Share**. Your own messages also get **Send again**. Hold a chat in History to **Rename** or **Delete** it. `PATCH /api/conversations/:id` sets a title.
- Jarvis has an app icon and a launch screen. Added to an iPhone home screen, the web version opens full screen with that icon. On Android it installs from Chrome and shows up in the share sheet: sharing a link or text to Jarvis puts it in the message box. The web app also takes `/ask?text=`, `/listen` and `/new` links, like the `jarvis://` ones.
- Background tasks can use your connected apps (MCP servers) too. Each tool call asks for your OK first, and a server's token is kept in a vault that exists only while the task runs.
- Signed-in devices: a browser sign-in is listed by browser and system, such as "Chrome on Mac" or "Safari on iPhone", instead of always "Safari".
- **Dark mode**: Jarvis follows your phone's light or dark setting. Settings, **Appearance**, lets you pick Light or Dark instead.
- A new chat shows suggestions you can tap, such as "What's on my calendar today?", so it is clear what Jarvis can do.
- **Stop**: while Jarvis is answering, the Send/Talk button becomes Stop. The part already shown is kept in history, so the next message picks up from what you saw.
- Your data: Settings, **Export as JSON** downloads every conversation, fact, reminder, task and connected app, with no secrets included. **Erase everything** deletes all of it and disconnects Google. Your devices and spend history stay.
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
