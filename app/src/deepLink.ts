import { useEffect, useState } from "react";
import { Linking, Platform } from "react-native";
import { parseLink, type Command } from "./links";

export type { Command };

/** The latest command from a link that opened or re-focused the app. */
export function useDeepLinkCommand() {
  const [command, setCommand] = useState<Command | null>(null);
  useEffect(() => {
    Linking.getInitialURL().then((url) => {
      const command = url && parseLink(url);
      if (!command) return;
      setCommand(command);
      // On the web the link is the page address; drop it so a reload doesn't repeat it.
      if (Platform.OS === "web") history.replaceState(null, "", "/");
    });
    const sub = Linking.addEventListener("url", ({ url }) => setCommand(parseLink(url)));
    return () => sub.remove();
  }, []);
  return command;
}
