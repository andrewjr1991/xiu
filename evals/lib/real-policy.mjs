import { sha256, stableJson } from "./core.mjs";

const expectedKeys = new Set(["protocolVersion", "id", "target", "suite", "trials", "provider", "billing", "globalBudget"]);

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) throw new Error(`${label} has missing or unknown fields.`);
}

function finite(value, label, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} must be from ${minimum} to ${maximum}.`);
}

export function validateRealConfig(config) {
  if (!config || config.protocolVersion !== 1 || Object.keys(config).some((key) => !expectedKeys.has(key))) throw new Error("Unsupported real-evaluation configuration.");
  if (config.id !== "agnes-enterprise-v0.17.0") throw new Error("Unexpected real-evaluation configuration id.");
  exactKeys(config.target, ["package", "version"], "target");
  exactKeys(config.provider, ["id", "model", "baseURL", "apiKeyEnv"], "provider");
  exactKeys(config.billing, ["mode", "currency", "authorizationLimitUsd", "estimatedInputUsdPerMillionTokens", "estimatedOutputUsdPerMillionTokens", "attestedByUserOn", "reference"], "billing");
  exactKeys(config.globalBudget, ["modelCalls", "toolCalls", "inputTokens", "outputTokens", "durationMs"], "globalBudget");
  if (config.target?.package !== "@xiu-ai/cli" || config.target?.version !== "0.17.0") throw new Error("The first real baseline must use exact @xiu-ai/cli@0.17.0.");
  if (config.suite !== "baseline" || config.trials !== 3) throw new Error("The approved baseline requires the baseline suite and three trials.");
  if (config.provider?.id !== "agnes" || config.provider?.model !== "agnes-2.5-flash" || config.provider?.baseURL !== "https://apihub.agnes-ai.com/v1" || config.provider?.apiKeyEnv !== "AGNES_API_KEY") throw new Error("Provider configuration differs from the approved Agnes configuration.");
  if (config.billing?.mode !== "enterprise-model-free" || config.billing?.currency !== "USD" || config.billing?.authorizationLimitUsd !== 100 || config.billing?.estimatedInputUsdPerMillionTokens !== 0 || config.billing?.estimatedOutputUsdPerMillionTokens !== 0) throw new Error("Billing configuration differs from the approved Enterprise free-model attestation and 100 USD limit.");
  if (config.billing.attestedByUserOn !== "2026-08-21" || config.billing.reference !== "https://github.com/AgnesAI-Labs/AgnesAI-Models/blob/main/MODEL_CATALOG.md") throw new Error("Billing attestation and reference differ from the approved record.");
  for (const [field, maximum] of [["modelCalls", 1000], ["toolCalls", 5000], ["inputTokens", 20000000], ["outputTokens", 2000000], ["durationMs", 86400000]]) finite(config.globalBudget?.[field], `globalBudget.${field}`, 1, maximum);
  return config;
}

export function realConfirmationToken(config, suiteHash, artifactIntegrity, executionHash) {
  if (!/^[a-f0-9]{64}$/.test(executionHash)) throw new Error("A full execution hash is required for real-evaluation confirmation.");
  const digest = sha256(stableJson({ config, suiteHash, artifactIntegrity, executionHash }));
  return `CONFIRM-REAL-EVAL-${digest.slice(0, 16).toUpperCase()}`;
}

export function validateSuiteBudget(config, tasks) {
  const maximum = { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
  for (const task of tasks) for (const field of Object.keys(maximum)) maximum[field] += task.budget[field === "durationMs" ? "timeoutMs" : field] * config.trials;
  for (const [field, value] of Object.entries(maximum)) if (value > config.globalBudget[field]) throw new Error(`Global ${field} budget is below the suite's conservative maximum ${value}.`);
  return maximum;
}

function reportedUsd(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return 0;
  let total = 0;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:cost_usd|usd_cost|billed_usd|amount_usd)$/i.test(key) && typeof child === "number" && Number.isFinite(child) && child > 0) total += child;
    else if (child && typeof child === "object") total += reportedUsd(child, depth + 1);
  }
  return total;
}

export class RealEvaluationLedger {
  constructor(config, now = () => Date.now()) {
    this.config = config;
    this.now = now;
    this.startedAt = now();
    this.modelCalls = 0;
    this.toolCalls = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.reportedCostUsd = 0;
  }

  assertCanStartModelCall() {
    this.assertWithinBudget();
    if (this.modelCalls >= this.config.globalBudget.modelCalls) throw new Error("Global model-call budget exhausted.");
  }

  recordModelTurn(turn) {
    this.modelCalls += 1;
    this.inputTokens += Number(turn.usage?.inputTokens ?? 0);
    this.outputTokens += Number(turn.usage?.outputTokens ?? 0);
    this.reportedCostUsd += reportedUsd(turn.raw);
    this.assertWithinBudget();
  }

  recordTools(count) {
    this.toolCalls += count;
    this.assertWithinBudget();
  }

  estimatedCostUsd() {
    const estimated = (this.inputTokens / 1000000) * this.config.billing.estimatedInputUsdPerMillionTokens + (this.outputTokens / 1000000) * this.config.billing.estimatedOutputUsdPerMillionTokens;
    return Math.max(estimated, this.reportedCostUsd);
  }

  assertWithinBudget() {
    const budget = this.config.globalBudget;
    if (this.toolCalls > budget.toolCalls) throw new Error("Global tool-call budget exhausted.");
    if (this.inputTokens > budget.inputTokens) throw new Error("Global input-token budget exhausted.");
    if (this.outputTokens > budget.outputTokens) throw new Error("Global output-token budget exhausted.");
    if (this.now() - this.startedAt > budget.durationMs) throw new Error("Global duration budget exhausted.");
    if (this.estimatedCostUsd() > this.config.billing.authorizationLimitUsd) throw new Error("Global USD authorization limit exceeded.");
  }

  snapshot() {
    return { modelCalls: this.modelCalls, toolCalls: this.toolCalls, inputTokens: this.inputTokens, outputTokens: this.outputTokens, durationMs: this.now() - this.startedAt, estimatedCostUsd: this.estimatedCostUsd(), authorizationLimitUsd: this.config.billing.authorizationLimitUsd };
  }
}
