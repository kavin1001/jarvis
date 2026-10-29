import { Linking, Pressable, View } from "react-native";
import type { WebSource } from "./api";
import { Text, useColors } from "./theme";

const site = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** The web pages a reply cites, under the reply: tap one to open it. */
export function Sources({ sources }: { sources: WebSource[] }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }} accessibilityLabel="Sources">
      {sources.map((s, i) => (
        <Pressable
          key={s.url}
          onPress={() => Linking.openURL(s.url).catch(() => {})}
          accessibilityRole="link"
          accessibilityLabel={`Source ${i + 1}: ${s.title}`}
          style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3, maxWidth: 220 }}
        >
          <Text style={{ fontSize: 12, color: colors.muted }} numberOfLines={1}>
            {i + 1} · {site(s.url)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
