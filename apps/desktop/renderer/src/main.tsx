import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./settings.css";
import "./theme.css";
import { applyAppearance } from "./preferences.js";
import { defaultPreferences } from "../../shared/preferences.js";

const initialPreferences = await window.xiuDesktop.preferences?.().catch(() => defaultPreferences) ?? defaultPreferences;
applyAppearance(initialPreferences);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App initialPreferences={initialPreferences} />
  </StrictMode>,
);
