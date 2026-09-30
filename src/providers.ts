import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { AgentConfig } from "./config.js";
import { readEnvironmentCredential } from "./credential-store.js";
import type { AssistantTurn, AvailableModel, ConversationMessage, ModelProvider, ToolCall, ToolDefinition } from "./types.js";
import { SafeRequestCache } from "./request-cache.js";
import { createTrustedDispatcher } from "./trusted-dispatcher.js";

const modelDiscoveryCache = new SafeRequestCache(60_000, 100);

function openAIFinishReason(reason: string | null | undefined): NonNullable<AssistantTurn["finishReason"]> {
  if (reason === "stop" || reason === "tool_calls" || reason === "length" || reason === "content_filter") return reason;
  return "unknown";
}

function anthropicFinishReason(reason: string | null): NonNullable<AssistantTurn["finishReason"]> {
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  if (reason === "refusal") return "content_filter";
  return "unknown";
}

function finishedToolArguments(reason: AssistantTurn["finishReason"]): boolean {
  return reason === "stop" || reason === "tool_calls";
}

function parseToolInput(value: unknown, name: string): Record<string, unknown> {
  let input = value;
  if (typeof input === "string") {
    try { input = JSON.parse(input); }
    catch { throw new Error(`Invalid tool arguments from model for ${name}`); }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`Invalid tool arguments from model for ${name}`);
  return input as Record<string, unknown>;
}

/** Old sessions may only contain raw tool metadata; never send raw protocol objects back. */
function historyToolCalls(message: ConversationMessage): ToolCall[] {
  if (message.toolCalls !== undefined) return message.toolCalls;
  const raw = message.raw;
  const calls: ToolCall[] = [];
  if (Array.isArray(raw)) {
    for (const block of raw) {
      if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        calls.push({ id: block.id, name: block.name, input: parseToolInput(block.input, block.name) });
      }
    }
  } else if (raw && typeof raw === "object" && "tool_calls" in raw && Array.isArray(raw.tool_calls)) {
    for (const call of raw.tool_calls) {
      if (call?.type === "function" && typeof call.id === "string" && typeof call.function?.name === "string") {
        calls.push({ id: call.id, name: call.function.name, input: parseToolInput(call.function.arguments, call.function.name) });
      }
    }
  }
  return calls;
}

function openAIAssistantMessage(text: string, toolCalls: ToolCall[]): OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam {
  return {
    role: "assistant",
    content: text || null,
    ...(toolCalls.length ? { tool_calls: toolCalls.map((call) => ({
      id: call.id, type: "function" as const,
      function: { name: call.name, arguments: JSON.stringify(call.input) },
    })) } : {}),
  };
}

function anthropicAssistantContent(text: string, toolCalls: ToolCall[]): Anthropic.ContentBlockParam[] {
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...toolCalls.map((call) => ({ type: "tool_use" as const, id: call.id, name: call.name, input: call.input })),
  ];
}

function requestFingerprint(config: AgentConfig): string {
  return createHash("sha256").update(JSON.stringify({
    providerId: config.providerId,
    provider: config.provider,
    model: config.model,
    baseURL: config.baseURL,
    proxy: config.proxy,
    apiKeyEnv: config.apiKeyEnv,
    credentialRevision: config.credentialRevision ?? 0,
  })).digest("hex").slice(0, 24);
}

function openAIUsage(usage: OpenAI.Completions.CompletionUsage | undefined) {
  if (!usage) return undefined;
  const cacheReadInputTokens = Math.max(0, usage.prompt_tokens_details?.cached_tokens ?? 0);
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cacheReadInputTokens,
    cacheCreationInputTokens: 0,
  };
}

function openAIPromptCache(config: AgentConfig, system: string): { prompt_cache_key: string } | Record<string, never> {
  if (config.provider !== "openai") return {};
  const prompt_cache_key = createHash("sha256").update(`${config.model}\0${system}`).digest("hex").slice(0, 64);
  return { prompt_cache_key };
}

function discoveredContextWindow(model: object): number | undefined {
  const metadata = model as Record<string, unknown>;
  for (const key of ["context_window", "context_length", "max_model_len", "max_context_length", "input_token_limit"]) {
    const value = metadata[key];
    const numeric = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined;
    if (numeric !== undefined && Number.isInteger(numeric) && numeric >= 8_000) return numeric;
  }
  return undefined;
}

