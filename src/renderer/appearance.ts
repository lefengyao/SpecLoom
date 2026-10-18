import {
  accents,
  defaultPreferences,
  type Preferences,
} from "../shared/preferences";

/**
 * Applies the appearance preferences to the document root. Every theme token is
 * derived from `--accent-base`, so the renderer only ever writes that one color.
 */

const cacheKey = "specloom.appearance";

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function resolveTheme(
  mode: Preferences["theme"],
  prefersDark: boolean,
): "paper" | "light" | "dark" {
  return mode === "system" ? (prefersDark ? "dark" : "light") : mode;
}

export function applyAppearance(preferences: Preferences): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(preferences.theme, systemPrefersDark());
  root.dataset.style = preferences.style;
  root.style.setProperty("--accent-base", accents[preferences.accent].color);
  try {
    localStorage.setItem(
      cacheKey,
      JSON.stringify({
        theme: preferences.theme,
        accent: preferences.accent,
        style: preferences.style,
      }),
    );
  } catch {
    /* A blocked storage only costs a flash of the default theme. */
  }
}

/**
 * Re-applies the cached appearance before the first paint so a dark-mode window
 * never flashes light while the preferences are still being read over IPC.
 */
export function bootstrapAppearance(): void {
  let cached: Partial<Preferences> = {};
  try {
    cached = JSON.parse(localStorage.getItem(cacheKey) ?? "{}") as Partial<Preferences>;
  } catch {
    cached = {};
  }
  applyAppearance({ ...defaultPreferences, ...cached });
}

/**
 * Keeps "follow system" live. Returns the unsubscribe handle; the caller replaces
 * it whenever the preferences change.
 */
export function watchSystemTheme(getPreferences: () => Preferences): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return () => undefined;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  if (typeof media.addEventListener !== "function") return () => undefined;
  const listener = () => applyAppearance(getPreferences());
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
