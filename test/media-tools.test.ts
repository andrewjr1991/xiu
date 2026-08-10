import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../src/config.js";
import { createMediaTools } from "../src/media-tools.js";
import { MediaApiError, type ImageGenerationRequest, type MediaBackend, type VideoGenerationRequest, type VideoTask } from "../src/media.js";
import { mediaOperationKey, MediaOperationStore } from "../src/media-operations.js";
import { executeTool } from "../src/tools.js";

class MockMediaBackend implements MediaBackend {
  imageRequest?: ImageGenerationRequest;
  videoRequest?: VideoGenerationRequest;
  analyzedImage?: string;
  imageCalls = 0;
  videoCalls = 0;
  downloadCalls = 0;

  async analyzeImage(_prompt: string, image: string): Promise<string> {
    this.analyzedImage = image;
    return "The image contains a blue square.";
  }

  async generateImage(request: ImageGenerationRequest) {
    this.imageCalls += 1;
    this.imageRequest = request;
    return { url: "https://assets.example/generated.png" };
  }

  async createVideo(request: VideoGenerationRequest): Promise<VideoTask> {
    this.videoCalls += 1;
    this.videoRequest = request;
    return { id: "video-1", status: "completed", progress: 100, url: "https://assets.example/generated.mp4" };
  }

  async getVideo(): Promise<VideoTask> {
    throw new Error("completed tasks should not be polled");
  }

  async download(url: string): Promise<Buffer> {
    this.downloadCalls += 1;
    return Buffer.from(url.endsWith(".mp4") ? "video-bytes" : "image-bytes");
  }
}

function config(cwd: string): AgentConfig {
  return {
    provider: "agnes",
    model: "text-model",
    cwd,
    maxTurns: 5,
    autoApprove: true,
    capabilities: { text: "text-model", vision: "vision-model", image: "image-model", video: "video-model" },
  };
}

test("image generation routes to the image backend and saves the asset", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-media-"));
  const backend = new MockMediaBackend();
  const tool = createMediaTools(config(cwd), backend).find((item) => item.name === "generate_image")!;
  const progress: string[] = [];
  const result = await executeTool(tool, { prompt: "blue square", output_path: "assets/square.png", size: "2K", ratio: "1:1" }, {
    cwd,
    approve: async () => true,
    reportProgress: (message) => progress.push(message),
  });
  assert.equal(await fs.readFile(path.join(cwd, "assets", "square.png"), "utf8"), "image-bytes");
  assert.equal(backend.imageRequest?.size, "2K");
  assert.match(result, /image-model/);
  assert.match(progress[0], /potentially billable image request/);
});

test("media approvals expose a session scope, but forced duplicate generation never does", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-media-approval-"));
  const backend = new MockMediaBackend();
  const image = createMediaTools(config(cwd), backend).find((item) => item.name === "generate_image")!;
  const scopes: Array<string | undefined> = [];
  const approve = async (request: { sessionScope?: string }) => { scopes.push(request.sessionScope); return true; };
  await executeTool(image, { prompt: "normal", output_path: "normal.png" }, { cwd, approve });
  await executeTool(image, { prompt: "forced", output_path: "forced.png", force_new_generation: true }, { cwd, approve });
  assert.deepEqual(scopes, ["billable-media:image", undefined]);
});

test("an identical completed image request reuses the saved asset without another billable submission", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-media-reuse-"));
  const backend = new MockMediaBackend();
  const tool = createMediaTools(config(cwd), backend).find((item) => item.name === "generate_image")!;
  const context = { cwd, approve: async () => true };
  await executeTool(tool, { prompt: "blue square", output_path: "first.png" }, context);
  const result = await executeTool(tool, { prompt: "blue square", output_path: "second.png" }, context);
  assert.equal(backend.imageCalls, 1);
  assert.equal(backend.downloadCalls, 1);
  assert.equal(await fs.readFile(path.join(cwd, "second.png"), "utf8"), "image-bytes");
  assert.match(result, /no new generation charge/);
});

test("an ambiguous image submission is not retried without explicit force", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-media-ambiguous-"));
  const backend = new MockMediaBackend();
  backend.generateImage = async () => {
    backend.imageCalls += 1;
    throw new Error("Connection error api_key=top-secret-value");
  };
  const tool = createMediaTools(config(cwd), backend).find((item) => item.name === "generate_image")!;
  const context = { cwd, approve: async () => true };
  const first = await executeTool(tool, { prompt: "uncertain", output_path: "out.png" }, context);
  const second = await executeTool(tool, { prompt: "uncertain", output_path: "out.png" }, context);
  assert.equal(backend.imageCalls, 1);
  assert.match(first, /unknown submission outcome/);
  assert.doesNotMatch(first, /top-secret-value/);
  assert.match(second, /will not submit it again automatically/);
  await executeTool(tool, { prompt: "uncertain", output_path: "out.png", force_new_generation: true }, context);
  assert.equal(backend.imageCalls, 2);
});