function discoveredCapabilities(model: object): string[] | undefined {
  const metadata = model as Record<string, unknown>;
  const values = [metadata.capabilities, metadata.modalities, metadata.input_modalities, metadata.output_modalities]
    .flatMap((value) => Array.isArray(value) ? value : value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>).filter(([, enabled]) => enabled === true).map(([name]) => name)
      : []);
  const normalized = [...new Set(values.flatMap((value) => {
    const item = String(value).toLowerCase();
    if (/image/.test(item)) return ["image"];
    if (/video/.test(item)) return ["video"];
    if (/audio|speech|voice/.test(item)) return ["audio"];
    if (/vision/.test(item)) return ["vision"];
    if (/text|chat/.test(item)) return ["text"];
    return [];
  }))];
  return normalized.length ? normalized : undefined;
}

function canRetryForcedToolProbeWithAuto(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
  if (status === 400 || status === 422) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /tool_choice|forced tool|force.*tool|thinking.*tool/i.test(message);
}

class OpenAIProvider implements ModelProvider {
  private client: OpenAI;
  constructor(private config: AgentConfig) {
    const apiKey = readEnvironmentCredential(config.apiKeyEnv)
      ?? config.apiKey
      ?? readEnvironmentCredential(config.provider === "agnes" ? "AGNES_API_KEY" : "OPENAI_API_KEY");
    const dispatcher = createTrustedDispatcher(config.proxy);
    this.client = new OpenAI({
      apiKey: apiKey || "xiu-local",
      baseURL: config.baseURL,
      fetchOptions: dispatcher ? { dispatcher } : undefined,
    });
  }

  async complete(system: string, messages: ConversationMessage[], tools: ToolDefinition[], signal?: AbortSignal): Promise<AssistantTurn> {
    const formatted = this.formatMessages(system, messages);
    const formattedTools = this.formatTools(tools);

    const response = await this.client.chat.completions.create({
      model: this.config.model,
      messages: formatted,
      ...openAIPromptCache(this.config, system),
      ...(formattedTools.length ? { tools: formattedTools, tool_choice: "auto" as const } : {}),
    }, { signal });
    const choice = response.choices[0];
    const message = choice?.message;
    if (!message) throw new Error("Model returned no message");
    const finishReason = openAIFinishReason(choice.finish_reason);
    const text = message.content ?? message.refusal ?? "";
    const toolCalls = finishedToolArguments(finishReason) ? this.parseToolCalls(message.tool_calls ?? []) : [];
    return {
      text,
      toolCalls,
      raw: openAIAssistantMessage(text, toolCalls),
      finishReason,
      usage: openAIUsage(response.usage),
    };
  }

  async listModels(): Promise<AvailableModel[]> {
    const models = await modelDiscoveryCache.run(`models:${requestFingerprint(this.config)}`, async () => {
      const page = await this.client.models.list();
      const models: AvailableModel[] = [];
      for await (const model of page) {
        models.push({ id: model.id, description: model.owned_by ? `Owned by ${model.owned_by}` : undefined, source: "api", capabilities: discoveredCapabilities(model), contextWindow: discoveredContextWindow(model) });
        if (models.length >= 200) break;
      }
      return models;
    });
    return models.map((model) => ({ ...model, capabilities: model.capabilities ? [...model.capabilities] : undefined }));
  }

  async probeToolSupport(signal?: AbortSignal): Promise<boolean> {
    const name = "xiu_capability_probe";
    const tool = { type: "function" as const, function: {
        name, description: "An inert capability probe. It performs no action.",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      } };
    const request = async (toolChoice: "auto" | { type: "function"; function: { name: string } }): Promise<boolean> => {
      const response = await this.client.chat.completions.create({
        model: this.config.model,
        messages: [{
          role: "user",
          content: "Use the xiu_capability_probe function with value OK. Do not answer in plain text; this request only verifies structured function calling.",
        }],
        tools: [tool],
        tool_choice: toolChoice,
      }, { signal });
      // Deliberately accept only the API's structured tool_calls field. Text such
      // as <tool_call>...</tool_call> is not executable protocol data.
      return Boolean(response.choices[0]?.message.tool_calls?.some((call) => call.type === "function" && call.function.name === name));
    };

    try {
      if (await request({ type: "function", function: { name } })) return true;
    } catch (error) {
      // Thinking models such as DashScope DeepSeek can support Function Calling
      // while rejecting a forced named tool. Their compatible API supports auto.
      if (!canRetryForcedToolProbeWithAuto(error)) throw error;
    }
    return request("auto");
  }

