import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { Alert } from "react-native";
import { api, type Settings } from "./api";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export function askApproval(settings: Settings, approvalId: string, summary: string, onDecided?: () => void) {
  const decide = (decision: "allow" | "deny") =>
    api.decide(settings, approvalId, decision).then(onDecided, (err) => Alert.alert("Could not send", String(err)));
  Alert.alert("Jarvis needs your OK", summary, [
    { text: "Deny", style: "destructive", onPress: () => decide("deny") },
    { text: "Approve", onPress: () => decide("allow") },
  ]);
}

/** Registers this device for task notifications and handles taps on approval requests. */
export function usePush(settings: Settings | null, onTaskUpdate: () => void) {
  useEffect(() => {
    if (!settings) return;
    (async () => {
      if (!Device.isDevice) return;
      const { status } = await Notifications.requestPermissionsAsync();
      const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
      if (status !== "granted" || !projectId) return; // projectId comes from `eas init`
      const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
      await api.pushToken(settings, data);
    })().catch((err) => console.warn("push registration failed", err));

    const received = Notifications.addNotificationReceivedListener(() => onTaskUpdate());
    const tapped = Notifications.addNotificationResponseReceivedListener((response) => {
      const { approvalId } = response.notification.request.content.data as { approvalId?: string };
      const summary = response.notification.request.content.body ?? "";
      if (approvalId) askApproval(settings, approvalId, summary, onTaskUpdate);
      onTaskUpdate();
    });
    return () => {
      received.remove();
      tapped.remove();
    };
  }, [settings]);
}
