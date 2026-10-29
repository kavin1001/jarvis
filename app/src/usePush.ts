import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { Platform } from "react-native";
import { Alert } from "./dialog";
import { api, type Settings } from "./api";

// Push needs a native build; the web version polls instead.
const pushSupported = Platform.OS !== "web";

if (pushSupported) Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Approve / Deny buttons on approval notifications. Approving needs the phone unlocked.
if (pushSupported) Notifications.setNotificationCategoryAsync("approval", [
  { identifier: "approve", buttonTitle: "Approve", options: { opensAppToForeground: true, isAuthenticationRequired: true } },
  { identifier: "deny", buttonTitle: "Deny", options: { opensAppToForeground: true, isDestructive: true } },
]).catch(() => {});

// Snooze buttons on reminders. Each snooze is a new one-off reminder, so a daily one keeps its time.
const SNOOZE: Record<string, number> = { snooze10: 10, snooze60: 60 };
if (pushSupported) Notifications.setNotificationCategoryAsync("reminder", [
  { identifier: "snooze10", buttonTitle: "Snooze 10 min", options: { opensAppToForeground: true } },
  { identifier: "snooze60", buttonTitle: "Snooze 1 hour", options: { opensAppToForeground: true } },
]).catch(() => {});

// Reply from the notification of an answer or a finished task, without opening the chat first.
if (pushSupported) Notifications.setNotificationCategoryAsync("reply", [
  {
    identifier: "reply",
    buttonTitle: "Reply",
    textInput: { submitButtonTitle: "Send", placeholder: "Reply to Jarvis" },
    // Unlock the phone first, so nobody can message Jarvis from a locked phone's lock screen.
    options: { opensAppToForeground: true, isAuthenticationRequired: true },
  },
]).catch(() => {});

export function askApproval(settings: Settings, approvalId: string, summary: string, onDecided?: () => void) {
  const decide = (decision: "allow" | "deny") =>
    api.decide(settings, approvalId, decision).then(onDecided, (err) => Alert.alert("Could not send", String(err)));
  Alert.alert("Jarvis needs your OK", summary, [
    { text: "Deny", style: "destructive", onPress: () => decide("deny") },
    { text: "Approve", onPress: () => decide("allow") },
  ]);
}

type Response = Notifications.NotificationResponse;
const handled = new Set<string>();

/**
 * Registers this device for notifications and handles taps: Approve/Deny
 * and Snooze buttons act right away, a typed Reply is sent in its chat, a
 * plain tap on an approval asks, and anything tied to a conversation opens it.
 */
export function usePush(
  settings: Settings | null,
  onTaskUpdate: () => void,
  onOpenConversation?: (id: string) => void,
  onReply?: (conversationId: string, text: string) => void,
) {
  useEffect(() => {
    if (!settings || !pushSupported) return;
    (async () => {
      if (!Device.isDevice) return;
      const { status } = await Notifications.requestPermissionsAsync();
      const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
      if (status !== "granted" || !projectId) return; // projectId comes from `eas init`
      const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
      await api.pushToken(settings, data);
    })().catch((err) => console.warn("push registration failed", err));

    const received = Notifications.addNotificationReceivedListener(() => onTaskUpdate());
    const handle = (response: Response) => {
      // The cold-start response and the listener can both report the same tap.
      const key = response.notification.request.identifier + response.actionIdentifier;
      if (handled.has(key)) return;
      handled.add(key);
      const data = response.notification.request.content.data as { approvalId?: string; conversationId?: string; reminderId?: string };
      if (response.actionIdentifier === "reply" && data.conversationId && response.userText?.trim()) {
        onReply?.(data.conversationId, response.userText.trim());
        return;
      }
      const snooze = SNOOZE[response.actionIdentifier];
      if (data.reminderId && snooze) {
        api.snoozeReminder(settings, data.reminderId, snooze).then(onTaskUpdate, (err) => Alert.alert("Could not snooze", String(err)));
        return;
      }
      const summary = response.notification.request.content.body ?? "";
      if (data.approvalId && (response.actionIdentifier === "approve" || response.actionIdentifier === "deny")) {
        const decision = response.actionIdentifier === "approve" ? "allow" : "deny";
        api.decide(settings, data.approvalId, decision).then(onTaskUpdate, (err) => Alert.alert("Could not send", String(err)));
        return;
      }
      if (data.approvalId) askApproval(settings, data.approvalId, summary, onTaskUpdate);
      else if (data.conversationId) onOpenConversation?.(data.conversationId);
      onTaskUpdate();
    };
    Notifications.getLastNotificationResponseAsync().then((r) => r && handle(r));
    const tapped = Notifications.addNotificationResponseReceivedListener(handle);
    return () => {
      received.remove();
      tapped.remove();
    };
  }, [settings]);
}
