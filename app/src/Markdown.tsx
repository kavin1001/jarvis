import { Fragment, type ReactNode } from "react";
import { Linking, Platform, StyleSheet, View, type TextStyle } from "react-native";
import { Text, useStyles, type Palette } from "./theme";

/**
 * A small markdown renderer for assistant replies: headings, bullet and
 * numbered lists, code blocks, **bold**, *italic*, `code` and [links](url).
 * Anything else renders as plain text, so odd input never breaks a bubble.
 */
export function Markdown({ text, style }: { text: string; style?: TextStyle }) {
  const styles = useStyles(makeStyles);
  return <View style={{ gap: 6 }}>{blocks(text).map((b, i) => renderBlock(b, i, styles, style))}</View>;
}

/** The words of a markdown reply without its markup, for reading aloud or sharing as plain text. */
export function plainText(text: string) {
  return text
    .replace(/```[^\n]*\n?/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*|`([^`]+)`|(?<![\w*])\*([^*\s][^*]*?)\*(?!\w)|(?<!\w)_([^_\s][^_]*?)_(?!\w)/g, "$1$2$3$4")
    .trim();
}

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "li"; marker: string; text: string }
  | { kind: "code"; text: string };

function blocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !lines[i].startsWith("```")) code.push(lines[i]);
      out.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const item = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)$/);
    if (heading) {
      flush();
      out.push({ kind: "h", text: heading[1] });
    } else if (item) {
      flush();
      out.push({ kind: "li", marker: /\d/.test(item[1]) ? item[1] : "•", text: item[2] });
    } else if (!line.trim()) {
      flush();
    } else {
      para.push(line);
    }
  }
  flush();
  return out;
}

type Styles = ReturnType<typeof makeStyles>;

function renderBlock(b: Block, key: number, styles: Styles, style?: TextStyle) {
  switch (b.kind) {
    case "code":
      return (
        <Text key={key} style={[styles.codeBlock, style]} selectable>
          {b.text}
        </Text>
      );
    case "h":
      return (
        <Text key={key} style={[style, styles.heading]}>
          {inline(b.text, styles)}
        </Text>
      );
    case "li":
      return (
        <View key={key} style={styles.item}>
          <Text style={[style, styles.marker]}>{b.marker}</Text>
          <Text style={[style, { flex: 1 }]}>{inline(b.text, styles)}</Text>
        </View>
      );
    default:
      return (
        <Text key={key} style={style}>
          {inline(b.text, styles)}
        </Text>
      );
  }
}

const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(?<![\w*])\*([^*\s][^*]*?)\*(?!\w)|(?<!\w)_([^_\s][^_]*?)_(?!\w)/g;

function inline(text: string, styles: Styles): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index;
    if (i > last) out.push(<Fragment key={`t${i}`}>{text.slice(last, i)}</Fragment>);
    const [, bold, code, label, url, star, under] = m;
    if (bold !== undefined) out.push(<Text key={i} style={{ fontWeight: "700" }}>{bold}</Text>);
    else if (code !== undefined) out.push(<Text key={i} style={styles.code}>{code}</Text>);
    else if (label !== undefined)
      out.push(
        <Text key={i} style={styles.link} onPress={() => Linking.openURL(url)}>
          {label}
        </Text>,
      );
    else out.push(<Text key={i} style={{ fontStyle: "italic" }}>{star ?? under}</Text>);
    last = i + m[0].length;
  }
  if (last < text.length) out.push(<Fragment key="end">{text.slice(last)}</Fragment>);
  return out;
}

const mono = Platform.select({ ios: "Menlo", default: "monospace" });
const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    heading: { fontWeight: "700", fontSize: 17 },
    item: { flexDirection: "row", gap: 6 },
    marker: { minWidth: 14 },
    code: { fontFamily: mono, fontSize: 14, backgroundColor: colors.code },
    codeBlock: { fontFamily: mono, fontSize: 13, backgroundColor: colors.code, padding: 8, borderRadius: 6 },
    link: { color: colors.accent, textDecorationLine: "underline" },
  });
