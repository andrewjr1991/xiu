import type { ProviderName } from "./config.js";
import { localize, type UiLanguage } from "./i18n.js";
import type { AvailableModel } from "./types.js";

const BUILTIN_MODELS: Record<ProviderName, AvailableModel[]> = {
  agnes: [{ id: "agnes-2.5-flash", name: "Agnes 2.5 Flash", description: "Xiu default text and vision model", source: "builtin" }],
  openai: [{ id: "gpt-5", name: "GPT-5", description: "Xiu default OpenAI model", source: "builtin" }],
  anthropic: [
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", description: "Xiu default Anthropic model", source: "builtin" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", description: "Faster Anthropic model", source: "builtin" },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", description: "Smallest Anthropic model", source: "builtin" },
  ],
  "openai-compatible": [],
  ollama: [],
  lmstudio: [],
  vllm: [],
};

const NON_CHAT_MODEL = /embedding|moderation|whisper|transcri|speech|tts|dall-e|image|video|sora|rerank/i;
export type ModelCapability = "text" | "vision" | "image" | "video" | "audio";

const CAPABILITY_PATTERNS: Record<Exclude<ModelCapability, "text">, RegExp> = {
  vision: /vision|\bvl\b|multimodal|omni|gpt-4o|claude|gemini/i,
  image: /dall-e|image|imagen|flux|stable[-_. ]?diffusion|midjourney/i,
  video: /video|sora|veo|kling|hailuo|runway|\bwan(?:[._-]|$)/i,
  audio: /audio|speech|tts|voice|music|whisper|transcri|cosyvoice|eleven/i,
};

export function modelSupportsCapability(model: AvailableModel, capability: ModelCapability): boolean {
  const declared = model.capabilities?.map((item) => item.toLowerCase()) ?? [];
  if (declared.includes(capability)) return true;
  if (capability === "text") return !NON_CHAT_MODEL.test(model.id);
  return CAPABILITY_PATTERNS[capability].test(`${model.id} ${model.name ?? ""} ${model.description ?? ""}`);
}

export function visionCapabilityEvidence(model: AvailableModel): "declared" | "inferred" | "unknown" {
  if (model.capabilities?.some((item) => item.toLowerCase() === "vision")) return "declared";
  return modelSupportsCapability(model, "vision") ? "inferred" : "unknown";
}

export function selectableCapabilityModels(capability: Exclude<ModelCapability, "text">, current: string | undefined, discovered: AvailableModel[] = []): Array<AvailableModel & { capabilityEvidence?: "declared" | "inferred" | "unknown" }> {
  const combined = [
    ...(current ? [{ id: current, name: current, description: "Configured model", source: "current" as const }] : []),
    ...discovered.filter((model) => model.id && (modelSupportsCapability(model, capability)
      || (capability === "vision" && modelSupportsCapability(model, "text")
        && (!model.capabilities?.some((item) => ["image", "video", "audio"].includes(item.toLowerCase()))
          || model.capabilities?.some((item) => item.toLowerCase() === "text"))))),
  ];
  const unique = new Map<string, AvailableModel>();
  for (const model of combined) {
    const existing = unique.get(model.id);
    if (!existing) unique.set(model.id, model);
    else if (existing.source === "current") unique.set(model.id, { ...model, source: "current" });
  }
  return [...unique.values()].sort((a, b) => a.id === current ? -1 : b.id === current ? 1 : (a.name ?? a.id).localeCompare(b.name ?? b.id))
    .map((model) => capability === "vision" ? { ...model, capabilityEvidence: visionCapabilityEvidence(model) } : model);
}

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
