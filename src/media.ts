import { fetch, ProxyAgent } from "undici";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AgentConfig } from "./config.js";
import { readEnvironmentCredential } from "./credential-store.js";

export interface ImageGenerationRequest {
  prompt: string;
  size: string;
  ratio?: string;
  images?: string[];
}

export interface ImageGenerationResult {
  url?: string;
  b64Json?: string;
}

export interface VideoGenerationRequest {
  prompt: string;
  image?: string;
  keyframes?: string[];
  width?: number;
  height?: number;
  numFrames?: number;
  frameRate?: number;
  negativePrompt?: string;
  seed?: number;
}

export interface AudioGenerationRequest {
  text: string;
  voice?: string;
  format?: "mp3" | "wav" | "opus" | "aac" | "flac" | "pcm";
  instructions?: string;
}

export interface VideoTask {
  id: string;
  status: string;
  progress?: number;
  url?: string;
  error?: string;
}

export interface MediaBackend {
  analyzeImage?(prompt: string, image: string, signal?: AbortSignal): Promise<string>;
  generateImage?(request: ImageGenerationRequest, signal?: AbortSignal): Promise<ImageGenerationResult>;
  createVideo?(request: VideoGenerationRequest, signal?: AbortSignal): Promise<VideoTask>;
  getVideo?(id: string, signal?: AbortSignal): Promise<VideoTask>;
  generateAudio?(request: AudioGenerationRequest, signal?: AbortSignal): Promise<Buffer>;
  download?(url: string, signal?: AbortSignal): Promise<Buffer>;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

const MAX_MEDIA_BYTES = 250 * 1024 * 1024;

async function boundedMediaBytes(response: { headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_MEDIA_BYTES) throw new Error("Generated asset exceeds the 250 MB download limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_MEDIA_BYTES) throw new Error("Generated asset exceeds the 250 MB download limit");
  return bytes;
}

export class MediaApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = "MediaApiError";
  }
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function apiError(status: number, body: string, retryAfter?: string | null): Error {
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message ?? body;
  } catch { /* retain raw body */ }
  return new MediaApiError(`Media API request failed (${status}): ${message.slice(0, 1000)}`, status, retryAfterMilliseconds(retryAfter ?? null));
}

function parseTask(value: unknown): VideoTask {
  const body = value as Record<string, unknown>;
  const metadata = (body.metadata ?? {}) as Record<string, unknown>;
  const id = String(body.video_id ?? body.id ?? body.task_id ?? "");
  const rawProgress = body.progress ?? metadata.progress;
  return {
    id,
    status: String(body.status ?? metadata.status ?? "queued").toLowerCase(),
    progress: typeof rawProgress === "number" ? rawProgress : undefined,
    url: typeof metadata.url === "string" ? metadata.url : typeof body.url === "string" ? body.url : undefined,
    error: typeof body.error === "string" ? body.error : typeof metadata.error === "string" ? metadata.error : undefined,
  };
}

export class AgnesMediaBackend implements MediaBackend {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly dispatcher?: ProxyAgent;

