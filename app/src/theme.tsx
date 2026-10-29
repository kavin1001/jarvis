import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Text as RNText,
  TextInput as RNTextInput,
  useColorScheme,
  type TextInputProps,
  type TextProps,
} from "react-native";
import * as storage from "./storage";

const light = {
  background: "#ffffff",
  text: "#0f172a",
  subtle: "#334155",
  muted: "#64748b",
  accent: "#2563eb",
  onAccent: "#ffffff",
  danger: "#dc2626",
  border: "#e2e8f0",
  inputBorder: "#cbd5e1",
  surface: "#f1f5f9",
  code: "#e2e8f0",
  warning: "#fef3c7",
  warningText: "#92400e",
};
export type Palette = typeof light;

const dark: Palette = {
  background: "#0b1120",
  text: "#e2e8f0",
  subtle: "#cbd5e1",
  muted: "#94a3b8",
  accent: "#3b82f6",
  onAccent: "#ffffff",
  danger: "#f87171",
  border: "#1e293b",
  inputBorder: "#334155",
  surface: "#1e293b",
  code: "#334155",
  warning: "#422006",
  warningText: "#fcd34d",
};

export type Appearance = "system" | "light" | "dark";
const APPEARANCE_KEY = "jarvis-appearance";

type Theme = { colors: Palette; scheme: "light" | "dark"; appearance: Appearance; setAppearance: (a: Appearance) => void };
const ThemeContext = createContext<Theme>({ colors: light, scheme: "light", appearance: "system", setAppearance: () => {} });

/** Follows the phone's light or dark setting unless the user picked one in Settings. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [appearance, setAppearanceState] = useState<Appearance>("system");
  useEffect(() => {
    storage.getItemAsync(APPEARANCE_KEY).then((a) => {
      if (a === "light" || a === "dark") setAppearanceState(a);
    });
  }, []);
  const theme = useMemo<Theme>(() => {
    const scheme = appearance === "system" ? (system === "dark" ? "dark" : "light") : appearance;
    return {
      colors: scheme === "dark" ? dark : light,
      scheme,
      appearance,
      setAppearance: (a) => {
        setAppearanceState(a);
        if (a === "system") storage.deleteItemAsync(APPEARANCE_KEY);
        else storage.setItemAsync(APPEARANCE_KEY, a);
      },
    };
  }, [system, appearance]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
export const useColors = () => useContext(ThemeContext).colors;

// One stylesheet per palette for each factory, built on first use.
const cache = new WeakMap<object, Map<Palette, unknown>>();
export function useStyles<T>(make: (c: Palette) => T): T {
  const colors = useColors();
  let byPalette = cache.get(make);
  if (!byPalette) cache.set(make, (byPalette = new Map()));
  if (!byPalette.has(colors)) byPalette.set(colors, make(colors));
  return byPalette.get(colors) as T;
}

/** Text in the theme's color, so nothing renders black on a dark background. */
export function Text(props: TextProps) {
  const colors = useColors();
  return <RNText {...props} style={[{ color: colors.text }, props.style]} />;
}

export function TextInput(props: TextInputProps) {
  const colors = useColors();
  return <RNTextInput placeholderTextColor={colors.muted} {...props} style={[{ color: colors.text }, props.style]} />;
}
