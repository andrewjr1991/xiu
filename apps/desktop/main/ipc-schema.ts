import { PROVIDER_ROUTING_PHASES } from "../../../src/provider-routing.js";
import { desktopChannels } from "../shared/protocol.js";

/**
 * Runtime validation of renderer → main IPC arguments.
 *
 * `assertTrustedIpcSender` decides who may call a privileged channel; this module
 * decides what shape the call may have. Every invoke channel in `desktopChannels`
 * has an argument schema here, and `handleIpc` in the main entry refuses to
 * register a handler for a channel without one. Schemas are structural: types,
 * discriminants, bounded lengths and counts; undeclared fields are dropped and
 * surplus arguments rejected. Domain rules (which key is allowed,
 * whether a provider id exists, Plan mode, approvals) stay in the controllers,
 * so a rejected request still gets the controller's own message once its shape
 * is right. Error messages name the channel and the field, never the value, so a
 * rejected credential or task text is not echoed back.
 */
export class IpcArgumentError extends Error {
  constructor(readonly channel: string, detail: string) {
    super(`Rejected IPC arguments on ${channel}: ${detail}.`);
    this.name = "IpcArgumentError";
  }
}

type Parser<T = unknown> = (value: unknown, at: string) => T;
type Fields = Record<string, Parser>;
type Parsed<T extends Fields> = { [K in keyof T]: ReturnType<T[K]> };

class SchemaMismatch extends Error {}

function fail(at: string, expected: string): never {
  throw new SchemaMismatch(`${at} must be ${expected}`);
}

const string = (max: number): Parser<string> => (value, at) =>
  typeof value === "string" && value.length <= max ? value : fail(at, `a string of at most ${max} characters`);
const boolean: Parser<boolean> = (value, at) => (typeof value === "boolean" ? value : fail(at, "a boolean"));
const literal = <const T extends readonly (string | number | boolean)[]>(...values: T): Parser<T[number]> => (value, at) =>
  (values as readonly unknown[]).includes(value) ? (value as T[number]) : fail(at, `one of ${values.map((item) => JSON.stringify(item)).join(", ")}`);
const number = (options: { min?: number; max?: number; integer?: boolean } = {}): Parser<number> => (value, at) => {
  const min = options.min ?? -1e9;
  const max = options.max ?? 1e9;
  const ok = typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!options.integer || Number.isInteger(value));
  return ok ? value : fail(at, `${options.integer ? "an integer" : "a finite number"} between ${min} and ${max}`);
};
const optional = <T>(parser: Parser<T>): Parser<T | undefined> => (value, at) => (value === undefined ? undefined : parser(value, at));
const nullable = <T>(parser: Parser<T>): Parser<T | null> => (value, at) => (value === null ? null : parser(value, at));
const array = <T>(item: Parser<T>, max: number): Parser<T[]> => (value, at) =>
  Array.isArray(value) && value.length <= max ? value.map((entry, index) => item(entry, `${at}[${index}]`)) : fail(at, `an array of at most ${max} items`);
const bytes = (max: number): Parser<Uint8Array> => (value, at) =>
  value instanceof Uint8Array && value.byteLength <= max ? value : fail(at, `binary data of at most ${max} bytes`);

function plainObject(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(at, "an object");
  return value as Record<string, unknown>;
}

/**
 * Known fields only: the handler receives a fresh object holding just the declared
 * fields, so renderer form state that carries UI-only keys (template markers, draft
 * ids) or anything injected alongside a request never reaches main-process logic.
 */
