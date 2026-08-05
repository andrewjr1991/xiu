import fs from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "./config.js";
import { createMediaBackend, type MediaBackend, type VideoTask } from "./media.js";
import { resolveWorkspacePath } from "./tools.js";
import type { AgentTool } from "./types.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const RATIOS = new Set(["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"]);

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function optionalStrings(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new Error(`${key} must be an array of strings`);
  return value as string[];
}

function mimeFor(file: string): string {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  throw new Error(`Unsupported image type: ${extension || "none"}`);
}

async function imageSource(cwd: string, value: string): Promise<string> {
  if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return value;
  const target = resolveWorkspacePath(cwd, value);
  const bytes = await fs.readFile(target);
  return `data:${mimeFor(target)};base64,${bytes.toString("base64")}`;
}

async function saveAsset(cwd: string, outputPath: string, bytes: Buffer): Promise<string> {
  const target = resolveWorkspacePath(cwd, outputPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return path.relative(cwd, target);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Task cancelled."));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Task cancelled."));
    }, { once: true });
  });
}

function completed(task: VideoTask): boolean {
  return ["completed", "succeeded", "success"].includes(task.status);
}

function failed(task: VideoTask): boolean {
  return ["failed", "error", "cancelled", "canceled"].includes(task.status);
}

export function createMediaTools(config: AgentConfig, suppliedBackend?: MediaBackend): AgentTool[] {
  let backend = suppliedBackend;
  const getBackend = (): MediaBackend => backend ??= createMediaBackend(config);
  const models = config.capabilities ?? {
    text: config.model,
    vision: config.model,
    image: "agnes-image-2.1-flash",
    video: "agnes-video-v2.0",
  };

  const tools: AgentTool[] = [];
  if (suppliedBackend?.analyzeImage || config.provider === "agnes" || config.provider === "openai" || config.provider === "anthropic") tools.push({
      name: "analyze_image",
      description: "Analyze a workspace image or public image URL with the configured vision model. Use this when visual inspection is needed.",
      risk: "execute",
      inputSchema: {
        type: "object",
        properties: { source: { type: "string", description: "Workspace-relative image path, public URL, or image data URI" }, prompt: { type: "string" } },
        required: ["source", "prompt"], additionalProperties: false,
      },
      describe: (input) => `send ${String(input.source)} to vision model ${models.vision}`,
      isVerification: (_input, result) => /^Vision model:/.test(result),
      async execute(input, context) {
        const source = await imageSource(context.cwd, requiredString(input, "source"));
        const result = await getBackend().analyzeImage!(requiredString(input, "prompt"), source, context.signal);
        return `Vision model: ${models.vision}\n${result}`;
      },
    });
  if ((suppliedBackend?.generateImage && suppliedBackend.download) || (config.provider === "agnes" && Boolean(models.image))) tools.push({
      name: "generate_image",
      description: "Generate or edit an image with the configured image model and save it in the workspace. Reference images may be workspace paths, URLs, or data URIs.",
      risk: "execute",
      changesWorkspace: true,
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          output_path: { type: "string", description: "Workspace-relative .png, .jpg, .jpeg, or .webp path" },
          size: { type: "string", enum: ["1K", "2K", "3K", "4K"], default: "1K" },
          ratio: { type: "string", enum: [...RATIOS], default: "1:1" },
          reference_images: { type: "array", items: { type: "string" } },
        },
        required: ["prompt", "output_path"], additionalProperties: false,
      },
      describe: (input) => `generate ${String(input.output_path)} with ${models.image}`,
      validate(input) {
        const extension = path.extname(requiredString(input, "output_path")).toLowerCase();
        if (!IMAGE_EXTENSIONS.has(extension)) throw new Error("output_path must end in .png, .jpg, .jpeg, or .webp");
        if (input.ratio !== undefined && (typeof input.ratio !== "string" || !RATIOS.has(input.ratio))) throw new Error("ratio is not supported");
      },
      async execute(input, context) {
        const references = optionalStrings(input, "reference_images");
        const images = references ? await Promise.all(references.map((value) => imageSource(context.cwd, value))) : undefined;
        context.reportProgress?.(`Generating image with ${models.image}`);
        const result = await getBackend().generateImage!({
          prompt: requiredString(input, "prompt"),
          size: typeof input.size === "string" ? input.size : "1K",
          ratio: typeof input.ratio === "string" ? input.ratio : "1:1",
          images,
        }, context.signal);
        const bytes = result.b64Json ? Buffer.from(result.b64Json, "base64") : await getBackend().download!(result.url!, context.signal);
        const saved = await saveAsset(context.cwd, requiredString(input, "output_path"), bytes);
        return `Generated image with ${models.image}\nSaved: ${saved}\n${result.url ? `Source URL: ${result.url}` : "Source: base64 response"}`;
      },
    });
  if ((suppliedBackend?.createVideo && suppliedBackend.getVideo && suppliedBackend.download) || (config.provider === "agnes" && Boolean(models.video))) tools.push({
      name: "generate_video",
      description: "Create a video asynchronously with the configured video model, report progress, and save the completed MP4 in the workspace. image_url and keyframe_urls must be public HTTP(S) URLs.",
      risk: "execute",
      changesWorkspace: true,
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          output_path: { type: "string", description: "Workspace-relative .mp4 path" },
          image_url: { type: "string" },
          keyframe_urls: { type: "array", items: { type: "string" } },
          width: { type: "integer", minimum: 64, default: 1152 },
          height: { type: "integer", minimum: 64, default: 768 },
          num_frames: { type: "integer", minimum: 1, maximum: 441, default: 121 },
          frame_rate: { type: "integer", minimum: 1, maximum: 60, default: 24 },
          negative_prompt: { type: "string" },
          seed: { type: "integer" },
          timeout_seconds: { type: "integer", minimum: 30, maximum: 1800, default: 600 },
        },
        required: ["prompt", "output_path"], additionalProperties: false,
      },
      describe: (input) => `generate ${String(input.output_path)} with ${models.video}`,
      validate(input) {
        if (path.extname(requiredString(input, "output_path")).toLowerCase() !== ".mp4") throw new Error("output_path must end in .mp4");
        const frames = typeof input.num_frames === "number" ? input.num_frames : 121;
        if ((frames - 1) % 8 !== 0) throw new Error("num_frames must satisfy (num_frames - 1) % 8 === 0");
        const urls = [input.image_url, ...(optionalStrings(input, "keyframe_urls") ?? [])].filter(Boolean);
        if (urls.some((url) => typeof url !== "string" || !/^https?:\/\//i.test(url))) throw new Error("video image inputs must be public HTTP(S) URLs");
      },
      async execute(input, context) {
        const timeoutMs = (typeof input.timeout_seconds === "number" ? input.timeout_seconds : 600) * 1000;
        context.reportProgress?.(`Submitting video to ${models.video}`);
        let task = await getBackend().createVideo!({
          prompt: requiredString(input, "prompt"),
          image: typeof input.image_url === "string" ? input.image_url : undefined,
          keyframes: optionalStrings(input, "keyframe_urls"),
          width: typeof input.width === "number" ? input.width : 1152,
          height: typeof input.height === "number" ? input.height : 768,
          numFrames: typeof input.num_frames === "number" ? input.num_frames : 121,
          frameRate: typeof input.frame_rate === "number" ? input.frame_rate : 24,
          negativePrompt: typeof input.negative_prompt === "string" ? input.negative_prompt : undefined,
          seed: typeof input.seed === "number" ? input.seed : undefined,
        }, context.signal);
        const deadline = Date.now() + timeoutMs;
        while (!completed(task) && !failed(task) && !task.url) {
          if (Date.now() >= deadline) throw new Error(`Video generation timed out after ${timeoutMs / 1000}s (task ${task.id})`);
          const progress = task.progress === undefined ? task.status : `${task.status} ${Math.round(task.progress)}%`;
          context.reportProgress?.(`Video ${task.id}: ${progress}`);
          await delay(3000, context.signal);
          task = await getBackend().getVideo!(task.id, context.signal);
        }
        if (failed(task)) throw new Error(`Video generation failed: ${task.error ?? task.status}`);
        if (!task.url) throw new Error("Completed video task returned no download URL");
        context.reportProgress?.(`Downloading completed video ${task.id}`);
        const saved = await saveAsset(context.cwd, requiredString(input, "output_path"), await getBackend().download!(task.url, context.signal));
        return `Generated video with ${models.video}\nTask: ${task.id}\nSaved: ${saved}\nSource URL: ${task.url}`;
      },
    });
  return tools;
}
