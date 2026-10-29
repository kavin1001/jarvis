import { useEffect, useState } from "react";
import { Linking } from "react-native";
import { parseLink, type Command } from "./links";

export type { Command };

/** The latest command from a link that opened or re-focused the app. */
export function useDeepLinkCommand() {
  const [command, setCommand] = useState<Command | null>(null);
  useEffect(() => {
    Linking.getInitialURL().then((url) => url && setCommand(parseLink(url)));
    const sub = Linking.addEventListener("url", ({ url }) => setCommand(parseLink(url)));
    return () => sub.remove();
  }, []);
  return command;
}
