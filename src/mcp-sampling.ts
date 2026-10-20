import type { ApprovalRequest, ConversationMessage, ModelProvider, ToolContext } from "./types.js";

/**
 * MCP Sampling (`sampling/createMessage`): a connected server asks Xiu to run the user's
 * model on a prompt the server composed and to hand the answer back. Xiu serves it only
 * while the user is already inside a tool call of that same server, only after the user
 * confirms each request, only with text, and never with the conversation, tools, files or
 * workspace attached. The server pays nothing; the request is billed to the user's key.
 */

export const MCP_SAMPLING_LIMITS = {
  /** Messages per request. */
  messages: 32,
  /** Characters across all message texts. */
  totalCharacters: 64_000,
  /** Characters of the server's system prompt. */
  systemCharacters: 16_000,
  /** Upper bound applied to the server's maxTokens. */
  maxTokens: 4_096,
  /** Requests served inside one tool call. */
  requestsPerCall: 8,
  /** Wall-clock budget for one model answer. */
  timeoutMs: 120_000,
} as const;

/** JSON-RPC error codes the server receives; -32602 invalid params, -32601 not served, -32000 refused or failed. */
export class McpSamplingError extends Error {
  constructor(readonly code: -32602 | -32601 | -32000, message: string) {
    super(message);
    this.name = "McpSamplingError";
  }
}

/** The model that answers sampling: whatever the task currently talks to, read at request time. */
export interface McpSamplingModel {
  provider: ModelProvider;
  providerId: string;
  providerLabel?: string;
  model: string;
}

export type McpSamplingModelSource = () => McpSamplingModel | undefined;

export interface McpSamplingRequest {
  messages: ConversationMessage[];
  systemPrompt?: string;
  maxTokens: number;
}

export interface McpSamplingResult {
  role: "assistant";
  content: { type: "text"; text: string };
  model: string;
  stopReason: "endTurn" | "maxTokens";
}

const PREAMBLE = "You are answering a request that an MCP server relayed through Xiu on the user's behalf. You have no tools, no files and no access to the user's conversation or workspace; answer only from the messages below.";

function invalid(message: string): McpSamplingError {
  return new McpSamplingError(-32602, `Invalid sampling request: ${message}`);
}

/**
 * Validates and bounds a `sampling/createMessage` params object. Anything beyond plain text
 * turns (images, audio, tool use, server-side tool definitions, requests to include Xiu's own
 * context) is refused rather than approximated.
 */
export function parseSamplingRequest(params: unknown): McpSamplingRequest {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw invalid("params must be an object");
  const record = params as Record<string, unknown>;
  if (record.includeContext !== undefined && record.includeContext !== "none") throw invalid("Xiu never shares its conversation context (includeContext must be omitted or \"none\")");
  if (record.tools !== undefined || record.toolChoice !== undefined) throw invalid("Xiu does not run tools on behalf of a server");
  if (!Array.isArray(record.messages) || !record.messages.length) throw invalid("messages must be a non-empty array");
  if (record.messages.length > MCP_SAMPLING_LIMITS.messages) throw invalid(`at most ${MCP_SAMPLING_LIMITS.messages} messages`);
  let total = 0;
  const messages: ConversationMessage[] = record.messages.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw invalid(`message ${index} must be an object`);
    const message = raw as Record<string, unknown>;
    if (message.role !== "user" && message.role !== "assistant") throw invalid(`message ${index} role must be user or assistant`);
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    const texts = blocks.map((block) => {
      if (!block || typeof block !== "object" || (block as Record<string, unknown>).type !== "text" || typeof (block as Record<string, unknown>).text !== "string") {
        throw invalid(`message ${index} must contain text content only`);
      }
      return (block as { text: string }).text;
    });
    const content = texts.join("\n");
    total += content.length;
    if (total > MCP_SAMPLING_LIMITS.totalCharacters) throw invalid(`messages exceed ${MCP_SAMPLING_LIMITS.totalCharacters} characters`);
    return { role: message.role, content };
  });
  let systemPrompt: string | undefined;
  if (record.systemPrompt !== undefined) {
    if (typeof record.systemPrompt !== "string") throw invalid("systemPrompt must be a string");
    if (record.systemPrompt.length > MCP_SAMPLING_LIMITS.systemCharacters) throw invalid(`systemPrompt exceeds ${MCP_SAMPLING_LIMITS.systemCharacters} characters`);
    systemPrompt = record.systemPrompt;
  }
  if (typeof record.maxTokens !== "number" || !Number.isFinite(record.maxTokens) || record.maxTokens < 1) throw invalid("maxTokens must be a positive number");
  return { messages, systemPrompt, maxTokens: Math.min(Math.floor(record.maxTokens), MCP_SAMPLING_LIMITS.maxTokens) };
}

