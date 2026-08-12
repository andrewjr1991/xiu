import fs from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "./config.js";
import { createMediaBackend, MediaApiError, type MediaBackend, type VideoTask } from "./media.js";
import { mediaOperationKey, mediaRetryBlocked, MediaOperationStore } from "./media-operations.js";
import { safeProviderErrorMessage } from "./provider-failover.js";
import { classifyRetryError, retryDecision, retryDelay } from "./retry-policy.js";
import { resolveWorkspacePath } from "./tools.js";
import type { AgentTool, ToolContext } from "./types.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const RATIOS = new Set(["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"]);
const VIDEO_POLL_INTERVAL_MS = 30_000;

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

async function existingAsset(cwd: string, relativePath: string | undefined): Promise<Buffer | undefined> {
  if (!relativePath) return undefined;
  try { return await fs.readFile(resolveWorkspacePath(cwd, relativePath)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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

function mediaStatus(error: unknown): number | undefined {
  if (error instanceof MediaApiError) return error.status;
  const match = (error instanceof Error ? error.message : String(error)).match(/\((\d{3})\)/);
  return match ? Number(match[1]) : undefined;
}

function mediaCooldownDelay(error: unknown, polling: boolean): number {
  if (error instanceof MediaApiError && error.retryAfterMs !== undefined) return Math.max(1_000, error.retryAfterMs);
  const message = error instanceof Error ? error.message : String(error);
  const quota = message.match(/allows\s+(\d+)\s+requests?\s+per\s+(\d+)\s+minute/i);
  if (quota) return Math.max(1_000, Math.ceil((Number(quota[2]) * 60_000) / Math.max(1, Number(quota[1]))));
  return polling ? 30_000 : 60_000;
}

function isRetryableMediaError(error: unknown): boolean {
  return ["rate-limit", "timeout", "transport", "server"].includes(classifyRetryError(error));
}

function cooldownMessage(requestId: string, retryAfterAt: string): string {
  const seconds = Math.max(1, Math.ceil((Date.parse(retryAfterAt) - Date.now()) / 1000));
  return `Media provider cooldown is active after request ${requestId}. Wait about ${seconds}s before submitting another paid request. Existing video task polling and asset downloads may still resume safely.`;
}

async function safeMediaCall<T>(label: string, context: ToolContext, call: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    try { return await call(); }
    catch (error) {
      const decision = retryDecision({ operation: "media", error, attempt, maxAttempts, replaySafety: "safe", commitState: "not-committed" });
      if (!decision.retry) throw error;
      context.reportProgress?.(`${label}: transient ${decision.category} failure; retrying ${attempt + 1}/${maxAttempts} in ${decision.delayMs}ms`);
      await retryDelay(decision.delayMs ?? 0, context.signal);
    }
  }
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
  const operations = new MediaOperationStore(config.cwd);
  const providerId = config.providerId ?? config.provider;

  const tools: AgentTool[] = [];
  const features = config.providerFeatures;
  if (suppliedBackend?.analyzeImage || features?.vision || (!features && (config.provider === "agnes" || config.provider === "openai" || config.provider === "anthropic"))) tools.push({
      name: "analyze_image",
      description: "Analyze a workspace image or public image URL with the configured vision model. Use this when visual inspection is needed.",
      risk: "execute",
      replaySafety: "safe",
      maxAttempts: 3,
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
  if ((suppliedBackend?.generateImage && suppliedBackend.download) || ((features?.image ?? config.provider === "agnes") && config.provider === "agnes" && Boolean(models.image))) tools.push({
      name: "generate_image",
      description: "Generate or edit an image with the configured image model and save it in the workspace. Reference images may be workspace paths, URLs, or data URIs.",
      risk: () => "dangerous",
      approvalScope: (input) => input.force_new_generation === true ? undefined : "billable-media:image",
      changesWorkspace: true,
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          output_path: { type: "string", description: "Workspace-relative .png, .jpg, .jpeg, or .webp path" },
          size: { type: "string", enum: ["1K", "2K", "3K", "4K"], default: "1K" },
          ratio: { type: "string", enum: [...RATIOS], default: "1:1" },
          reference_images: { type: "array", items: { type: "string" } },
          force_new_generation: { type: "boolean", description: "Submit another potentially billable request after an ambiguous or failed prior attempt. Requires explicit approval." },
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
        const request = {
          prompt: requiredString(input, "prompt"),
          size: typeof input.size === "string" ? input.size : "1K",
          ratio: typeof input.ratio === "string" ? input.ratio : "1:1",
          images,
        };
        const key = mediaOperationKey("image", providerId, models.image!, request);
        const existing = await operations.get(key);
        if (input.force_new_generation === true && !existing) throw new Error("force_new_generation is only valid for the exact matching request after a previous ambiguous or failed submission. It must not be used to bypass normal media safeguards.");
        const cooldown = input.force_new_generation === true || !existing ? await operations.cooldown("image", providerId, models.image!) : undefined;
        if (cooldown?.retryAfterAt) throw new Error(cooldownMessage(cooldown.requestId, cooldown.retryAfterAt));
        let operation = existing && input.force_new_generation !== true
          ? existing
          : await operations.begin({ key, kind: "image", providerId, model: models.image! }, input.force_new_generation === true);
        if (existing && input.force_new_generation !== true) {
          const blocked = mediaRetryBlocked(operation);
          if (blocked) throw new Error(blocked);
        }
        const outputPath = requiredString(input, "output_path");
        let bytes = await existingAsset(context.cwd, operation.savedPath) ?? await existingAsset(context.cwd, operation.cachedAsset);
        if (operation.status === "completed" && bytes) {
          const saved = await saveAsset(context.cwd, outputPath, bytes);
          await operations.update(key, { savedPath: saved });
          return `Reused completed image request ${operation.requestId}; no new generation charge.\nSaved: ${saved}`;
        }
        if (!bytes && operation.url) {
          context.reportProgress?.(`Resuming download for image request ${operation.requestId}`);
          try {
            bytes = await safeMediaCall("Image download", context, async () => await getBackend().download!(operation.url!, context.signal));
          } catch (error) {
            throw new Error(`Image request ${operation.requestId} was accepted, but its asset could not be downloaded. Repeat the same request to resume without a new generation charge: ${safeProviderErrorMessage(error, [config.apiKey ?? ""])}`);
          }
        }
        if (!bytes) {
          context.reportProgress?.(`Submitting potentially billable image request ${operation.requestId} to ${models.image}`);
          let result;
          try {
            result = await getBackend().generateImage!(request, context.signal);
          } catch (error) {
            const reason = safeProviderErrorMessage(error, [config.apiKey ?? ""]);
            const status = mediaStatus(error);
            if (status !== undefined) {
              const retryAfterAt = isRetryableMediaError(error) ? new Date(Date.now() + mediaCooldownDelay(error, false)).toISOString() : undefined;
              await operations.update(key, { status: "failed", error: reason, retryAfterAt });
              throw new Error(`Image request ${operation.requestId} was rejected before an asset was returned${retryAfterAt ? `; new submissions are paused until ${retryAfterAt}` : ""}: ${reason}`);
            }
            await operations.update(key, { status: "ambiguous", error: reason });
            throw new Error(`Image request ${operation.requestId} failed with an unknown submission outcome and was not retried: ${reason}`);
          }
          if (result.b64Json) {
            bytes = Buffer.from(result.b64Json, "base64");
            const cachedAsset = await operations.cacheAsset(operation.requestId, path.extname(outputPath).toLowerCase(), bytes);
            operation = await operations.update(key, { status: "asset_ready", cachedAsset });
          } else {
            operation = await operations.update(key, { status: "asset_ready", url: result.url });
            try {
              bytes = await safeMediaCall("Image download", context, async () => await getBackend().download!(result.url!, context.signal));
            } catch (error) {
              throw new Error(`Image request ${operation.requestId} was accepted, but its asset could not be downloaded. Repeat the same request to resume without a new generation charge: ${safeProviderErrorMessage(error, [config.apiKey ?? ""])}`);
            }
          }
        }
        const saved = await saveAsset(context.cwd, outputPath, bytes);
        operation = await operations.update(key, { status: "completed", savedPath: saved });
        return `Generated image with ${models.image}\nRequest: ${operation.requestId}\nSaved: ${saved}\n${operation.url ? `Source URL: ${operation.url}` : "Source: cached base64 response"}`;
      },
    });
  if ((suppliedBackend?.createVideo && suppliedBackend.getVideo && suppliedBackend.download) || ((features?.video ?? config.provider === "agnes") && config.provider === "agnes" && Boolean(models.video))) tools.push({
      name: "generate_video",
      description: "Create a video asynchronously with the configured video model, report progress, and save the completed MP4 in the workspace. image_url and keyframe_urls must be public HTTP(S) URLs.",
      risk: () => "dangerous",
      approvalScope: (input) => input.force_new_generation === true ? undefined : "billable-media:video",
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
          force_new_generation: { type: "boolean", description: "Create another potentially billable video task after an ambiguous or failed prior attempt. Requires explicit approval." },
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
        const request = {
          prompt: requiredString(input, "prompt"),
          image: typeof input.image_url === "string" ? input.image_url : undefined,
          keyframes: optionalStrings(input, "keyframe_urls"),
          width: typeof input.width === "number" ? input.width : 1152,
          height: typeof input.height === "number" ? input.height : 768,
          numFrames: typeof input.num_frames === "number" ? input.num_frames : 121,
          frameRate: typeof input.frame_rate === "number" ? input.frame_rate : 24,
          negativePrompt: typeof input.negative_prompt === "string" ? input.negative_prompt : undefined,
          seed: typeof input.seed === "number" ? input.seed : undefined,
        };
        const key = mediaOperationKey("video", providerId, models.video!, request);
        const existing = await operations.get(key);
        if (input.force_new_generation === true && !existing) throw new Error("force_new_generation is only valid for the exact matching request after a previous ambiguous or failed submission. It must not be used to create a new prompt variant.");
        const cooldown = input.force_new_generation === true || !existing ? await operations.cooldown("video", providerId, models.video!) : undefined;
        if (cooldown?.retryAfterAt) throw new Error(cooldownMessage(cooldown.requestId, cooldown.retryAfterAt));
        let operation = existing && input.force_new_generation !== true
          ? existing
          : await operations.begin({ key, kind: "video", providerId, model: models.video! }, input.force_new_generation === true);
        if (existing && input.force_new_generation !== true) {
          const blocked = mediaRetryBlocked(operation);
          if (blocked) throw new Error(blocked);
        }
        const outputPath = requiredString(input, "output_path");
        let bytes = await existingAsset(context.cwd, operation.savedPath) ?? await existingAsset(context.cwd, operation.cachedAsset);
        if (operation.status === "completed" && bytes) {
          const saved = await saveAsset(context.cwd, outputPath, bytes);
          await operations.update(key, { savedPath: saved });
          return `Reused completed video request ${operation.requestId}; no new generation charge.\nTask: ${operation.taskId ?? "completed"}\nSaved: ${saved}`;
        }
        let task: VideoTask;
        let resumePollImmediately = false;
        if (operation.taskId) {
          task = { id: operation.taskId, status: operation.status === "asset_ready" ? "completed" : "submitted", url: operation.url };
          resumePollImmediately = !operation.url;
          context.reportProgress?.(`Resuming video request ${operation.requestId} (task ${operation.taskId})`);
        } else if (operation.url) {
          task = { id: operation.requestId, status: "completed", url: operation.url };
        } else {
          context.reportProgress?.(`Submitting potentially billable video request ${operation.requestId} to ${models.video}`);
          try {
            task = await getBackend().createVideo!(request, context.signal);
          } catch (error) {
            const reason = safeProviderErrorMessage(error, [config.apiKey ?? ""]);
            const status = mediaStatus(error);
            if (status !== undefined) {
              const retryAfterAt = isRetryableMediaError(error) ? new Date(Date.now() + mediaCooldownDelay(error, false)).toISOString() : undefined;
              await operations.update(key, { status: "failed", error: reason, retryAfterAt });
              throw new Error(`Video request ${operation.requestId} was rejected before a task ID was returned${retryAfterAt ? `; new submissions are paused until ${retryAfterAt}` : ""}: ${reason}`);
            }
            await operations.update(key, { status: "ambiguous", error: reason });
            throw new Error(`Video request ${operation.requestId} failed with an unknown submission outcome and was not retried: ${reason}`);
          }
          operation = await operations.update(key, {
            status: task.url ? "asset_ready" : "submitted",
            taskId: task.id || undefined,
            url: task.url,
          });
        }
        const deadline = Date.now() + timeoutMs;
        let consecutivePollFailures = 0;
        while (!completed(task) && !failed(task) && !task.url) {
          if (Date.now() >= deadline) throw new Error(`Video request ${operation.requestId} timed out after ${timeoutMs / 1000}s. Task ${task.id} was preserved; repeat the same request to resume polling without creating another task.`);
          const progress = task.progress === undefined ? task.status : `${task.status} ${Math.round(task.progress)}%`;
          context.reportProgress?.(`Video ${task.id}: ${progress}`);
          if (resumePollImmediately) resumePollImmediately = false;
          else await delay(VIDEO_POLL_INTERVAL_MS, context.signal);
          try {
            task = await getBackend().getVideo!(task.id, context.signal);
          } catch (error) {
            const decision = retryDecision({ operation: "media", error, attempt: consecutivePollFailures + 1, maxAttempts: 3, replaySafety: "safe", commitState: "not-committed" });
            if (decision.retry) {
              consecutivePollFailures += 1;
              const waitMs = decision.delayMs ?? mediaCooldownDelay(error, true);
              if (Date.now() + waitMs >= deadline) throw new Error(`Video task ${task.id} is still preserved, but polling could not recover before the ${timeoutMs / 1000}s timeout: ${safeProviderErrorMessage(error, [config.apiKey ?? ""])}`);
              context.reportProgress?.(`Video ${task.id}: status service busy; retrying poll in ${Math.ceil(waitMs / 1000)}s`);
              await retryDelay(waitMs, context.signal);
              resumePollImmediately = true;
              continue;
            }
            throw new Error(`Could not poll video task ${task.id}. Repeat the same request to resume without creating another task: ${safeProviderErrorMessage(error, [config.apiKey ?? ""])}`);
          }
          consecutivePollFailures = 0;
          operation = await operations.update(key, {
            status: task.url ? "asset_ready" : "submitted",
            taskId: task.id,
            url: task.url,
          });
        }
        if (failed(task)) {
          const reason = task.error ?? task.status;
          await operations.update(key, { status: "failed", taskId: task.id, error: reason });
          throw new Error(`Video generation failed: ${reason}`);
        }
        if (!task.url) throw new Error("Completed video task returned no download URL");
        operation = await operations.update(key, { status: "asset_ready", taskId: task.id, url: task.url });
        context.reportProgress?.(`Downloading completed video ${task.id}`);
        if (!bytes) {
          try {
            bytes = await safeMediaCall("Video download", context, async () => await getBackend().download!(task.url!, context.signal));
          } catch (error) {
            throw new Error(`Video task ${task.id} completed, but its asset could not be downloaded. Repeat the same request to resume without creating another task: ${safeProviderErrorMessage(error, [config.apiKey ?? ""])}`);
          }
        }
        const cachedAsset = await operations.cacheAsset(operation.requestId, ".mp4", bytes);
        const saved = await saveAsset(context.cwd, outputPath, bytes);
        await operations.update(key, { status: "completed", taskId: task.id, url: task.url, cachedAsset, savedPath: saved });
        return `Generated video with ${models.video}\nRequest: ${operation.requestId}\nTask: ${task.id}\nSaved: ${saved}\nSource URL: ${task.url}`;
      },
    });
  if (suppliedBackend?.download || config.provider === "agnes") tools.push({
    name: "list_media_operations",
    description: "List recent persistent image and video generation operations for this workspace. Use request IDs to inspect recovery state without submitting paid work.",
    risk: "read",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
      additionalProperties: false,
    },
    describe: () => "list persistent media operations",
    async execute(input) {
      const limit = typeof input.limit === "number" ? input.limit : 20;
      const records = await operations.list(limit);
      return JSON.stringify({
        operations: records.map((record) => ({
          request_id: record.requestId,
          kind: record.kind,
          status: record.status,
          provider: record.providerId,
          model: record.model,
          task_id: record.taskId,
          saved_path: record.savedPath,
          updated_at: record.updatedAt,
          resumable: record.status === "completed" || record.status === "asset_ready" || (record.kind === "video" && record.status === "submitted" && Boolean(record.taskId)),
          blocked_reason: mediaRetryBlocked(record),
        })),
      }, null, 2);
    },
  });
  if (suppliedBackend?.download || config.provider === "agnes") tools.push({
    name: "resume_media_operation",
    description: "Resume an existing media request by stable request ID. This may reuse a cached asset, continue a video status poll, or retry an asset download, but it never submits a new paid generation request.",
    risk: "execute",
    changesWorkspace: true,
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "Full request ID or an unambiguous prefix of at least 8 characters" },
        output_path: { type: "string", description: "Workspace-relative destination path (.mp4 for video; image extension for image)" },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 1800, default: 600 },
      },
      required: ["request_id", "output_path"],
      additionalProperties: false,
    },
    describe: (input) => `resume media request ${String(input.request_id)} into ${String(input.output_path)} without creating a new generation`,
    validate(input) {
      const outputPath = requiredString(input, "output_path");
      const extension = path.extname(outputPath).toLowerCase();
      if (extension !== ".mp4" && !IMAGE_EXTENSIONS.has(extension)) throw new Error("output_path must be .mp4, .png, .jpg, .jpeg, or .webp");
    },
    async execute(input, context) {
      const operation = await operations.resolve(requiredString(input, "request_id"));
      if (operation.providerId !== providerId) {
        throw new Error(`Media request ${operation.requestId} belongs to Provider ${operation.providerId}. Switch to that Provider before resuming it.`);
      }
      const outputPath = requiredString(input, "output_path");
      const extension = path.extname(outputPath).toLowerCase();
      if (operation.kind === "video" && extension !== ".mp4") throw new Error("video recovery output_path must end in .mp4");
      if (operation.kind === "image" && !IMAGE_EXTENSIONS.has(extension)) throw new Error("image recovery output_path must use a supported image extension");

      let bytes = await existingAsset(context.cwd, operation.savedPath) ?? await existingAsset(context.cwd, operation.cachedAsset);
      if (bytes) {
        const saved = await saveAsset(context.cwd, outputPath, bytes);
        await operations.update(operation.key, { status: "completed", savedPath: saved });
        return `Reused cached ${operation.kind} request ${operation.requestId}; no new generation charge.\nSaved: ${saved}`;
      }
      const blocked = mediaRetryBlocked(operation);
      if (blocked) throw new Error(blocked);

      let url = operation.url;
      let taskId = operation.taskId;
      const backend = getBackend();
      if (operation.kind === "video" && !url) {
        if (!taskId || operation.status !== "submitted") throw new Error(`Video request ${operation.requestId} has no safely resumable task ID or asset URL.`);
        if (!backend.getVideo) throw new Error("The current Provider backend cannot poll video tasks.");
        const timeoutMs = (typeof input.timeout_seconds === "number" ? input.timeout_seconds : 600) * 1000;
        const deadline = Date.now() + timeoutMs;
        let task: VideoTask = { id: taskId, status: "submitted" };
        context.reportProgress?.(`Resuming video request ${operation.requestId} (task ${taskId})`);
        let consecutivePollFailures = 0;
        while (!completed(task) && !failed(task) && !task.url) {
          if (Date.now() >= deadline) throw new Error(`Video task ${taskId} is still preserved; recovery timed out after ${timeoutMs / 1000}s.`);
          try {
            task = await backend.getVideo(taskId, context.signal);
          } catch (error) {
            const decision = retryDecision({ operation: "media", error, attempt: consecutivePollFailures + 1, maxAttempts: 3, replaySafety: "safe", commitState: "not-committed" });
            if (!decision.retry) throw new Error(`Could not resume video task ${taskId}: ${safeProviderErrorMessage(error, [config.apiKey ?? ""])}`);
            consecutivePollFailures += 1;
            const waitMs = decision.delayMs ?? mediaCooldownDelay(error, true);
            if (Date.now() + waitMs >= deadline) throw new Error(`Video task ${taskId} remains preserved, but polling could not recover before timeout: ${safeProviderErrorMessage(error, [config.apiKey ?? ""])}`);
            context.reportProgress?.(`Video ${taskId}: status service busy; retrying poll in ${Math.ceil(waitMs / 1000)}s`);
            await retryDelay(waitMs, context.signal);
            continue;
          }
          consecutivePollFailures = 0;
          taskId = task.id;
          url = task.url;
          await operations.update(operation.key, { status: url ? "asset_ready" : "submitted", taskId, url });
          if (!completed(task) && !failed(task) && !url) await delay(VIDEO_POLL_INTERVAL_MS, context.signal);
        }
        if (failed(task)) {
          const reason = task.error ?? task.status;
          await operations.update(operation.key, { status: "failed", taskId, error: reason });
          throw new Error(`Video generation failed: ${reason}`);
        }
      }
      if (!url) throw new Error(`Media request ${operation.requestId} has no cached asset or download URL and cannot be resumed safely.`);
      if (!backend.download) throw new Error("The current Provider backend cannot download media assets.");
      context.reportProgress?.(`Resuming download for ${operation.kind} request ${operation.requestId}`);
      bytes = await safeMediaCall("Media recovery download", context, async () => await backend.download!(url!, context.signal));
      const cachedAsset = await operations.cacheAsset(operation.requestId, extension, bytes);
      const saved = await saveAsset(context.cwd, outputPath, bytes);
      await operations.update(operation.key, { status: "completed", taskId, url, cachedAsset, savedPath: saved, error: undefined });
      return `Resumed ${operation.kind} request ${operation.requestId}; no new generation charge.\n${taskId ? `Task: ${taskId}\n` : ""}Saved: ${saved}`;
    },
  });
  return tools;
}
