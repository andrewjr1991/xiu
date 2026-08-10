import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ProxyAgent } from "undici";
import type { AgentConfig } from "./config.js";
import type { AssistantTurn, AvailableModel, ConversationMessage, ModelProvider, ToolDefinition } from "./types.js";

class OpenAIProvider implements ModelProvider {
  private client: OpenAI;
  constructor(private config: AgentConfig) {
    const apiKey = (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined)
      ?? config.apiKey
      ?? (config.provider === "agnes" ? process.env.AGNES_API_KEY : process.env.OPENAI_API_KEY);
    this.client = new OpenAI({
      apiKey: apiKey || "xiu-local",
      baseURL: config.baseURL,
      fetchOptions: config.proxy ? { dispatcher: new ProxyAgent(config.proxy) } : undefined,
    });
  }

  async complete(system: string, messages: ConversationMessage[], tools: ToolDefinition[], signal?: AbortSignal): Promise<AssistantTurn> {
    const formatted = this.formatMessages(system, messages);
    const formattedTools = this.formatTools(tools);

    const response = await this.client.chat.completions.create({
      model: this.config.model,
      messages: formatted,
      ...(formattedTools.length ? { tools: formattedTools, tool_choice: "auto" as const } : {}),
    }, { signal });
    const message = response.choices[0]?.message;
    if (!message) throw new Error("Model returned no message");
    return {
      text: message.content ?? "",
      toolCalls: this.parseToolCalls(message.tool_calls ?? []),
      raw: message,
      usage: response.usage ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
  }

  async listModels(): Promise<AvailableModel[]> {
    const page = await this.client.models.list();
    const models: AvailableModel[] = [];
    for await (const model of page) {
      models.push({ id: model.id, description: model.owned_by ? `Owned by ${model.owned_by}` : undefined, source: "api" });
      if (models.length >= 200) break;
    }
    return models;
  }

  async stream(system: string, messages: ConversationMessage[], tools: ToolDefinition[], onTextDelta: (delta: string) => void, signal?: AbortSignal): Promise<AssistantTurn> {
    const formattedTools = this.formatTools(tools);
    const response = await this.client.chat.completions.create({
      model: this.config.model,
      messages: this.formatMessages(system, messages),
      ...(formattedTools.length ? { tools: formattedTools, tool_choice: "auto" as const } : {}),
      stream: true,
    }, { signal });
    let text = "";
    const pending = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        text += delta.content;
        onTextDelta(delta.content);
      }
      for (const call of delta?.tool_calls ?? []) {
        const current = pending.get(call.index) ?? { id: "", name: "", arguments: "" };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.arguments += call.function.arguments;
        pending.set(call.index, current);
      }
    }
    const toolCalls = [...pending.values()].map((call) => {
      let input: Record<string, unknown>;
      try { input = JSON.parse(call.arguments || "{}"); }
      catch { throw new Error(`Invalid tool arguments from model for ${call.name}`); }
      return { id: call.id, name: call.name, input };
    });
    const raw = {
      role: "assistant" as const,
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : {}),
    };
    return { text, toolCalls, raw };
  }

  private formatMessages(system: string, messages: ConversationMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const formatted: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
    ];
    for (const message of messages) {
      if (message.role === "user") formatted.push({ role: "user", content: message.content });
      else if (message.role === "tool") formatted.push({ role: "tool", tool_call_id: message.toolCallId!, content: message.content });
      else if (message.raw) formatted.push(message.raw as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam);
      else if (message.toolCalls?.length) formatted.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      });
      else formatted.push({ role: "assistant", content: message.content });
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
        let input: Record<string, unknown>;
        try { input = JSON.parse(call.function.arguments); }
        catch { throw new Error(`Invalid tool arguments from model for ${call.function.name}`); }
        return { id: call.id, name: call.function.name, input };
      });
  }
}