test("a failed image download resumes from the stored URL without generating again", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-media-download-"));
  const backend = new MockMediaBackend();
  backend.download = async () => {
    backend.downloadCalls += 1;
    if (backend.downloadCalls === 1) throw new Error("temporary download failure");
    return Buffer.from("recovered-image");
  };
  const tool = createMediaTools(config(cwd), backend).find((item) => item.name === "generate_image")!;
  const context = { cwd, approve: async () => true };
  const first = await executeTool(tool, { prompt: "recover", output_path: "out.png" }, context);
  const second = await executeTool(tool, { prompt: "recover", output_path: "out.png" }, context);
  assert.match(first, /Repeat the same request to resume/);
  assert.equal(backend.imageCalls, 1);
  assert.equal(backend.downloadCalls, 2);
  assert.equal(await fs.readFile(path.join(cwd, "out.png"), "utf8"), "recovered-image");
  assert.match(second, /Generated image/);
});

test("vision analysis converts a local image to a data URI", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-vision-"));
  await fs.writeFile(path.join(cwd, "sample.png"), Buffer.from("png"));
  const backend = new MockMediaBackend();
  const tool = createMediaTools(config(cwd), backend).find((item) => item.name === "analyze_image")!;
  const result = await executeTool(tool, { source: "sample.png", prompt: "Describe it" }, { cwd, approve: async () => true });
  assert.match(backend.analyzedImage ?? "", /^data:image\/png;base64,/);
  assert.match(result, /vision-model/);
});

test("video generation validates frames and writes the completed MP4", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-video-"));
  const backend = new MockMediaBackend();
  const tool = createMediaTools(config(cwd), backend).find((item) => item.name === "generate_video")!;
  const invalid = await executeTool(tool, { prompt: "move", output_path: "out.mp4", num_frames: 120 }, { cwd, approve: async () => true });
  assert.match(invalid, /num_frames/);

  const result = await executeTool(tool, { prompt: "move", output_path: "out.mp4", num_frames: 121 }, { cwd, approve: async () => true });
  assert.equal(await fs.readFile(path.join(cwd, "out.mp4"), "utf8"), "video-bytes");
  assert.equal(backend.videoRequest?.numFrames, 121);
  assert.match(result, /video-model/);
});

test("a completed video task resumes its download without creating a duplicate task", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-video-resume-"));
  const backend = new MockMediaBackend();
  backend.download = async () => {
    backend.downloadCalls += 1;
    if (backend.downloadCalls === 1) throw new Error("download interrupted");
    return Buffer.from("recovered-video");
  };
  const tool = createMediaTools(config(cwd), backend).find((item) => item.name === "generate_video")!;
  const context = { cwd, approve: async () => true };
  const first = await executeTool(tool, { prompt: "move", output_path: "out.mp4", num_frames: 121 }, context);
  const second = await executeTool(tool, { prompt: "move", output_path: "out.mp4", num_frames: 121 }, context);
  assert.match(first, /Repeat the same request to resume/);
  assert.equal(backend.videoCalls, 1);
  assert.equal(backend.downloadCalls, 2);
  assert.equal(await fs.readFile(path.join(cwd, "out.mp4"), "utf8"), "recovered-video");
  assert.match(second, /Generated video/);
});

test("an ambiguous video submission is not recreated without explicit force", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-video-ambiguous-"));
  const backend = new MockMediaBackend();
  backend.createVideo = async () => {
    backend.videoCalls += 1;
    throw new Error("Connection error token=private-video-token");
  };
  const tool = createMediaTools(config(cwd), backend).find((item) => item.name === "generate_video")!;
  const approvals: string[] = [];
  const context = { cwd, approve: async (request: { risk: string }) => { approvals.push(request.risk); return true; } };
  const first = await executeTool(tool, { prompt: "uncertain", output_path: "out.mp4" }, context);
  const second = await executeTool(tool, { prompt: "uncertain", output_path: "out.mp4" }, context);
  assert.equal(backend.videoCalls, 1);
  assert.deepEqual(approvals, ["dangerous", "dangerous"]);
  assert.match(first, /unknown submission outcome/);
  assert.doesNotMatch(first, /private-video-token/);
  assert.match(second, /will not submit it again automatically/);
  await executeTool(tool, { prompt: "uncertain", output_path: "out.mp4", force_new_generation: true }, context);
  assert.equal(backend.videoCalls, 2);
});