  async stream(system: string, messages: ConversationMessage[], tools: ToolDefinition[], onTextDelta: (delta: string) => void, signal?: AbortSignal): Promise<AssistantTurn> {
    const formattedTools = this.formatTools(tools);
    const response = await this.client.chat.completions.create({
      model: this.config.model,
      messages: this.formatMessages(system, messages),
      ...openAIPromptCache(this.config, system),
      ...(formattedTools.length ? { tools: formattedTools, tool_choice: "auto" as const } : {}),
      stream: true,
      stream_options: { include_usage: true },
    }, { signal });
    let text = "";
    let finishReason: NonNullable<AssistantTurn["finishReason"]> = "unknown";
    let usage: ReturnType<typeof openAIUsage>;
    const pending = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const chunk of response) {
      if (chunk.usage) usage = openAIUsage(chunk.usage);
      const choice = chunk.choices[0];
      if (choice?.finish_reason) finishReason = openAIFinishReason(choice.finish_reason);
      const delta = choice?.delta;
      const visibleText = delta?.content || delta?.refusal;
      if (visibleText) {
        text += visibleText;
        onTextDelta(visibleText);
      }
      for (const call of delta?.tool_calls ?? []) {
        const current = pending.get(call.index) ?? { id: "", name: "", arguments: "" };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.arguments += call.function.arguments;
        pending.set(call.index, current);
      }
    }
    // A truncated stream can end halfway through JSON, or after a valid-looking
    // first call in an unfinished batch. Neither is permission to execute it.
    const toolCalls = finishedToolArguments(finishReason)
      ? [...pending.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({
        id: call.id, name: call.name, input: parseToolInput(call.arguments, call.name),
      }))
      : [];
    return { text, toolCalls, raw: openAIAssistantMessage(text, toolCalls), usage, finishReason };
  }

  private formatMessages(system: string, messages: ConversationMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const formatted: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
    ];
    for (const message of messages) {
      if (message.role === "user") formatted.push({ role: "user", content: message.content });
      else if (message.role === "tool") formatted.push({ role: "tool", tool_call_id: message.toolCallId!, content: message.content });
      else formatted.push(openAIAssistantMessage(message.content, historyToolCalls(message)));
    }
    return formatted;
  }

  private formatTools(tools: ToolDefinition[]) {
    return tools.map((tool) => ({
        type: "function" as const,
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      }));
  }

  private parseToolCalls(calls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]) {
    return calls.filter((call) => call.type === "function").map((call) => {
        return { id: call.id, name: call.function.name, input: parseToolInput(call.function.arguments, call.function.name) };
      });
  }
}

class AnthropicProvider implements ModelProvider {
  private client: Anthropic;
  constructor(private config: AgentConfig) {
    const apiKey = readEnvironmentCredential(config.apiKeyEnv) ?? config.apiKey ?? readEnvironmentCredential("ANTHROPIC_API_KEY");
    const dispatcher = createTrustedDispatcher(config.proxy);
    this.client = new Anthropic({
      apiKey,
      baseURL: config.baseURL,
      fetchOptions: dispatcher ? { dispatcher } : undefined,
    });
  }

