export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AssistantTurn {
  text: string;
  toolCalls: ToolCall[];
  raw: unknown;
  usage?: ModelUsage;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Provider-reported input tokens served from its prompt cache. Subset of inputTokens. */
  cacheReadInputTokens?: number;
  /** Provider-reported input tokens written to its prompt cache. Subset of inputTokens. */
  cacheCreationInputTokens?: number;
}

export interface AvailableModel {
  id: string;
  name?: string;
  description?: string;
  source: "api" | "builtin" | "current";
  capabilities?: string[];
  contextWindow?: number;
  providerId?: string;
}

export interface ConversationMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  raw?: unknown;
  toolCalls?: ToolCall[];
}

export interface ModelProvider {
  complete(
    system: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<AssistantTurn>;
  listModels?(): Promise<AvailableModel[]>;
  /** Force one inert tool call to verify structured tool-use support. */
  probeToolSupport?(signal?: AbortSignal): Promise<boolean>;
  stream?(
    system: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    onTextDelta: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<AssistantTurn>;
}

export type ToolRisk = "read" | "write" | "execute" | "dangerous";

export interface ApprovalRequest {
  description: string;
  risk: Exclude<ToolRisk, "read">;
  preview?: string;
  /** Optional narrowly scoped permission that may be remembered for the current Xiu process. */
  sessionScope?: string;
  /** Filled by the UI so diagnostics distinguish prompts from automatic policy decisions. */
  decisionSource?: "prompted" | "automatic" | "remembered";
}

export interface ToolContext {
  cwd: string;
  approve: (request: ApprovalRequest) => Promise<boolean>;
  signal?: AbortSignal;
  reportProgress?: (message: string) => void;
}

export interface AgentTool extends ToolDefinition {
  risk: ToolRisk | ((input: Record<string, unknown>) => ToolRisk);
  /** Enables an explicit "always allow for this session" choice for this exact operation family. */
  approvalScope?: string | ((input: Record<string, unknown>) => string | undefined);
  describe(input: Record<string, unknown>): string;
  validate?(input: Record<string, unknown>): void;
  preview?(input: Record<string, unknown>, context: ToolContext): Promise<string>;
  changesWorkspace?: boolean | ((input: Record<string, unknown>) => boolean);
  isVerification?(input: Record<string, unknown>, result: string): boolean;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<string>;
}