const object = <T extends Fields>(fields: T): Parser<Parsed<T>> => (value, at) => {
  const input = plainObject(value, at);
  const output: Record<string, unknown> = {};
  for (const [key, parser] of Object.entries(fields)) {
    const parsed = parser(input[key], `${at}.${key}`);
    if (parsed !== undefined) output[key] = parsed;
  }
  return output as Parsed<T>;
};
const record = (item: Parser<string>, maxEntries: number, maxKey = 256): Parser<Record<string, string>> => (value, at) => {
  const input = plainObject(value, at);
  const entries = Object.entries(input);
  if (entries.length > maxEntries) fail(at, `an object with at most ${maxEntries} entries`);
  const output: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (key.length > maxKey) fail(at, `an object whose keys have at most ${maxKey} characters`);
    output[key] = item(entry, `${at}.${key}`);
  }
  return output;
};
/** Discriminated union on `tag`; each case lists its other fields. */
const tagged = (tag: string, cases: Record<string, Fields>): Parser<Record<string, unknown>> => (value, at) => {
  const input = plainObject(value, at);
  const kind = input[tag];
  if (typeof kind !== "string" || !Object.hasOwn(cases, kind)) fail(`${at}.${tag}`, `one of ${Object.keys(cases).map((item) => JSON.stringify(item)).join(", ")}`);
  return object({ [tag]: literal(kind as string), ...cases[kind as string] })(input, at);
};
/** The handler parses this argument itself with a dedicated parser; the schema only requires it to be present. */
const parsedByHandler = (reason: string): Parser => (value, at) => (value === undefined ? fail(at, `present (${reason})`) : value);

const ID = 256;
const SHORT = 512;
const PATH = 4_096;
const URL = 8_192;
const TASK_TEXT = 1_000_000;
const TERMINAL_CHUNK = 1_000_000;
const ATTACHMENT_BYTES = 512 * 1024 * 1024;

const id = string(ID);
const confirmed = literal(true);
const taskRequest = { text: string(TASK_TEXT), answerTo: optional(object({ taskId: id, questionId: id })) };
const providerSelect = { providerId: id, model: string(SHORT), capability: optional(literal("vision", "image", "video", "audio")) };
const capabilityModels = object({ vision: optional(string(SHORT)), image: optional(string(SHORT)), video: optional(string(SHORT)), audio: optional(string(SHORT)) });
const features = object({ tools: boolean, vision: boolean, image: boolean, video: boolean, audio: boolean });
const mcpDraft = object({
  name: id,
  fingerprint: optional(string(ID)),
  transport: literal("stdio", "streamable-http"),
  command: optional(string(PATH)),
  args: optional(array(string(PATH), 64)),
  url: optional(string(URL)),
  bearerTokenEnvironment: optional(string(ID)),
  oauth: optional(object({
    type: literal("oauth"),
    registration: optional(literal("auto", "pre-registered")),
    clientId: optional(string(SHORT)),
    clientMetadataUrl: optional(string(URL)),
    scopes: optional(array(string(ID), 64)),
    callbackPort: optional(number({ integer: true, min: 0, max: 65_535 })),
  })),
  risk: literal("read", "write", "execute", "dangerous"),
  enabled: optional(boolean),
});
const mcpTarget = { name: id, fingerprint: string(ID) };
const computerInput = object({
  kind: literal("click", "doubleclick", "rightclick", "drag", "scroll", "type", "key"),
  frameId: id,
  elementId: optional(nullable(string(SHORT))),
  x: optional(number()),
  y: optional(number()),
  toX: optional(number()),
  toY: optional(number()),
  delta: optional(number()),
  text: optional(string(PATH)),
  key: optional(string(64)),
  repeat: optional(number({ integer: true, min: 1, max: 10_000 })),
});
const terminalSize = { cols: number({ integer: true, min: 1, max: 10_000 }), rows: number({ integer: true, min: 1, max: 10_000 }) };

/** Channels the main process pushes to the renderer; they take no renderer arguments and are not invoke channels. */
export const PUSH_CHANNELS: ReadonlySet<string> = new Set([
  desktopChannels.snapshotChanged,
  desktopChannels.runtimeEvent,
  desktopChannels.browserState,
  desktopChannels.terminalEvent,
]);