  constructor(private readonly config: AgentConfig) {
    this.apiKey = readEnvironmentCredential(config.apiKeyEnv) ?? config.apiKey ?? readEnvironmentCredential("AGNES_API_KEY") ?? "";
    if (!this.apiKey) throw new Error("AGNES_API_KEY is required for Xiu media tools");
    this.baseURL = trimSlash(config.mediaBaseURL ?? process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.com/v1");
    this.dispatcher = config.proxy ? new ProxyAgent(config.proxy) : undefined;
  }

  private async json(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
    const response = await fetch(`${this.baseURL}/${path.replace(/^\//, "")}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
      dispatcher: this.dispatcher,
    });
    const text = await response.text();
    if (!response.ok) throw apiError(response.status, text, response.headers.get("retry-after"));
    return text ? JSON.parse(text) : {};
  }

  async analyzeImage(prompt: string, image: string, signal?: AbortSignal): Promise<string> {
    const response = await this.json("chat/completions", {
      method: "POST",
      signal,
      body: {
        model: this.config.capabilities?.vision ?? this.config.model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: image } },
          ],
        }],
      },
    }) as { choices?: Array<{ message?: { content?: string } }> };
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error("Vision model returned no text");
    return content;
  }

  async generateImage(request: ImageGenerationRequest, signal?: AbortSignal): Promise<ImageGenerationResult> {
    const response = await this.json("images/generations", {
      method: "POST",
      signal,
      body: {
        model: this.config.capabilities?.image ?? "agnes-image-2.1-flash",
        prompt: request.prompt,
        size: request.size,
        ...(request.ratio ? { ratio: request.ratio } : {}),
        extra_body: {
          response_format: "url",
          ...(request.images?.length ? { image: request.images } : {}),
        },
      },
    }) as { data?: Array<{ url?: string; b64_json?: string }> };
    const image = response.data?.[0];
    if (!image?.url && !image?.b64_json) throw new Error("Image model returned no image");
    return { url: image.url, b64Json: image.b64_json };
  }

  async createVideo(request: VideoGenerationRequest, signal?: AbortSignal): Promise<VideoTask> {
    const response = await this.json("videos", {
      method: "POST",
      signal,
      body: {
        model: this.config.capabilities?.video ?? "agnes-video-v2.0",
        prompt: request.prompt,
        ...(request.image ? { image: request.image } : {}),
        ...(request.width ? { width: request.width } : {}),
        ...(request.height ? { height: request.height } : {}),
        ...(request.numFrames ? { num_frames: request.numFrames } : {}),
        ...(request.frameRate ? { frame_rate: request.frameRate } : {}),
        ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
        ...(request.seed !== undefined ? { seed: request.seed } : {}),
        ...(request.keyframes?.length ? { extra_body: { image: request.keyframes, mode: "keyframes" } } : {}),
      },
    });
    const task = parseTask(response);
    if (!task.id && !task.url) throw new Error("Video API returned no task id");
    return task;
  }

  async generateAudio(request: AudioGenerationRequest, signal?: AbortSignal): Promise<Buffer> {
    const response = await fetch(`${this.baseURL}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.capabilities?.audio,
        input: request.text,
        voice: request.voice ?? "alloy",
        response_format: request.format ?? "mp3",
        ...(request.instructions ? { instructions: request.instructions } : {}),
      }),
      signal, dispatcher: this.dispatcher,
    });
    if (!response.ok) throw apiError(response.status, await response.text(), response.headers.get("retry-after"));
    return boundedMediaBytes(response);
  }

  async getVideo(id: string, signal?: AbortSignal): Promise<VideoTask> {
    const root = this.baseURL.replace(/\/v1$/, "");
    const model = this.config.capabilities?.video ?? "agnes-video-v2.0";
    const response = await fetch(`${root}/agnesapi?video_id=${encodeURIComponent(id)}&model_name=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal,
      dispatcher: this.dispatcher,
    });
    const text = await response.text();
    if (!response.ok) throw apiError(response.status, text, response.headers.get("retry-after"));
    const task = parseTask(text ? JSON.parse(text) : {});
    if (!task.id) task.id = id;
    return task;
  }

  async download(url: string, signal?: AbortSignal): Promise<Buffer> {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Generated asset URL must use HTTP(S)");
    const response = await fetch(parsed, { signal, dispatcher: this.dispatcher });
    if (!response.ok) throw new Error(`Asset download failed (${response.status})`);
    return boundedMediaBytes(response);
  }
}

export class OpenAIVisionBackend implements MediaBackend {
  private readonly client: OpenAI;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly dispatcher?: ProxyAgent;

  constructor(private readonly config: AgentConfig) {
    this.apiKey = (readEnvironmentCredential(config.apiKeyEnv) ?? config.apiKey ?? readEnvironmentCredential("OPENAI_API_KEY")) || "xiu-local";
    this.baseURL = trimSlash(config.mediaBaseURL ?? config.baseURL ?? "https://api.openai.com/v1");
    this.dispatcher = config.proxy ? new ProxyAgent(config.proxy) : undefined;
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      fetchOptions: this.dispatcher ? { dispatcher: this.dispatcher } : undefined,
    });
  }

  async analyzeImage(prompt: string, image: string, signal?: AbortSignal): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.config.capabilities?.vision ?? this.config.model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: image } },
        ],
      }],
    }, { signal });
    const content = response.choices[0]?.message.content;
    if (!content) throw new Error("OpenAI vision model returned no text");
    return content;
  }

  async generateImage(request: ImageGenerationRequest, signal?: AbortSignal): Promise<ImageGenerationResult> {
    if (request.images?.length) throw new Error("This OpenAI-compatible adapter does not support reference-image editing; remove reference_images or use a provider-specific adapter that supports it");
    const landscape = ["3:2", "4:3", "16:9", "21:9"].includes(request.ratio ?? "");
    const portrait = ["2:3", "3:4", "9:16"].includes(request.ratio ?? "");
    const response = await this.client.images.generate({
      model: this.config.capabilities?.image ?? "gpt-image-1",
      prompt: request.prompt,
      size: landscape ? "1536x1024" : portrait ? "1024x1536" : "1024x1024",
      response_format: "b64_json",
    } as never, { signal });
    const image = response.data?.[0];
    if (!image?.url && !image?.b64_json) throw new Error("Image model returned no image");
    return { url: image.url, b64Json: image.b64_json };
  }

  async generateAudio(request: AudioGenerationRequest, signal?: AbortSignal): Promise<Buffer> {
    const response = await this.client.audio.speech.create({
      model: this.config.capabilities?.audio ?? "gpt-4o-mini-tts",
      input: request.text,
      voice: request.voice ?? "alloy",
      response_format: request.format ?? "mp3",
      ...(request.instructions ? { instructions: request.instructions } : {}),
    } as never, { signal });
    return boundedMediaBytes(response);
  }

  private async videoJson(pathname: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
    const response = await fetch(`${this.baseURL}/${pathname.replace(/^\//, "")}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: init.signal, dispatcher: this.dispatcher,
    });
    const text = await response.text();
    if (!response.ok) throw apiError(response.status, text, response.headers.get("retry-after"));
    return text ? JSON.parse(text) : {};
  }

  async createVideo(request: VideoGenerationRequest, signal?: AbortSignal): Promise<VideoTask> {
    const task = parseTask(await this.videoJson("videos", { method: "POST", signal, body: {
      model: this.config.capabilities?.video,
      prompt: request.prompt,
      ...(request.image ? { image: request.image } : {}),
      ...(request.width ? { width: request.width } : {}), ...(request.height ? { height: request.height } : {}),
      ...(request.numFrames ? { num_frames: request.numFrames } : {}), ...(request.frameRate ? { frame_rate: request.frameRate } : {}),
      ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}), ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.keyframes?.length ? { keyframe_urls: request.keyframes } : {}),
    } }));
    if (!task.id && !task.url) throw new Error("Video API returned no task id or asset URL");
    if (task.id && /completed|succeeded|success|done/i.test(task.status) && !task.url) task.url = `${this.baseURL}/videos/${encodeURIComponent(task.id)}/content`;
    return task;
  }

  async getVideo(id: string, signal?: AbortSignal): Promise<VideoTask> {
    const task = parseTask(await this.videoJson(`videos/${encodeURIComponent(id)}`, { signal }));
    if (!task.id) task.id = id;
    if (/completed|succeeded|success|done/i.test(task.status) && !task.url) task.url = `${this.baseURL}/videos/${encodeURIComponent(task.id)}/content`;
    return task;
  }

  async download(url: string, signal?: AbortSignal): Promise<Buffer> {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Generated asset URL must use HTTP(S)");
    const mediaRoot = new URL(`${this.baseURL}/`);
    const authenticated = parsed.origin === mediaRoot.origin && parsed.pathname.startsWith(mediaRoot.pathname);
    const response = await fetch(parsed, { signal, dispatcher: this.dispatcher, headers: authenticated ? { Authorization: `Bearer ${this.apiKey}` } : undefined });
    if (!response.ok) throw new Error(`Asset download failed (${response.status})`);
    return boundedMediaBytes(response);
  }
}

