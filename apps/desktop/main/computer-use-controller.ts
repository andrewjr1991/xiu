import { BrowserWindow, dialog, nativeImage, session } from "electron";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { previewReviewFile } from "../../../src/runtime/review.js";
import { resolveWorkspacePath } from "../../../src/workspace-path.js";
import { secureWebPreferences } from "./security-policy.js";
import type { ComputerUseRequest, ComputerUseState } from "../shared/computer-use.js";
import type { ComputerElement, ComputerInput, ComputerWindow } from "../shared/computer-use.js";
import { WindowsComputer } from "./windows-computer.js";
import { confirmComputerAction } from "./full-access-dialog.js";
import { ComputerStatusWindow } from "./computer-status-window.js";
import { AUTOMATIC_INPUT_LIMIT, FRAME_MAX_BYTES, MANUAL_DURATION_MS, MANUAL_INPUT_LIMIT, dataUrlBytes, frameScale, inputNeedsConfirmation, inspectionNotice, isUninspectedControl, mayReuseMergedGrant, nextTaskBudget, scaleElements, scaledSize, toClientCoordinate, type ComputerTaskBudget } from "./computer-use-policy.js";
import { FRAME_TTL_MS } from "../../../src/computer-use-tools.js";
import { MAX_KEY_REPEAT, POINTER_KINDS, REPEATABLE_KEYS, inputTier, isRepeatableKey } from "../shared/computer-use-inputs.js";
import { isBlockedApp, isSensitiveWindowTitle } from "../shared/computer-use-sensitive.js";
import type { ControlInspection } from "../shared/computer-use.js";

/** What leaves the machine besides the screenshot; shown in every consent dialog (0.20.8 review C4). */
const DISCLOSURE = "截图只发送到上述渠道（支持视觉的对话模型会直接看到截图，否则由独立视觉请求转述）；窗口里的控件名称和视觉描述会返回给当前对话模型并写入会话历史；截图本身只在内存中保留最新一帧，不写历史、不保存。";