const NONE: Parser[] = [];
const argumentSchemas: Record<string, Parser[]> = {
  [desktopChannels.computerUse]: [tagged("action", {
    open: {}, capture: {}, stop: {}, state: {}, windows: {}, automatic: {}, "automatic-revoke": {},
    select: { handle: id },
    input: { input: computerInput },
  })],
  [desktopChannels.preferences]: NONE,
  [desktopChannels.preferencesSave]: [parsedByHandler("PreferencesStore parses preferences")],
  [desktopChannels.about]: NONE,
  [desktopChannels.providerRecovery]: [tagged("action", {
    snapshot: {},
    preview: { contextId: id, backupId: id },
    recover: { contextId: id, token: string(SHORT) },
    cancel: { contextId: id, token: string(SHORT) },
  })],
  [desktopChannels.browser]: [tagged("action", {
    navigate: { url: string(URL) },
    back: {}, forward: {}, reload: {}, close: {}, snapshot: {},
    layout: { bounds: object({ x: number(), y: number(), width: number({ min: 0 }), height: number({ min: 0 }) }), visible: boolean },
  })],
  [desktopChannels.mcpManage]: [tagged("action", {
    save: { draft: mcpDraft },
    delete: { ...mcpTarget, confirmed },
    logout: { ...mcpTarget, confirmed },
    login: mcpTarget,
    "oauth-decision": { flowId: id, allowed: boolean },
    "oauth-cancel": { flowId: id },
  })],
  [desktopChannels.mcpBrowse]: [object({ name: id, action: literal("resources", "read", "prompts", "prompt"), value: optional(string(URL)), args: optional(record(string(URL), 64)) })],
  [desktopChannels.mcpSnapshot]: NONE,
  [desktopChannels.mcpReload]: NONE,
  [desktopChannels.mcpDisconnect]: NONE,
  [desktopChannels.mcpApprove]: [object({ ...mcpTarget, confirmed })],
  [desktopChannels.snapshot]: NONE,
  [desktopChannels.chooseWorkspace]: NONE,
  [desktopChannels.closeWorkspace]: NONE,
  [desktopChannels.openRecentWorkspace]: [object({ workspaceId: id })],
  [desktopChannels.removeRecentWorkspace]: [object({ workspaceId: id, confirmed })],
  [desktopChannels.trustWorkspace]: [object({ workspaceId: id, acknowledged: confirmed })],
  [desktopChannels.runtimeConnect]: [optional(object({ afterSequence: optional(number({ integer: true, min: 0 })) }))],
  [desktopChannels.taskCreate]: [object(taskRequest)],
  [desktopChannels.taskContinue]: [object({ ...taskRequest, taskId: id })],
  [desktopChannels.conversationNew]: NONE,
  [desktopChannels.taskSteer]: [object(taskRequest)],
  [desktopChannels.taskStop]: NONE,
  [desktopChannels.subagentCancel]: [object({ runId: id, taskId: id, parentTaskId: id })],
  [desktopChannels.planModeSet]: [object({ enabled: boolean, contextId: id })],
  [desktopChannels.approvalModeSet]: [object({ mode: literal("ask", "workspace", "full"), contextId: id })],
  [desktopChannels.approvalDecide]: [object({ approvalId: id, allowed: boolean, rememberForSession: optional(confirmed), confirmedRisk: optional(literal("dangerous")) })],
  [desktopChannels.taskHistoryOpen]: [object({ taskId: id })],
  [desktopChannels.computerAcceptance]: [object({ taskId: id, decision: optional(literal("passed", "rejected")) })],
  [desktopChannels.taskDelete]: [object({ taskId: id, confirmed })],
  [desktopChannels.attachmentsChoose]: NONE,
  [desktopChannels.attachmentsPaste]: NONE,
  [desktopChannels.copyMessage]: [string(200_000)],
  [desktopChannels.attachmentsImport]: [object({ files: array(object({ name: string(PATH), data: bytes(ATTACHMENT_BYTES) }), 64) })],
  [desktopChannels.reviewSnapshot]: [optional(object({ changeView: optional(literal("task", "workspace", "staged")) }))],
  [desktopChannels.filePreview]: [object({ path: string(PATH) })],
  [desktopChannels.checkpointRestore]: [object({ checkpointId: id })],
  [desktopChannels.recoveryResume]: [object({ runId: id })],
  [desktopChannels.recoveryAbandon]: [object({ runId: id })],
  [desktopChannels.providerSnapshot]: NONE,
  [desktopChannels.managementSnapshot]: NONE,
  [desktopChannels.skillPrepare]: [optional(literal("directory", "file"))],
  [desktopChannels.skillCancel]: NONE,
  [desktopChannels.taskDiagnostics]: NONE,
  [desktopChannels.managementChange]: [tagged("action", {
    "skill-install": { revision: id, token: string(SHORT), confirmed },
    routing: { revision: id, enabled: boolean },
    stage: { revision: id, phase: literal(...PROVIDER_ROUTING_PHASES), providerId: optional(id) },
    fallback: { revision: id, providerId: id, chain: array(id, 32) },
    web: { revision: id, enabled: boolean, mode: optional(literal("local", "managed", "custom")), provider: literal("tavily", "brave", "searxng", "free-search"), endpoint: string(URL), apiKeyEnv: optional(string(ID)) },
  })],
  [desktopChannels.providerModels]: [object({ providerId: id })],
  [desktopChannels.providerSelect]: [object(providerSelect)],
  [desktopChannels.providerCredentialSave]: [object({ providerId: id, apiKey: string(URL) })],
  [desktopChannels.providerTest]: [object({ providerId: id, model: optional(string(SHORT)) })],
  [desktopChannels.providerVisionTest]: [object({ ...providerSelect, allCandidates: optional(boolean) })],
  [desktopChannels.providerVisionCancel]: NONE,
  [desktopChannels.providerVisionProgress]: NONE,
  [desktopChannels.providerUpsert]: [object({
    existingId: optional(id),
    id,
    name: string(ID),
    kind: literal("openai", "anthropic", "agnes", "openai-compatible", "ollama", "lmstudio", "vllm"),
    model: string(SHORT),
    baseURL: optional(string(URL)),
    apiKeyEnv: optional(string(ID)),
    apiKey: optional(string(URL)),
    contextWindow: optional(number({ integer: true, min: 1 })),
    capabilityModels: optional(capabilityModels),
    features,
  })],
  [desktopChannels.providerDelete]: [object({ providerId: id, confirmed })],
  [desktopChannels.terminalSnapshot]: NONE,
  [desktopChannels.terminalStart]: [optional(object({ cols: optional(terminalSize.cols), rows: optional(terminalSize.rows) }))],
  [desktopChannels.terminalWrite]: [object({ sessionId: id, data: string(TERMINAL_CHUNK) })],
  [desktopChannels.terminalResize]: [object({ sessionId: id, ...terminalSize })],
  [desktopChannels.terminalStop]: [object({ sessionId: id })],
};

export function hasIpcArgumentSchema(channel: string): boolean {
  return Object.hasOwn(argumentSchemas, channel);
}

/**
 * Validates the arguments of one invoke call and returns them in canonical form
 * (declared fields only, `undefined` entries dropped). Throws `IpcArgumentError`
 * for a channel without a schema, for surplus arguments and for any mismatch.
 */
export function validateIpcArguments(channel: string, args: readonly unknown[]): unknown[] {
  if (!hasIpcArgumentSchema(channel)) throw new IpcArgumentError(channel, "no argument schema is registered for this channel");
  const schema = argumentSchemas[channel];
  if (args.slice(schema.length).some((extra) => extra !== undefined)) {
    throw new IpcArgumentError(channel, `expected at most ${schema.length} argument${schema.length === 1 ? "" : "s"}`);
  }
  try {
    return schema.map((parser, index) => parser(args[index], `argument ${index + 1}`));
  } catch (error) {
    if (error instanceof SchemaMismatch) throw new IpcArgumentError(channel, error.message);
    throw error;
  }
}