test("a cancelled video poll preserves the task id and resumes without a duplicate submission", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-video-cancel-"));
  const backend = new MockMediaBackend();
  const controller = new AbortController();
  backend.createVideo = async (request) => {
    backend.videoCalls += 1;
    backend.videoRequest = request;
    controller.abort();
    return { id: "video-resume", status: "queued" };
  };
  backend.getVideo = async (id) => ({ id, status: "completed", url: "https://assets.example/resumed.mp4" });
  const tool = createMediaTools(config(cwd), backend).find((item) => item.name === "generate_video")!;
  const first = await executeTool(tool, { prompt: "resume", output_path: "out.mp4" }, {
    cwd, approve: async () => true, signal: controller.signal,
  });
  const second = await executeTool(tool, { prompt: "resume", output_path: "out.mp4" }, { cwd, approve: async () => true });
  assert.match(first, /Task cancelled/);
  assert.equal(backend.videoCalls, 1);
  assert.equal(await fs.readFile(path.join(cwd, "out.mp4"), "utf8"), "video-bytes");
  assert.match(second, /video-resume/);
});

test("video polling absorbs transient 429 responses and keeps the same task", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-video-poll-limit-"));
  const backend = new MockMediaBackend();
  let polls = 0;
  backend.getVideo = async (id) => {
    polls += 1;
    if (polls === 1) throw new MediaApiError("Media API request failed (429): status query rate limit", 429, 1);
    return { id, status: "completed", url: "https://assets.example/polled.mp4" };
  };
  const request = { prompt: "poll", image: undefined, keyframes: undefined, width: 1152, height: 768, numFrames: 121, frameRate: 24, negativePrompt: undefined, seed: undefined };
  const key = mediaOperationKey("video", "agnes", "video-model", request);
  const store = new MediaOperationStore(cwd);
  await store.begin({ key, kind: "video", providerId: "agnes", model: "video-model" });
  await store.update(key, { status: "submitted", taskId: "existing-task" });
  const tool = createMediaTools(config(cwd), backend).find((item) => item.name === "generate_video")!;
  const result = await executeTool(tool, { prompt: "poll", output_path: "out.mp4" }, { cwd, approve: async () => true });
  assert.equal(backend.videoCalls, 0);
  assert.equal(polls, 2);
  assert.match(result, /existing-task/);
});

test("a rejected video submission activates a provider-wide cooldown for prompt variants", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-video-cooldown-"));
  const backend = new MockMediaBackend();
  backend.createVideo = async () => {
    backend.videoCalls += 1;
    throw new MediaApiError("Media API request failed (429): allows 2 requests per 1 minute(s)", 429, 60_000);
  };
  const tool = createMediaTools(config(cwd), backend).find((item) => item.name === "generate_video")!;
  const context = { cwd, approve: async () => true };
  const first = await executeTool(tool, { prompt: "first", output_path: "first.mp4" }, context);
  const second = await executeTool(tool, { prompt: "different prompt", output_path: "second.mp4" }, context);
  assert.equal(backend.videoCalls, 1);
  assert.match(first, /rejected before a task ID/);
  assert.match(second, /cooldown is active/);
});

test("provider capability profiles only expose supported media tools", () => {
  const cwd = process.cwd();
  const openai = createMediaTools({ provider: "openai", model: "gpt", cwd, maxTurns: 5, autoApprove: true });
  const anthropic = createMediaTools({ provider: "anthropic", model: "claude", cwd, maxTurns: 5, autoApprove: true });
  const agnes = createMediaTools(config(cwd));
  assert.deepEqual(openai.map((tool) => tool.name), ["analyze_image"]);
  assert.deepEqual(anthropic.map((tool) => tool.name), ["analyze_image"]);
  assert.deepEqual(agnes.map((tool) => tool.name), ["analyze_image", "generate_image", "generate_video"]);
});

test("a compatible provider with vision disabled exposes no media tools", () => {
  const tools = createMediaTools({
    provider: "openai-compatible", providerId: "local", model: "coder", cwd: process.cwd(), autoApprove: true,
    providerFeatures: { text: true, tools: true, vision: false, image: false, video: false },
  });
  assert.deepEqual(tools, []);
});
