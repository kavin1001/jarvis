import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { api, type ServerStatus, type Settings } from "../api";
import { Text, useColors } from "../theme";
import { useShared } from "../ui";

interface Item {
  ok: boolean;
  /** Something Jarvis can't work without, rather than an optional extra. */
  required?: boolean;
  label: string;
  fix: string;
}

const CLAUDE_FIX: Record<Exclude<ServerStatus["claude"], "ok">, string> = {
  invalid_key: "The server's API key was rejected. Set ANTHROPIC_API_KEY to a key from the Claude Console.",
  no_access: "This API key can't use the chat model. Check the key's workspace in the Claude Console.",
  model_not_found: "FAST_MODEL names a model that doesn't exist. Remove it to use the default.",
  unreachable: "The server can't reach the Claude API. Check its network.",
  error: "The Claude API returned an error. Try again in a minute.",
};

function items(s: ServerStatus): Item[] {
  return [
    {
      ok: s.claude === "ok",
      required: true,
      label: s.claude === "ok" ? `Claude API (${s.fast_model})` : "Claude API",
      fix: s.claude === "ok" ? "" : CLAUDE_FIX[s.claude],
    },
    {
      ok: s.daily_budget_usd !== null,
      label: "Daily spending cap",
      fix: "Set DAILY_BUDGET_USD on the server so Jarvis stops for the day at a dollar amount.",
    },
    {
      ok: s.task_lane,
      label: "Background tasks",
      fix: "Run npm run setup-agent in backend/ and set TASK_AGENT_ID and TASK_ENVIRONMENT_ID (README, step 4).",
    },
    {
      ok: s.connector_secret,
      label: "Encrypted tokens",
      fix: "Set CONNECTOR_SECRET to a long random string so Jarvis can store Google and app tokens.",
    },
    {
      ok: s.public_url,
      label: "Sign-in links",
      fix: "Set PUBLIC_URL to the server's https address, so Google and app sign-ins can return to Jarvis.",
    },
    {
      ok: s.google,
      label: "Gmail and Google Calendar",
      fix: "Add a Google OAuth client: docs/DEPLOY.md, section 5.",
    },
    {
      ok: s.push_devices > 0,
      label: "Notifications",
      fix:
        Platform.OS === "web"
          ? "Notifications need the iPhone or Android app."
          : "Allow notifications for Jarvis, and run eas init once for the push project ID.",
    },
  ];
}

/** Settings section: what the server has set up and what's left, with the fix for each. */
export function SetupStatus({ settings, refreshKey }: { settings: Settings; refreshKey: number }) {
  const styles = useShared();
  const colors = useColors();
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => api.status(settings).then(setStatus, () => setStatus(null)), [settings]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);
  if (!status) return null;

  const list = items(status);
  const missing = list.filter((i) => !i.ok);
  const blocking = missing.some((i) => i.required);
  const summary = missing.length === 0 ? "Everything is set up" : `${missing.length} thing${missing.length === 1 ? "" : "s"} left to set up`;
  // A broken API key is shown straight away; optional extras wait for a tap.
  const expanded = open || blocking;

  return (
    <View style={[styles.row, blocking && { backgroundColor: colors.warning }]}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded }}>
        <Text style={styles.rowMeta}>Setup</Text>
        <Text style={[styles.rowTitle, blocking && { color: colors.warningText }]}>
          {missing.length === 0 ? "✓ " : ""}
          {summary} {expanded ? "▾" : "▸"}
        </Text>
      </Pressable>
      {expanded &&
        list.map((i) => (
          <View key={i.label} style={{ flexDirection: "row", gap: 8, paddingTop: 6 }}>
            <Text style={{ color: i.ok ? colors.accent : i.required ? colors.danger : colors.muted, width: 16 }}>{i.ok ? "✓" : i.required ? "✕" : "○"}</Text>
            <View style={{ flex: 1 }}>
              <Text>{i.label}</Text>
              {!i.ok && <Text style={styles.rowMeta}>{i.fix}</Text>}
            </View>
          </View>
        ))}
    </View>
  );
}
