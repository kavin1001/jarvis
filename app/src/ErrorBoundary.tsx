import { Component, type ErrorInfo, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { reportError } from "./crashReport";
import { Text, useStyles, type Palette } from "./theme";

/**
 * Catches a crash while drawing the screen, so Jarvis shows a way back instead of a blank screen,
 * and sends the error to the server logs.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const where = info.componentStack ? `\nComponents:${info.componentStack.slice(0, 2000)}` : "";
    const withStack = Object.assign(new Error(error.message), { stack: `${error.stack ?? ""}${where}` });
    reportError(withStack, "render", true);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <Fallback label={this.props.label} message={this.state.error.message} onRetry={() => this.setState({ error: null })} />;
  }
}

function Fallback({ label, message, onRetry }: { label?: string; message: string; onRetry: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.box} accessibilityRole="alert">
      <Text style={styles.title}>{label ? `${label} hit a problem` : "Jarvis hit a problem"}</Text>
      <Text style={styles.message} numberOfLines={4}>
        {message}
      </Text>
      <Text style={styles.note}>The details are sent to your server's logs. Your chats and settings are safe.</Text>
      <Pressable style={styles.button} onPress={onRetry} accessibilityRole="button">
        <Text style={styles.buttonText}>Try again</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    box: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 10, backgroundColor: colors.background },
    title: { fontSize: 20, fontWeight: "600", textAlign: "center" },
    message: { color: colors.muted, textAlign: "center" },
    note: { color: colors.muted, textAlign: "center" },
    button: { backgroundColor: colors.accent, borderRadius: 20, paddingHorizontal: 22, paddingVertical: 10, marginTop: 6 },
    buttonText: { color: colors.onAccent, fontWeight: "600" },
  });
