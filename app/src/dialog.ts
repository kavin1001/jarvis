import { Alert as NativeAlert, Platform, type AlertButton } from "react-native";

/**
 * Alert.alert on phones. react-native-web's Alert does nothing, so the web
 * build falls back to the browser's alert / confirm / prompt dialogs.
 */
function alert(title: string, message?: string, buttons?: AlertButton[]) {
  if (Platform.OS !== "web") return NativeAlert.alert(title, message, buttons);
  const text = message ? `${title}\n\n${message}` : title;
  const actions = (buttons ?? []).filter((b) => b.style !== "cancel");
  if (actions.length === 0) return window.alert(text);
  if (actions.length === 1) {
    if (window.confirm(`${text}\n\nOK: ${actions[0].text}`)) actions[0].onPress?.();
    return;
  }
  const choice = window.prompt(`${text}\n\n${actions.map((b, i) => `${i + 1}. ${b.text}`).join("\n")}\n\nType a number:`);
  actions[Number(choice) - 1]?.onPress?.();
}

export const Alert = { alert };
