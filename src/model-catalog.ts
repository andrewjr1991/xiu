import type { ProviderName } from "./config.js";
import { localize, type UiLanguage } from "./i18n.js";
import type { AvailableModel } from "./types.js";

const BUILTIN_MODELS: Record<ProviderName, AvailableModel[]> = {
  agnes: [{ id: "agnes-2.5-flash", name: "Agnes 2.5 Flash", description: "Xiu default text and vision model", source: "builtin" }],
  openai: [{ id: "gpt-5", name: "GPT-5", description: "Xiu default OpenAI model", source: "builtin" }],
  anthropic: [{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", description: "Xiu default Anthropic model", source: "builtin" }],
  "openai-compatible": [],
  ollama: [],
  lmstudio: [],
  vllm: [],
};

const NON_CHAT_MODEL = /embedding|moderation|whisper|transcri|speech|tts|dall-e|image|video|sora|rerank/i;

export function selectableModels(provider: ProviderName, current: string, discovered: AvailableModel[] = [], language: UiLanguage = "en-US"): AvailableModel[] {
  const candidates = discovered.filter((model) => model.id && !NON_CHAT_MODEL.test(model.id));
  const combined: AvailableModel[] = [
    { id: current, name: current, description: localize(language, "当前会话模型", "Current session model"), source: "current" },
    ...candidates,
    ...BUILTIN_MODELS[provider],
  ];
  const unique = new Map<string, AvailableModel>();
  for (const model of combined) {
    const existing = unique.get(model.id);
    if (!existing || existing.source === "builtin" || model.source === "current") unique.set(model.id, model);
  }
  return [...unique.values()].sort((a, b) => {
    if (a.id === current) return -1;
    if (b.id === current) return 1;
    return (a.name ?? a.id).localeCompare(b.name ?? b.id);
  });
}