const assetTypes: Record<string, string> = { ".html": "text/html", ".htm": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg" };
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Ephemeral target-window authority. Models may suggest targets; only user consent grants authority. */
export class ComputerUseController {
  private readonly native: WindowsComputer;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private selected?: ComputerWindow;
  private candidates: ComputerWindow[] = [];
  private expires = 0;
  private inputs = 0;
  private boundTask?: string;
  private activeTask?: string;
  private automaticProvider?: string;
  private authority = new AbortController();
  private target?: BrowserWindow;
  private root?: string;
  private value: ComputerUseState = { state: "idle" };
  private generation = 0;
  private opening = false;
  private openingWorkspace?: string;
  /** User-confirmed automatic operation for one workspace and vision route; set by the Full Access dialog or the panel's own dialog, never by the model. */
  private automaticGrant?: { workspace: string; provider: string };
  /** Client size of the current frame; model-facing coordinates are frame pixels (client × scale). */
  private client?: { width: number; height: number; scale: number };
  // Survives stop() so re-selecting a window cannot reset the automatic allowance.
  private taskBudget?: ComputerTaskBudget;
  private readonly indicator: ComputerStatusWindow;
  private paused = false;
  constructor(private readonly owner: BrowserWindow, native?: WindowsComputer, stop?: () => void) { this.native = native ?? new WindowsComputer(); this.indicator = new ComputerStatusWindow(stop ?? (() => this.stop()), () => this.togglePause()); }
  grantFullAccess(workspace: string, provider: string): void { this.grantAutomatic(workspace, provider); }
  grantAutomatic(workspace: string, provider: string): void { this.automaticGrant = { workspace, provider }; this.value = { ...this.value, automaticGranted: true }; }
  revokeFullAccess(): void { this.revokeAutomatic(); }
  revokeAutomatic(): void { this.automaticGrant = undefined; this.stop(); }
  private automaticGrantMatches(workspace: string, provider: string): boolean { return this.automaticGrant?.workspace === workspace && this.automaticGrant.provider === provider; }
  /** The panel's own way into automatic mode: one main-process dialog, in memory only, same limits and revocation as the Full Access route. */
  async requestAutomatic(workspace: string, provider: string): Promise<ComputerUseState> {
    this.retainWorkspace(workspace);
    const generation = this.generation;
    const accepted = await confirmComputerAction(this.owner, "允许 Xiu 在本工作区自动操作窗口？", `视觉渠道/模型与发送目的地：${provider}\n开启后，本工作区的任务在你选定目标窗口时不再逐步弹窗：连续截图发送到上述渠道、点击/双击/右键、普通文本、滚动和一级按键自动执行；拖拽、Ctrl+C/V/S 等二级输入和无法识别的控件仍每次单独确认。可能改变应用数据，不能保证撤销。\n${DISCLOSURE}\n每个任务最多 20 分钟或 100 步；任务结束、切换工作区、更换视觉渠道、关闭应用或点“撤销自动授权”即失效，不写入设置，不能从历史恢复。这不包含工作区外文件或命令权限。`, this.authority.signal);
    if (!accepted || generation !== this.generation) return { ...this.value };
    this.grantAutomatic(workspace, provider);
    return { ...this.value };
  }
  private phase(phase: string): void { if (this.selected) { const current = this.paused ? "已暂停" : phase; this.value = { ...this.value, phase: current, provider: this.automaticProvider }; this.indicator.update(current, this.selected.app, this.automaticProvider, this.paused); } }
  togglePause(): void { if (this.selected) { this.paused = !this.paused; this.phase(this.paused ? "已暂停" : "等待下一步"); } }
  private async waitForResume(signal?: AbortSignal): Promise<void> {
    const generation = this.generation;
    while (this.paused) { if (signal?.aborted || generation !== this.generation || Date.now() >= this.expires) throw new Error("电脑操作已取消或授权到期。"); await new Promise(resolve => setTimeout(resolve, 100)); }
    if (signal?.aborted || generation !== this.generation) throw new Error("电脑操作已取消。");
  }
  feedbackFinished(): void { this.phase("等待下一步"); }
  get hasBoundTask(): boolean { return this.boundTask !== undefined; }
  /** The controller's own dialogs stand in for the generic tool approval: selection always confirms (or reuses the user's grant), observe/input only once a target is authorized. */
  confirms(step: "select" | "observe" | "input"): boolean {
    if (step === "select") return true;
    return this.selected !== undefined && Date.now() < this.expires;
  }
  taskStarted(id: string): void { if (this.selected && !this.boundTask) this.boundTask = id; else this.stop(); this.activeTask = id; }
  taskFinished(): void { this.stop(); this.activeTask = undefined; this.taskBudget = undefined; }
  selectedStatus(): string {
    if (!this.selected) return "No authorized window. Use computer_windows to discover the requested application, then computer_select to request explicit target and screenshot consent. Never ask the user for coordinates.";
    const target = this.activeTarget(); return `Authorized target: ${target.app} · ${target.title}. Mode: ${this.automaticProvider ? "automatic within confirmed Full Access task scope" : "step-by-step confirmation"}. Steps: ${this.inputs}. Authorization expires in ${Math.max(0,Math.floor((this.expires-Date.now())/1000))}s. No other window is authorized.`;
  }
  async discover(workspace: string): Promise<ComputerWindow[]> {
    this.retainWorkspace(workspace);
    this.candidates = (await this.native.list()).filter(window => this.allowed(window));
    return this.candidates.map(window => ({ ...window, title: window.title.slice(0, 160) }));
  }
  async selectForModel(workspace: string, handle: string, provider: string, fullAccess: boolean, signal?: AbortSignal): Promise<string> {
    this.retainWorkspace(workspace);
    const picked = this.candidates.find(window => window.handle === handle);
    if (!picked || !this.activeTask) throw new Error("请先发现当前窗口；只能为正在运行的父任务请求授权。");
    const task = this.activeTask, generation = this.generation;
    // Automatic mode comes from a user-confirmed grant (Full Access dialog or the panel's own dialog) or a trusted Full Access context; never from the model.
    const grantMatches = this.automaticGrantMatches(workspace, provider);
    const automatic = fullAccess || grantMatches;
    const merged = mayReuseMergedGrant({ automatic, grantMatches, budget: this.taskBudget, task, now: Date.now() });
    const accepted = merged || await confirmComputerAction(this.owner, automatic ? "允许 Xiu 自动操作此窗口？" : "授权此任务的目标窗口", `${picked.app} · ${picked.title}\n视觉渠道/模型与发送目的地：${provider}\n${automatic ? "在你已确认的自动操作授权下，允许本任务连续截图并发送上述渠道、点击/双击/右键、普通文本输入、滚动和一级按键，不再逐步弹窗；拖拽、Ctrl+C/V/S 等二级输入仍每次确认。可能改变应用数据，不能保证撤销。" : "截图发送和每步输入仍分别确认。要连续自动操作，请在任务开始前在“电脑操作”面板开启自动操作授权。"}\n${DISCLOSURE}\n仅此窗口，不是整个桌面。请关闭密码、聊天、付款及其他敏感内容。不支持密码、支付、删除、发布、安装或系统设置流程；发现这些步骤必须停止交给用户。无法识别的控件每次都会单独询问。\n${automatic ? "20 分钟或 100 步" : "10 分钟或 30 步"}到期、窗口身份变化或标题变为敏感内容、任务结束或停止即撤销，不能从历史恢复。`, AbortSignal.any([this.authority.signal, ...(signal ? [signal] : [])]));
    if (!accepted || signal?.aborted || generation !== this.generation || this.activeTask !== task) throw new Error("窗口授权已取消或任务变化。");
    const current = (await this.native.list()).find(window => window.handle === picked.handle && window.pid === picked.pid && window.started === picked.started && window.title === picked.title);
    if (!current || !this.allowed(current) || generation !== this.generation || signal?.aborted) throw new Error("窗口已变化，请重新发现。");
    this.stop(); this.activeTask = task; this.boundTask = task; this.root = workspace; this.selected = current;
    this.automaticProvider = automatic ? provider : undefined;
    if (automatic) {
      this.taskBudget = nextTaskBudget(this.taskBudget, task, Date.now(), !merged);
      this.expires = this.taskBudget.deadline; this.inputs = this.taskBudget.inputs;
    } else this.expires = Date.now() + MANUAL_DURATION_MS;
    this.expiryTimer = setTimeout(() => this.stop(), Math.max(0, this.expires - Date.now())); this.expiryTimer.unref();
    this.value = { state: "observing", target: current, mode: automatic ? "automatic" : "manual", steps: this.inputs, expiresAt: new Date(this.expires).toISOString(), activity: [] };
    await this.activate(signal);
    this.phase("等待观察");
    return this.selectedStatus();
  }
  private async activate(signal?: AbortSignal): Promise<void> {
    const target = this.activeTarget(), generation = this.generation;
    try { await this.native.request({ ...target, action: "activate" }, signal); }
    catch (error) { if (generation === this.generation) this.stop(); throw error; }
    if (generation !== this.generation || signal?.aborted) throw new Error("窗口切换已取消。");
  }
  private record(action: string, status: "completed" | "failed" = "completed"): void {
    this.value = { ...this.value, steps: this.inputs, activity: [...(this.value.activity ?? []), { at: new Date().toISOString(), action, status }].slice(-40) };
  }
  private allowed(window: ComputerWindow): boolean {
    return window.pid !== process.pid && !isBlockedApp(window.app) && !isSensitiveWindowTitle(window.title);
  }
  private activeTarget(): ComputerWindow {
    if (!this.selected || Date.now() >= this.expires) { this.stop(); throw new Error("窗口授权未启用或已到期，请重新选择。"); }
    return this.selected;
  }
  async observeForModel(workspace: string, provider: string, signal?: AbortSignal): Promise<{ image: string; frameId: string; width: number; height: number; capturedAt?: string; elements?: ComputerElement[]; inspection?: ControlInspection }> {
    this.retainWorkspace(workspace); const target = this.activeTarget(), generation = this.generation;
    if (this.automaticProvider && this.automaticProvider !== provider) { this.revokeFullAccess(); throw new Error("视觉渠道已变化，旧的画面发送授权无效，请重新授权目标。"); }
    const accepted = this.automaticProvider === provider || await confirmComputerAction(this.owner, "允许发送目标窗口画面？", `目标：${target.app} · ${target.title}\n视觉渠道/模型：${provider}\n仅本次截图发送到该渠道，用于定位和验收。${DISCLOSURE}\n请隐藏密码、聊天、账号及其他敏感内容；不发送整个桌面。`, AbortSignal.any([this.authority.signal, ...(signal ? [signal] : [])]));
    if (!accepted || signal?.aborted || generation !== this.generation) throw new Error("画面发送已取消。");
    const state = await this.captureExternal(signal);
    if (generation !== this.generation || signal?.aborted) throw new Error("观察已停止。");
    this.record("观察目标窗口");
    this.phase("分析画面");
    return { image: state.screenshot!, frameId: state.frameId!, width: state.width!, height: state.height!, capturedAt: state.capturedAt, elements: state.elements, inspection: state.inspection };
  }
  private async captureExternal(signal?: AbortSignal): Promise<ComputerUseState> {
    await this.waitForResume(signal);
    const target = this.activeTarget(), generation = this.generation;
    this.phase("正在观察");
    let frame: ComputerWindow & { screenshot: string; elements?: ComputerElement[]; inspection?: ControlInspection };
    try { frame = await this.native.request({ ...target, action: "capture" }, signal); }
    catch (error) { if (generation === this.generation) this.stop(); throw error; }
    if (generation !== this.generation || !this.allowed(frame)) { this.stop(); throw new Error("目标窗口身份或敏感状态已变化，请重新授权。"); }
    this.selected = { handle: frame.handle, pid: frame.pid, started: frame.started, app: frame.app, title: frame.title, width: frame.width, height: frame.height };
    const scaled = this.scaleFrame(frame.screenshot, frame.width, frame.height);
    this.client = { width: frame.width, height: frame.height, scale: scaled.scale };
    this.value = { ...this.value, state: "observing", target: frame, screenshot: scaled.screenshot, elements: scaleElements(frame.elements ?? [], scaled.scale), inspection: frame.inspection ?? "unavailable", frameId: randomUUID(), width: scaled.width, height: scaled.height, scale: scaled.scale, capturedAt: new Date().toISOString() };
    // Never retain a second screenshot inside metadata.
    this.value.target = { ...this.selected };
    return { ...this.value };
  }
  /** Large windows are downscaled and oversized encodings re-encoded as JPEG before a frame reaches any model; dimensions and controls follow the same scale. */
  private scaleFrame(screenshot: string, width: number, height: number): { screenshot: string; width: number; height: number; scale: number } {
    const scale = frameScale(width, height);
    if (scale === 1 && dataUrlBytes(screenshot) <= FRAME_MAX_BYTES) return { screenshot, width, height, scale };
    const size = scaledSize(width, height, scale);
    let image = nativeImage.createFromDataURL(screenshot);
    if (image.isEmpty()) throw new Error("窗口截图无法解码，请重新观察。");
    if (scale < 1) image = image.resize({ ...size, quality: "good" });
    const png = image.toPNG();
    const encoded = png.length <= FRAME_MAX_BYTES ? `data:image/png;base64,${png.toString("base64")}` : `data:image/jpeg;base64,${image.toJPEG(85).toString("base64")}`;
    return { screenshot: encoded, ...size, scale };
  }
  async input(workspace: string, input: ComputerInput, signal?: AbortSignal, origin: "model" | "renderer" = "model"): Promise<string> {
    await this.waitForResume(signal);
    this.retainWorkspace(workspace); const target = this.activeTarget(), generation = this.generation;
    const tier = input ? inputTier(input) : undefined;
    if (!tier) throw new Error("不支持该输入或快捷键。只允许一级/二级按键，不支持 Win、Alt 组合或系统快捷键。");
    if (input.frameId !== this.value.frameId || !this.value.capturedAt || !this.client) throw new Error("frameId 不是最新一帧：每次 computer_observe 或 computer_input 返回的新帧才有效，旧帧已被消费。请使用最新结果里的 Frame。");
    const age = Date.now() - Date.parse(this.value.capturedAt);
    if (age > FRAME_TTL_MS) throw new Error(`截图已超过 ${FRAME_TTL_MS / 1000} 秒（已过 ${Math.round(age / 1000)} 秒），请重新观察后操作。`);
    const limit = this.automaticProvider ? AUTOMATIC_INPUT_LIMIT : MANUAL_INPUT_LIMIT;
    if (++this.inputs > limit) { this.stop(); throw new Error(`本次窗口授权已达 ${limit} 步，请重新授权。`); }
    const budget = this.taskBudget;
    if (this.automaticProvider && budget && budget.task === this.boundTask) budget.inputs = this.inputs;
    // Blank IDs (`""`, null) and IDs on type/key are dropped rather than refused: text and keys only
    // ever reach the focused control, so such a value is never a target and must not block the step.
    if (typeof input.elementId !== "string" || !input.elementId.trim() || input.kind === "type" || input.kind === "key") input = { ...input, elementId: undefined };
    if (input.elementId !== undefined) {
      const element = this.value.elements?.find(element => element.id === input.elementId);
      if (!element) throw new Error("该控件 ID 不在最新一帧的控件列表中。请使用最新结果列出的 ID，或改用截图坐标点击。");
      if (!element.enabled) throw new Error("该控件当前已禁用，未发送输入。");
      input = { ...input, x: Math.floor(element.x + element.width / 2), y: Math.floor(element.y + element.height / 2) };
    }
    const inside = (x: unknown, y: unknown) => Number.isInteger(x) && Number.isInteger(y) && (x as number) >= 0 && (y as number) >= 0 && (x as number) < this.value.width! && (y as number) < this.value.height!;
    // Validate a Codex-style multiline type action as ordinary text plus CR/LF. The native
    // bridge receives the original value and permits those line breaks only in Edit/Document.
    const originalTypedText = input.kind === "type" && typeof input.text === "string" ? input.text : undefined;
    if (originalTypedText !== undefined) input = { ...input, text: originalTypedText.replace(/\r\n?|\n/g, "") };
    if (POINTER_KINDS.includes(input.kind) && !inside(input.x, input.y)) throw new Error("坐标必须位于最新截图内。");
    if (input.kind === "drag" && (!inside(input.toX, input.toY) || (input.toX === input.x && input.toY === input.y))) throw new Error("拖拽终点必须位于最新截图内且不同于起点。");
    if (input.kind === "scroll" && (!Number.isInteger(input.delta) || !input.delta || Math.abs(input.delta) > 1200)) throw new Error("滚动量超限。");
    if (input.kind === "type" && (typeof input.text !== "string" || !input.text || input.text.length > 500 || /[\x00-\x1f\x7f]/.test(input.text))) throw new Error("仅允许 1–500 字普通文本，不允许控制字符。");
    if (originalTypedText !== undefined) input = { ...input, text: originalTypedText };
    if (input.kind !== "key" || input.repeat === undefined || input.repeat === null || input.repeat === 1) input = { ...input, repeat: undefined };
    else if (!Number.isInteger(input.repeat) || input.repeat < 1 || input.repeat > MAX_KEY_REPEAT || !isRepeatableKey(input.key ?? "")) throw new Error(`repeat 只能是 1–${MAX_KEY_REPEAT}，且只用于 ${REPEATABLE_KEYS.join("、")}；Enter、Tab、Esc 和组合键每步只按一次。`);
    const repeatLabel = input.repeat ? ` ×${input.repeat}` : "";
    const pointerLabel = { click: "左键单击", doubleclick: "左键双击", rightclick: "右键单击", drag: "拖拽", scroll: `滚动 ${input.delta}` }[input.kind as Exclude<ComputerInput["kind"], "type" | "key">];
    const detail = input.kind === "type" ? `输入文本：${input.text}` : input.kind === "key" ? `按键：${input.key}${repeatLabel}${tier === "confirm" ? "（二级，每次确认）" : ""}` : input.kind === "drag" ? `拖拽：(${input.x}, ${input.y}) → (${input.toX}, ${input.toY})（二级，每次确认）` : `${pointerLabel}：(${input.x}, ${input.y})`;
    const confirm = inputNeedsConfirmation({ automatic: Boolean(this.automaticProvider), origin, tier });
    const notice = inspectionNotice(this.value.inspection);
    const accepted = !confirm || await confirmComputerAction(this.owner, "确认此步窗口操作", `${target.app} · ${target.title}\n${detail}\n${notice ? `${notice}\n` : ""}请确认该操作不涉及密码、支付、删除、发布或系统设置。输入和点击可能不可撤销；只执行一次。`, AbortSignal.any([this.authority.signal, ...(signal ? [signal] : [])]));
    if (!accepted || signal?.aborted || generation !== this.generation) throw new Error("窗口操作已取消。");
    // Complete modal teardown before spawning the input helper from the foreground owner.
    if (confirm) { this.owner.focus(); await new Promise(resolve => setTimeout(resolve, 150)); }
    const windows = await this.native.list();
    this.activeTarget();
    if (input.frameId !== this.value.frameId || !this.value.capturedAt || Date.now() - Date.parse(this.value.capturedAt) > FRAME_TTL_MS) throw new Error("截图在确认期间已失效，请重新观察。");
    const current = windows.find(window => window.handle === target.handle && window.pid === target.pid && window.started === target.started);
    if (!current || !this.allowed(current) || generation !== this.generation || signal?.aborted) { this.stop(); throw new Error("窗口已变化，未执行输入。"); }
    this.selected = current;
    // The helper works in client pixels: map frame coordinates back and hand it the client size it must still match.
    const { width, height, scale } = this.client;
    const client = (value: number | undefined, extent: number) => value === undefined ? undefined : toClientCoordinate(value, scale, extent);
    this.value = { ...this.value, frameId: undefined }; // Consume before side effects; unknown outcomes are never replayed.
    this.phase("正在操作");
    const send = (allowUninspected: boolean) => this.native.request({ ...current, action: input.kind, width, height, elementId: input.elementId, x: client(input.x, width), y: client(input.y, height), toX: client(input.toX, width), toY: client(input.toY, height), delta: input.delta, text: input.text, key: input.key, repeat: input.repeat, allowUninspected }, signal);
    try {
      try { await send(false); }
      catch (error) {
        // The helper could not read the control under the pointer or in focus, so its password and
        // high-risk checks did not run. Nothing was sent yet; only the user may let this one step through.
        if (!isUninspectedControl(error) || generation !== this.generation || signal?.aborted) throw error;
        this.phase("等待确认");
        const allowed = await confirmComputerAction(this.owner, "无法识别目标控件，仍要执行？", `${current.app} · ${current.title}\n${detail}\n程序读不到该位置或当前焦点控件的名称和类型，无法判断它是否是密码框、发送、支付或删除等高风险控件。只有你能看到并确认这一步安全时才继续；取消将撤销本次授权。`, AbortSignal.any([this.authority.signal, ...(signal ? [signal] : [])]));
        if (!allowed || generation !== this.generation || signal?.aborted) throw new Error("窗口操作已取消。");
        this.owner.focus(); await new Promise(resolve => setTimeout(resolve, 150));
        if (!this.value.capturedAt || Date.now() - Date.parse(this.value.capturedAt) > FRAME_TTL_MS) throw new Error("截图在确认期间已失效，请重新观察。");
        const latest = (await this.native.list()).find(window => window.handle === current.handle && window.pid === current.pid && window.started === current.started);
        if (!latest || !this.allowed(latest) || generation !== this.generation || signal?.aborted) throw new Error("窗口已变化，未执行输入。");
        this.phase("正在操作");
        await send(true);
      }
      this.record(({ click: "点击", doubleclick: "双击", rightclick: "右键", drag: "拖拽", type: "输入普通文本", key: "按键", scroll: "滚动" })[input.kind]); this.phase("等待界面反馈");
    }
    catch (error) { if (generation === this.generation) this.stop(); throw new Error(`${error instanceof Error ? error.message : "窗口输入失败。"} 本次授权已撤销。`); }
    return "已发送一次窗口输入；不代表界面结果已验证。请重新观察，检查实际反馈。";
  }
  retainWorkspace(workspace?: string): void { if (this.automaticGrant && this.automaticGrant.workspace !== workspace) { this.automaticGrant = undefined; this.value = { ...this.value, automaticGranted: false }; } if (this.root && this.root !== workspace || this.openingWorkspace && this.openingWorkspace !== workspace) this.stop(); }
  stop(): ComputerUseState {
    this.generation++;
    clearTimeout(this.expiryTimer); this.expiryTimer = undefined;
    this.authority.abort(); this.authority = new AbortController();
    this.native.stop(); this.selected = undefined; this.candidates = []; this.boundTask = undefined; this.automaticProvider = undefined; this.expires = 0; this.inputs = 0;
    this.indicator.close();
    this.paused = false;
    const target = this.target;
    this.target = undefined; this.root = undefined; this.client = undefined; this.value = { state: "idle", automaticGranted: Boolean(this.automaticGrant) };
    if (target && !target.isDestroyed()) target.destroy();
    return { ...this.value };
  }
  async control(workspace: string, request: ComputerUseRequest, planMode: boolean): Promise<ComputerUseState> {
    this.retainWorkspace(workspace);
    if (request?.action === "stop") return this.stop();
    if (request?.action === "automatic-revoke") { this.revokeAutomatic(); return { ...this.value }; }
    if (request?.action === "state") {
      if (this.selected) {
        const generation = this.generation;
        try { const current = await this.native.request<ComputerWindow>({ ...this.activeTarget(), action: "status" }); if (!this.allowed(current)) throw new Error("sensitive target"); this.selected = current; this.value = { ...this.value, target: current }; }
        catch { if (generation === this.generation) this.stop(); }
      }
      return { ...this.value };
    }
    if (planMode) throw new Error("Plan 只读模式不能启动或截图电脑操作预览。");
    if (process.platform !== "win32") throw new Error("当前仅提供 Windows 本地网页受控预览。");
    if (request.action === "windows") { this.candidates = (await this.native.list()).filter(window => this.allowed(window)); return { ...this.value, windows: this.candidates }; }
    if (request.action === "select") {
      const picked = this.candidates.find(window => window.handle === request.handle);
      if (!picked) throw new Error("请刷新并选择当前窗口。");
      const generation = this.generation;
      const accepted = await confirmComputerAction(this.owner, "授权此目标窗口", `${picked.app} · ${picked.title}\n允许本次查看该窗口截图，并在每步独立确认后点击、输入或滚动。后续发送截图给模型仍会单独确认；${DISCLOSURE}\n窗口身份变化或标题变为敏感内容即撤销，10 分钟或 30 步到期；不包含其他窗口、管理员、密码、支付或系统设置。`, this.authority.signal);
      if (!accepted || generation !== this.generation) return { ...this.value };
      const current = (await this.native.list()).find(window => window.handle === picked.handle && window.pid === picked.pid && window.started === picked.started && window.title === picked.title);
      if (!current || !this.allowed(current) || generation !== this.generation) throw new Error("窗口已变化，请重新选择。");
      this.stop(); this.root = workspace; this.selected = current; this.expires = Date.now() + MANUAL_DURATION_MS;
      this.expiryTimer = setTimeout(() => this.stop(), MANUAL_DURATION_MS); this.expiryTimer.unref();
      this.value = { state: "observing", target: current }; await this.activate(); this.phase("等待观察"); return { ...this.value };
    }
    if (request.action === "input") { await this.input(workspace, request.input, undefined, "renderer"); return { ...this.value }; }
    if (request.action === "capture" && this.selected) return this.captureExternal();
    if (request?.action === "capture") {
      const target = this.target, generation = this.generation;
      if (!target || target.isDestroyed() || this.root !== workspace) throw new Error("请先选择并授权本地页面。");
      const image = await target.webContents.capturePage();
      if (generation !== this.generation || target.isDestroyed()) throw new Error("观察已停止，截图已丢弃。");
      this.value = { ...this.value, screenshot: image.resize({ width: Math.min(1280, image.getSize().width) }).toDataURL(), capturedAt: new Date().toISOString() };
      return { ...this.value };
    }
    if (request?.action !== "open" || this.opening) throw new Error("无效请求或窗口选择正在进行。");
    this.opening = true;
    this.openingWorkspace = workspace;
    const generation = ++this.generation;
    try {
      const picked = await dialog.showOpenDialog(this.owner, { title: "选择工作区内的本地验收页面", defaultPath: workspace, filters: [{ name: "HTML 页面", extensions: ["html", "htm"] }], properties: ["openFile"] });
      if (picked.canceled || !picked.filePaths[0] || generation !== this.generation) return { ...this.value };
      const targetPath = resolveWorkspacePath(workspace, picked.filePaths[0]);
      const relative = path.relative(workspace, targetPath).replace(/\\/g, "/");
      if (!/\.html?$/i.test(relative)) throw new Error("请选择 HTML 页面。");
      const initial = await previewReviewFile(workspace, relative);
      if (initial.truncated || initial.source === undefined) throw new Error("页面不可安全读取或超过预览大小限制。");
      const confirmed = await dialog.showMessageBox(this.owner, { type: "warning", title: "授权受控本地网页验收", buttons: ["取消", "仅本次打开并允许本地截图"], defaultId: 0, cancelId: 0, noLink: true, message: relative,
        detail: "将在独立沙箱窗口执行该页面及其所在目录的 JS/CSS/图片资源。禁止联网、弹窗、下载、文件写入和系统访问。截图仅在你点击观察时生成并留在当前界面，不保存或发送模型。此授权不包含外部桌面、自动点击或输入；关闭窗口、切换工作区或退出即失效。" });
      if (confirmed.response !== 1 || generation !== this.generation) return { ...this.value };
      this.stop();
      const activeGeneration = this.generation;
      this.root = workspace;
      const partition = session.fromPartition(`xiu-computer-preview-${randomUUID()}`);
      const scope = path.posix.dirname(relative);
      partition.setPermissionCheckHandler(() => false);
      partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      partition.on("will-download", event => event.preventDefault());
      partition.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("xiu-preview://local/") || !["GET", "HEAD"].includes(details.method) }));
      partition.protocol.handle("xiu-preview", async request => {
        try {
          if (activeGeneration !== this.generation || this.root !== workspace || !["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 403 });
          const url = new URL(request.url);
          const asset = decodeURIComponent(url.pathname).replace(/^\//, "");
          if (url.host !== "local" || url.username || url.password || asset.includes("\\") || asset.includes(":")) return new Response(null, { status: 403 });
          const normalized = path.posix.normalize(asset);
          if (scope !== "." && normalized !== scope && !normalized.startsWith(`${scope}/`)) return new Response(null, { status: 403 });
          const mime = assetTypes[path.extname(normalized).toLowerCase()];
          if (!mime) return new Response(null, { status: 403 });
          const file = await previewReviewFile(workspace, normalized);
          if (file.truncated) return new Response(null, { status: 413 });
          const content = file.source ?? (file.dataUrl ? Buffer.from(file.dataUrl.split(",")[1]!, "base64") : undefined);
          if (content === undefined || activeGeneration !== this.generation) return new Response(null, { status: 403 });
          return new Response(request.method === "HEAD" ? null : content, { headers: { "Content-Type": mime, "Content-Security-Policy": CSP, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
        } catch { return new Response(null, { status: 403 }); }
      });
      const target = new BrowserWindow({ width: 1000, height: 760, show: false, title: "Xiu · 受控验收（关闭即停止）", autoHideMenuBar: true, webPreferences: { ...secureWebPreferences, session: partition, devTools: false } });
      this.target = target;
      target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      target.webContents.on("will-navigate", event => event.preventDefault());
      target.webContents.on("will-redirect", event => event.preventDefault());
      target.webContents.on("will-attach-webview", event => event.preventDefault());
      target.on("closed", () => { if (this.target === target) this.stop(); });
      target.webContents.on("render-process-gone", () => { if (this.target === target) this.stop(); });
      try {
        await target.loadURL(`xiu-preview://local/${relative.split("/").map(encodeURIComponent).join("/")}`);
        if (activeGeneration !== this.generation || target.isDestroyed()) throw new Error("预览已取消。");
        this.value = { state: "observing", path: relative }; target.show(); return { ...this.value };
      } catch (error) { if (this.target === target) this.stop(); throw error; }
    } finally { this.opening = false; this.openingWorkspace = undefined; }
  }
}
