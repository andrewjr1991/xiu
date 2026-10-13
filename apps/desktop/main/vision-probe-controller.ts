import { createMediaBackend } from "../../../src/media.js";
import { createVisionChallenge, verifyVisionChallenge, visionProbePrompt } from "../../../src/vision-probe.js";
import { computerVisionRoute } from "../../../src/computer-use-tools.js";
import type { AgentConfig } from "../../../src/config.js";

export interface VisionProbeResult { status: "passed" | "failed" | "unknown" | "cancelled"; message: string }
export interface VisionProbeProgress { total: number; current?: string; results: Array<VisionProbeResult & { model: string }> }
export class VisionProbeController {
  private active?: AbortController;
  private batch?: AbortController;
  private progress: VisionProbeProgress = { total: 0, results: [] };
  snapshot(): VisionProbeProgress { return this.batch ? { ...this.progress, results: this.progress.results.map(result => ({ ...result })) } : { total: 0, results: [] }; }
  cancel(): void { this.batch?.abort(); this.active?.abort(); }
  async runBatch(configs: AgentConfig[], confirm: (route: string, signal: AbortSignal) => Promise<boolean>, validate: () => Promise<void>, analyze?: (config: AgentConfig, prompt: string, image: string, signal: AbortSignal) => Promise<string>): Promise<VisionProbeResult & { results: VisionProbeProgress["results"] }> {
    if (this.batch || this.active) throw new Error("已有视觉测试正在进行。");
    if (!configs.length || configs.length > 200) throw new Error("批量视觉测试需要 1–200 个候选；请先整理渠道模型列表。");
    const models = new Set(configs.map(config => config.capabilities?.vision ?? config.model));
    if (models.size !== configs.length) throw new Error("批量模型不能重复。");
    const batch = new AbortController(); this.batch = batch;
    this.progress = { total: configs.length, results: [] };
    const timer = setTimeout(() => this.cancel(), 120_000);
    try {
      const route = `共 ${configs.length} 个模型，每个最多一次请求（最多 ${configs.length} 次，可能分别计费）。\n${configs.map(computerVisionRoute).join("\n")}`;
      if (await confirm(route, batch.signal) && !batch.signal.aborted) {
        clearTimeout(timer);
        for (const config of configs) {
          if (batch.signal.aborted) break;
          await validate();
          if (batch.signal.aborted) break;
          const model = config.capabilities?.vision ?? config.model;
          this.progress.current = model;
          const result = await this.runOne(config, async () => !batch.signal.aborted, validate, analyze ? (prompt, image, signal) => analyze(config, prompt, image, signal) : undefined);
          this.progress.results.push({ model, ...result });
        }
      } else batch.abort();
      return { status: batch.signal.aborted ? "cancelled" : this.progress.results.every(result => result.status === "passed") ? "passed" : "unknown", message: `批量测试${batch.signal.aborted ? "已取消" : "已结束"}：完成 ${this.progress.results.length}/${configs.length}；未开始的模型不会发送请求。`, results: this.snapshot().results };
    } finally { clearTimeout(timer); this.progress.current = undefined; this.batch = undefined; }
  }
  async run(...args: Parameters<VisionProbeController["runOne"]>): Promise<VisionProbeResult> {
    if (this.batch) throw new Error("已有视觉测试正在进行。");
    this.progress = { total: 0, results: [] };
    return this.runOne(...args);
  }
  private async runOne(config: AgentConfig, confirm: (route: string, signal: AbortSignal) => Promise<boolean>, validate: () => Promise<void>, analyze = (prompt: string, image: string, signal: AbortSignal) => createMediaBackend(config, { maxRetries: 0 }).analyzeImage!(prompt, image, signal), timeoutMs = 60_000): Promise<VisionProbeResult> {
    if (this.active) throw new Error("已有视觉测试正在进行。");
    const controller = new AbortController(); this.active = controller;
    const route = computerVisionRoute(config);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = (): VisionProbeResult => ({ status: "cancelled", message: "视觉测试已取消；已发送的请求仍可能计费。" });
    try {
      timer = setTimeout(() => controller.abort(), 120_000);
      if (!await confirm(route, controller.signal) || controller.signal.aborted) return cancelled();
      await validate();
      if (controller.signal.aborted) return cancelled();
      clearTimeout(timer);
      let timedOut = false;
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      const challenge = createVisionChallenge();
      const answer = await Promise.race([Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error("cancelled");
        return analyze(visionProbePrompt, challenge.image, controller.signal);
      }), new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        if (controller.signal.aborted) reject(new Error("cancelled"));
      })]).catch(() => undefined);
      if (controller.signal.aborted) return timedOut ? { status: "unknown", message: "视觉测试超时，无法确认；不会自动重试。" } : cancelled();
      await validate();
      const status = answer === undefined ? "unknown" : verifyVisionChallenge(answer, challenge.code);
      if (controller.signal.aborted) return cancelled();
      const detail = status === "passed" ? "测试通过：正确识别随机测试图。仅证明本次基础看图能力，不代表电脑操作可靠性。" : status === "failed" ? "测试未通过：识别结果与随机测试图不一致。" : "无法确认：请求失败或答案无法核对；不等于不支持视觉。";
      return { status, message: `${route} · ${detail}` };
    } finally { clearTimeout(timer); this.active = undefined; }
  }
}
