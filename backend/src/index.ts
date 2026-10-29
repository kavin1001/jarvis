import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { runTurn } from "./assistant.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { migrate } from "./migrate.js";
import { fireDueReminders } from "./reminders.js";
import { expireApprovals, resumeTasks, taskLaneConfigured } from "./tasks.js";

await migrate();

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Jarvis backend listening on http://localhost:${info.port}`);
});

const timers: NodeJS.Timeout[] = [];

if (taskLaneConfigured()) {
  resumeTasks().then(
    (n) => n > 0 && console.log(`Resumed ${n} background task(s)`),
    (err) => console.error("could not resume tasks", err),
  );
  timers.push(setInterval(() => expireApprovals().catch((err) => console.error("approval sweep failed", err)), 60_000));
}

const runScheduled = (conversationId: string, text: string) =>
  runTurn({ conversationId, text, source: "scheduled", emit: () => {} });
// Every 5 seconds, so a "10 minute timer" goes off on time. Each reminder is claimed
// in one UPDATE, so overlapping sweeps can't fire it twice.
timers.push(setInterval(() => fireDueReminders(runScheduled).catch((err) => console.error("reminder sweep failed", err)), 5_000));

// Hosts send SIGTERM before replacing the instance; in-flight tasks resume on the next boot.
process.on("SIGTERM", () => {
  console.log("Shutting down");
  timers.forEach(clearInterval);
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10_000).unref();
});
