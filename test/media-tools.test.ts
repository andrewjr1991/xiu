import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../src/config.js";
import { createMediaTools } from "../src/media-tools.js";
import type { ImageGenerationRequest, MediaBackend, VideoGenerationRequest, VideoTask } from "../src/media.js";
import { executeTool } from "../src/tools.js";

class MockMediaBackend implements MediaBackend {
  imageRequest?: ImageGenerationRequest;
  videoRequest?: VideoGenerationRequest;
  analyzedImage?: string;

  async analyzeImage(_prompt: string, image: string): Promise<string> {
    this.analyzedImage = image;
    return "The image contains a blue square.";
  }

  async generateImage(request: ImageGenerationRequest) {
    this.imageRequest = request;
    return { url: "https://assets.example/generated.png" };
  }

  async createVideo(request: VideoGenerationRequest): Promise<VideoTask> {
    this.videoRequest = request;
    return { id: "video-1", status: "completed", progress: 100, url: "https://assets.example/generated.mp4" };
  }

  async getVideo(): Promise<VideoTask> {
    throw new Error("completed tasks should not be polled");
  }

  async download(url: string): Promise<Buffer> {
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
  assert.match(progress[0], /Generating image/);
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