class AnthropicProvider implements ModelProvider {
  private client: Anthropic;
  constructor(private config: AgentConfig) {
    const apiKey = (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined) ?? config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.client = new Anthropic({
      apiKey,
      baseURL: config.baseURL,
      fetchOptions: config.proxy ? { dispatcher: new ProxyAgent(config.proxy) } : undefined,
    });
  }

  async complete(system: string, messages: ConversationMessage[], tools: ToolDefinition[], signal?: AbortSignal): Promise<AssistantTurn> {
    const formatted = this.formatMessages(messages);
    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: 8192,
      system,
      messages: formatted,
      tools: this.formatTools(tools),
    }, { signal });
    return this.parseResponse(response);
  }

  async listModels(): Promise<AvailableModel[]> {
    const page = await this.client.models.list({ limit: 100 });
    const models: AvailableModel[] = [];
    for await (const model of page) {
      models.push({ id: model.id, name: model.display_name, description: model.created_at ? `Released ${model.created_at.slice(0, 10)}` : undefined, source: "api" });
      if (models.length >= 200) break;
    }
    return models;
  }

  async stream(system: string, messages: ConversationMessage[], tools: ToolDefinition[], onTextDelta: (delta: string) => void, signal?: AbortSignal): Promise<AssistantTurn> {
    const stream = this.client.messages.stream({
      model: this.config.model,
      max_tokens: 8192,
      system,
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
      else if (message.role === "assistant" && message.raw) {
        formatted.push({ role: "assistant", content: message.raw as Anthropic.ContentBlock[] });
      } else if (message.role === "assistant" && message.toolCalls?.length) {
        formatted.push({ role: "assistant", content: [
          ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
          ...message.toolCalls.map((call) => ({ type: "tool_use" as const, id: call.id, name: call.name, input: call.input })),
        ] });
      } else if (message.role === "assistant") formatted.push({ role: "assistant", content: message.content });
      else if (message.role === "tool") {
        formatted.push({ role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId!, content: message.content }] });
      }
    }
    return formatted;
  }

  private formatTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema } as Anthropic.Tool));
  }

  private parseResponse(response: Anthropic.Message): AssistantTurn {
    return {
      text: response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"),
      toolCalls: response.content.filter((block) => block.type === "tool_use").map((block) => ({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      })),
      raw: response.content,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }
}

export function createProvider(config: AgentConfig): ModelProvider {
  const configuredKey = (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined) ?? config.apiKey;
  if (config.provider === "anthropic") {
    const keyName = config.apiKeyEnv ?? "ANTHROPIC_API_KEY";
    if (!(configuredKey ?? process.env.ANTHROPIC_API_KEY)) throw new Error(`${keyName} is not set`);
    return new AnthropicProvider(config);
  }
  if (config.provider === "agnes") {
    const keyName = config.apiKeyEnv ?? "AGNES_API_KEY";
    const apiKey = configuredKey ?? process.env.AGNES_API_KEY;
    if (!apiKey) throw new Error(`${keyName} is not set`);
    if (/[^\x20-\x7E]/.test(apiKey)) {
      throw new Error("AGNES_API_KEY contains non-ASCII characters. Replace the placeholder with your real API key.");
    }
    return new OpenAIProvider(config);
  }
  const local = config.provider === "ollama" || config.provider === "lmstudio" || config.provider === "vllm";
  const keyName = config.apiKeyEnv ?? "OPENAI_API_KEY";
  if (!local && config.provider !== "openai-compatible" && !(configuredKey ?? process.env.OPENAI_API_KEY)) throw new Error(`${keyName} is not set`);
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
  if (!provider.listModels) {
    await provider.complete("You are checking an API connection.", [{ role: "user", content: "Reply only: OK" }], [], signal);
    return { provider, models: [] };
  }
  try {
    return { provider, models: await provider.listModels() };
  } catch (error) {
    const discoveryError = error instanceof Error ? error.message : String(error);
    await provider.complete("You are checking an API connection.", [{ role: "user", content: "Reply only: OK" }], [], signal);
    return { provider, models: [], discoveryError };
  }
}
