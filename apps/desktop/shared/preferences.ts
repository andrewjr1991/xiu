/** Non-secret desktop preferences only. Never contains execution authority. */
export interface DesktopPreferences {
  theme: "system" | "light" | "dark";
  fontSize: number;
  codeSize: number;
  density: "comfortable" | "compact";
  reducedMotion: boolean;
  autoFollow: boolean;
  processExpanded: boolean;
  alertsExpanded: boolean;
  sendKey: "enter" | "ctrl-enter";
  notifyComplete: boolean;
  notifyFailure: boolean;
  notifyApproval: boolean;
  sound: boolean;
}
export const defaultPreferences: DesktopPreferences = {
  theme: "system", fontSize: 14, codeSize: 12, density: "comfortable", reducedMotion: false,
  autoFollow: true, processExpanded: true, alertsExpanded: false, sendKey: "enter",
  notifyComplete: false, notifyFailure: false, notifyApproval: false, sound: false,
};
export function parsePreferences(value: unknown): DesktopPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("无效的桌面偏好。");
  const input = value as Record<string, unknown>;
  const result = { ...defaultPreferences };
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(defaultPreferences, key)) throw new Error("未知的桌面偏好。");
    const item = input[key];
    if (key === "fontSize" || key === "codeSize") {
      if (!Number.isInteger(item) || Number(item) < 11 || Number(item) > 20) throw new Error("字号应为 11–20。");
    } else if (key === "theme" ? typeof item !== "string" || !["system", "light", "dark"].includes(item)
      : key === "density" ? typeof item !== "string" || !["comfortable", "compact"].includes(item)
      : key === "sendKey" ? typeof item !== "string" || !["enter", "ctrl-enter"].includes(item)
      : typeof item !== "boolean") throw new Error("桌面偏好值无效。");
    Object.assign(result, { [key]: item });
  }
  return result;
}