  async complete(system: string, messages: ConversationMessage[], tools: ToolDefinition[], signal?: AbortSignal): Promise<AssistantTurn> {
    const formatted = this.formatMessages(messages);
    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: 8192,
      system: this.cacheableSystem(system),
      messages: formatted,
      tools: this.formatTools(tools),
    }, { signal });
    return this.parseResponse(response);
  }

  async listModels(): Promise<AvailableModel[]> {
    const models = await modelDiscoveryCache.run(`models:${requestFingerprint(this.config)}`, async () => {
      const page = await this.client.models.list({ limit: 100 });
      const models: AvailableModel[] = [];
      for await (const model of page) {
        models.push({ id: model.id, name: model.display_name, description: model.created_at ? `Released ${model.created_at.slice(0, 10)}` : undefined, source: "api", capabilities: discoveredCapabilities(model), contextWindow: discoveredContextWindow(model) });
        if (models.length >= 200) break;
      }
      return models;
    });
    return models.map((model) => ({ ...model, capabilities: model.capabilities ? [...model.capabilities] : undefined }));
  }

  async probeToolSupport(signal?: AbortSignal): Promise<boolean> {
    const name = "xiu_capability_probe";
    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: 64,
      messages: [{ role: "user", content: "Call the provided capability probe with value OK." }],
      tools: [{
        name, description: "An inert capability probe. It performs no action.",
        input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      }],
      tool_choice: { type: "tool", name },
    }, { signal });
    return response.content.some((block) => block.type === "tool_use" && block.name === name);
  }

  async stream(system: string, messages: ConversationMessage[], tools: ToolDefinition[], onTextDelta: (delta: string) => void, signal?: AbortSignal): Promise<AssistantTurn> {
    const stream = this.client.messages.stream({
      model: this.config.model,
      max_tokens: 8192,
      system: this.cacheableSystem(system),
      messages: this.formatMessages(messages),
      tools: this.formatTools(tools),
    }, { signal });
    stream.on("text", (text) => onTextDelta(text));
    return this.parseResponse(await stream.finalMessage());
  }

  private formatMessages(messages: ConversationMessage[]): Anthropic.MessageParam[] {
    const formatted: Anthropic.MessageParam[] = [];
    for (const message of messages) {
      if (message.role === "user") formatted.push({ role: "user", content: message.content });
      else if (message.role === "assistant") {
        const calls = historyToolCalls(message);
        formatted.push({ role: "assistant", content: calls.length ? anthropicAssistantContent(message.content, calls) : message.content });
      }
      else if (message.role === "tool") {
        const result: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: message.toolCallId!, content: message.content };
        const previous = formatted.at(-1);
        if (previous?.role === "user" && Array.isArray(previous.content) && previous.content.every((block) => block.type === "tool_result")) {
          previous.content.push(result);
        } else formatted.push({ role: "user", content: [result] });
      }
    }
    return formatted;
  }

  private cacheableSystem(system: string): Anthropic.TextBlockParam[] {
    return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  }

  private formatTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema } as Anthropic.Tool));
  }

  private parseResponse(response: Anthropic.Message): AssistantTurn {
    const cacheCreationInputTokens = Math.max(0, response.usage.cache_creation_input_tokens ?? 0);
    const cacheReadInputTokens = Math.max(0, response.usage.cache_read_input_tokens ?? 0);
    const inputTokens = response.usage.input_tokens + cacheCreationInputTokens + cacheReadInputTokens;
    const finishReason = anthropicFinishReason(response.stop_reason);
    const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const toolCalls = finishedToolArguments(finishReason)
      ? response.content.filter((block) => block.type === "tool_use").map((block) => ({
        id: block.id, name: block.name, input: parseToolInput(block.input, block.name),
      }))
      : [];
    return {
      text,
      toolCalls,
      raw: anthropicAssistantContent(text, toolCalls),
      finishReason,
      usage: {
        inputTokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: inputTokens + response.usage.output_tokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
      },
    };
  }
}

export function createProvider(config: AgentConfig): ModelProvider {
  const configuredKey = readEnvironmentCredential(config.apiKeyEnv) ?? config.apiKey;
  if (config.provider === "anthropic") {
    const keyName = config.apiKeyEnv ?? "ANTHROPIC_API_KEY";
    if (!(configuredKey ?? readEnvironmentCredential("ANTHROPIC_API_KEY"))) throw new Error(`${keyName} is not set`);
    return new AnthropicProvider(config);
  }
  if (config.provider === "agnes") {
    const keyName = config.apiKeyEnv ?? "AGNES_API_KEY";
    const apiKey = configuredKey ?? readEnvironmentCredential("AGNES_API_KEY");
    if (!apiKey) throw new Error(`${keyName} is not set`);
    if (/[^\x20-\x7E]/.test(apiKey)) {
      throw new Error("AGNES_API_KEY contains non-ASCII characters. Replace the placeholder with your real API key.");
    }
    return new OpenAIProvider(config);
  }
  const local = config.provider === "ollama" || config.provider === "lmstudio" || config.provider === "vllm";
  const keyName = config.apiKeyEnv ?? "OPENAI_API_KEY";
  if (!local && config.provider !== "openai-compatible" && !(configuredKey ?? readEnvironmentCredential("OPENAI_API_KEY"))) throw new Error(`${keyName} is not set`);
  if (config.provider === "openai-compatible" && config.apiKeyEnv && !configuredKey) throw new Error(`${config.apiKeyEnv} is not set and no local key is saved`);
  return new OpenAIProvider(config);
}

export interface ProviderProbeResult {
  provider: ModelProvider;
  models: AvailableModel[];
  discoveryError?: string;
}

/** Verify a provider even when its OpenAI-compatible surface does not implement GET /models. */
export async function probeProvider(config: AgentConfig, signal?: AbortSignal): Promise<ProviderProbeResult> {
  const provider = createProvider(config);
  let models: AvailableModel[] = [];
  let discoveryError: string | undefined;
  if (provider.listModels) {
    try { models = await provider.listModels(); }
    catch (error) { discoveryError = error instanceof Error ? error.message : String(error); }
  }
  // A successful model-list response does not prove that the selected model can
  // answer requests, so every connection test also performs a minimal text call.
  await provider.complete("You are checking an API connection.", [{ role: "user", content: "Reply only: OK" }], [], signal);
  return { provider, models, discoveryError };
}
