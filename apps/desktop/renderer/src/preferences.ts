import { createContext, useContext } from "react";
import { defaultPreferences, type DesktopPreferences } from "../../shared/preferences.js";
export const PreferencesContext = createContext<DesktopPreferences>(defaultPreferences);
export const usePreferences = () => useContext(PreferencesContext);
export function applyAppearance(p: DesktopPreferences): void {
  const root = document.documentElement;
  root.dataset.theme = p.theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : p.theme;
  root.dataset.density = p.density;
  root.dataset.motion = p.reducedMotion ? "reduced" : "system";
  root.style.setProperty("--ui-scale", String(p.fontSize / 14));
  root.style.setProperty("--code-size", `${p.codeSize}px`);
}
