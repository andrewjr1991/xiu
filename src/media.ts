import { fetch, ProxyAgent } from "undici";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AgentConfig } from "./config.js";

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
  download?(url: string, signal?: AbortSignal): Promise<Buffer>;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function apiError(status: number, body: string): Error {
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message ?? body;
  } catch { /* retain raw body */ }
  return new Error(`Media API request failed (${status}): ${message.slice(0, 1000)}`);
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
    this.apiKey = (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined) ?? config.apiKey ?? process.env.AGNES_API_KEY ?? "";
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
    if (!response.ok) throw apiError(response.status, text);
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

  async getVideo(id: string, signal?: AbortSignal): Promise<VideoTask> {
    const root = this.baseURL.replace(/\/v1$/, "");
    const model = this.config.capabilities?.video ?? "agnes-video-v2.0";
    const response = await fetch(`${root}/agnesapi?video_id=${encodeURIComponent(id)}&model_name=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal,
      dispatcher: this.dispatcher,
    });
    const text = await response.text();
    if (!response.ok) throw apiError(response.status, text);
    const task = parseTask(text ? JSON.parse(text) : {});
    if (!task.id) task.id = id;
    return task;
  }

  async download(url: string, signal?: AbortSignal): Promise<Buffer> {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Generated asset URL must use HTTP(S)");
    const response = await fetch(parsed, { signal, dispatcher: this.dispatcher });
    if (!response.ok) throw new Error(`Asset download failed (${response.status})`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > 250 * 1024 * 1024) throw new Error("Generated asset exceeds the 250 MB download limit");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 250 * 1024 * 1024) throw new Error("Generated asset exceeds the 250 MB download limit");
    return bytes;
  }
}

export class OpenAIVisionBackend implements MediaBackend {
  private readonly client: OpenAI;

  constructor(private readonly config: AgentConfig) {
    this.client = new OpenAI({
      apiKey: ((config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined) ?? config.apiKey ?? process.env.OPENAI_API_KEY) || "xiu-local",
      baseURL: config.baseURL,
      fetchOptions: config.proxy ? { dispatcher: new ProxyAgent(config.proxy) } : undefined,
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
}

export class AnthropicVisionBackend implements MediaBackend {
  private readonly client: Anthropic;

  constructor(private readonly config: AgentConfig) {
    this.client = new Anthropic({
      apiKey: (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined) ?? config.apiKey ?? process.env.ANTHROPIC_API_KEY,
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