export class AnthropicVisionBackend implements MediaBackend {
  private readonly client: Anthropic;

  constructor(private readonly config: AgentConfig) {
    this.client = new Anthropic({
      apiKey: readEnvironmentCredential(config.apiKeyEnv) ?? config.apiKey ?? readEnvironmentCredential("ANTHROPIC_API_KEY"),
      fetchOptions: config.proxy ? { dispatcher: new ProxyAgent(config.proxy) } : undefined,
    });
  }

  async analyzeImage(prompt: string, image: string, signal?: AbortSignal): Promise<string> {
    const source = image.startsWith("data:")
      ? (() => {
          const match = image.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s);
          if (!match) throw new Error("Claude vision requires a PNG, JPEG, WEBP, or GIF data URI");
          return { type: "base64" as const, media_type: match[1] as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: match[2] };
        })()
      : { type: "url" as const, url: image };
    const response = await this.client.messages.create({
      model: this.config.capabilities?.vision ?? this.config.model,
      max_tokens: 4096,
      messages: [{ role: "user", content: [{ type: "image", source }, { type: "text", text: prompt }] }],
    }, { signal });
    const content = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    if (!content) throw new Error("Claude vision model returned no text");
    return content;
  }
}

export function createMediaBackend(config: AgentConfig): MediaBackend {
  if (config.provider === "agnes") return new AgnesMediaBackend(config);
  if (config.provider === "anthropic") return new AnthropicVisionBackend(config);
  return new OpenAIVisionBackend(config);
}