function excerpt(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}… [${value.length - limit} more characters]`;
}

/** What the user sees before confirming: who asks, which model answers, and the prompt itself (bounded). */
export function describeSamplingRequest(server: string, model: McpSamplingModel, request: McpSamplingRequest): ApprovalRequest {
  const label = model.providerLabel ?? model.providerId;
  const last = request.messages[request.messages.length - 1]!;
  const preview = [
    `Server: ${server}`,
    `Model: ${label} / ${model.model} (billed to your key; up to ${request.maxTokens} output tokens)`,
    `Messages: ${request.messages.length}; the answer goes back to the server, not into this task.`,
    request.systemPrompt ? `System prompt: ${excerpt(request.systemPrompt, 1_000)}` : "System prompt: (none)",
    `Last message (${last.role}): ${excerpt(last.content, 2_000)}`,
  ].join("\n");
  return { risk: "dangerous", description: `answer a model sampling request from MCP server ${server} with ${label} / ${model.model}`, preview, sessionScope: `mcp-sampling:${server}` };
}

function stopReason(finish: string | undefined): McpSamplingResult["stopReason"] {
  return finish === "length" ? "maxTokens" : "endTurn";
}

/**
 * Serves one server's sampling requests. `begin()` marks a tool call of this server as
 * in flight and lends its approval channel and cancellation signal; `handle()` refuses
 * requests that arrive outside such a call, so a server can never spend the user's model
 * budget in the background, and caps the requests one call may make.
 */
export class McpSamplingBroker {
  private readonly calls: Array<{ context: ToolContext; served: number }> = [];

  constructor(private readonly server: string, private readonly modelSource: McpSamplingModelSource) {}

  /** Returns the release function; the caller invokes it when the tool call ends, however it ends. */
  begin(context: ToolContext): () => void {
    const entry = { context, served: 0 };
    this.calls.push(entry);
    return () => {
      const index = this.calls.indexOf(entry);
      if (index >= 0) this.calls.splice(index, 1);
    };
  }

  /** Active tool calls of this server (for status displays and tests). */
  active(): number { return this.calls.length; }

  async handle(params: unknown): Promise<McpSamplingResult> {
    const call = this.calls[this.calls.length - 1];
    if (!call) throw new McpSamplingError(-32000, `Xiu serves sampling for MCP server ${this.server} only while one of its tool calls is in progress.`);
    if (call.served >= MCP_SAMPLING_LIMITS.requestsPerCall) throw new McpSamplingError(-32000, `MCP server ${this.server} reached the limit of ${MCP_SAMPLING_LIMITS.requestsPerCall} sampling requests for this tool call.`);
    call.served += 1;
    const request = parseSamplingRequest(params);
    const model = this.modelSource();
    if (!model) throw new McpSamplingError(-32000, "No model is configured to answer sampling requests.");
    const cancelled = () => new McpSamplingError(-32000, "The sampling request was cancelled or timed out.");
    if (call.context.signal?.aborted) throw cancelled();
    const approved = await call.context.approve(describeSamplingRequest(this.server, model, request));
    if (!approved) throw new McpSamplingError(-32000, `The user declined the sampling request from MCP server ${this.server}.`);
    // The tool call may have been cancelled while the user was looking at the prompt.
    if (call.context.signal?.aborted) throw cancelled();
    const controller = new AbortController();
    const abort = () => controller.abort();
    call.context.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, MCP_SAMPLING_LIMITS.timeoutMs);
    try {
      const system = request.systemPrompt ? `${PREAMBLE}\n\n${request.systemPrompt}` : PREAMBLE;
      const turn = await model.provider.complete(system, request.messages, [], controller.signal);
      return { role: "assistant", content: { type: "text", text: turn.text }, model: model.model, stopReason: stopReason(turn.finishReason) };
    } catch (error) {
      if (error instanceof McpSamplingError) throw error;
      // The provider error text may quote the request or carry provider detail; the server gets a fixed sentence.
      throw controller.signal.aborted ? cancelled() : new McpSamplingError(-32000, "The model request failed.");
    } finally {
      clearTimeout(timer);
      call.context.signal?.removeEventListener("abort", abort);
    }
  }
}
