import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { createProvider } from "../src/providers.js";
import type { ConversationMessage, ModelProvider, ToolCall } from "../src/types.js";

type Protocol = "openai-compatible" | "anthropic";

async function withProvider(
  protocol: Protocol,
  responseBody: unknown,
  run: (provider: ModelProvider, requests: Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.setHeader("content-type", typeof responseBody === "string" ? "text/event-stream" : "application/json");
      response.end(typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const provider = createProvider(resolveConfig({
      provider: protocol, providerId: "offline-contract", model: "offline-model", apiKey: "offline-placeholder",
      apiKeyEnv: "XIU_OFFLINE_PROVIDER_CONTRACT_KEY",
      baseURL: `http://127.0.0.1:${address.port}${protocol === "anthropic" ? "" : "/v1"}`,
    }));
    await run(provider, requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const calls: ToolCall[] = [
  { id: "call-read", name: "read_file", input: { path: "src/index.ts" } },
  { id: "call-list", name: "list_files", input: { path: "src" } },
];
const openAICalls = calls.map((call) => ({
  id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) },
}));
const anthropicCalls = calls.map((call) => ({ type: "tool_use", ...call }));

function openAIResponse(reason: string | null = "stop", toolCalls: unknown[] = []) {
  return {
    id: "chat-offline", object: "chat.completion", created: 1, model: "offline-model",
    choices: [{ index: 0, finish_reason: reason, message: {
      role: "assistant", content: "visible answer", tool_calls: toolCalls,
      reasoning_content: "hidden-reasoning-canary", private_metadata: "private-canary",
    } }],
  };
}

function anthropicResponse(reason: string | null = "end_turn", toolCalls: unknown[] = []) {
  return {
    id: "msg_offline", type: "message", role: "assistant", model: "offline-model",
    stop_reason: reason, stop_sequence: null,
    content: [
      { type: "thinking", thinking: "hidden-reasoning-canary", signature: "signature-canary" },
      { type: "redacted_thinking", data: "redacted-canary" },
      { type: "text", text: "visible answer" }, ...toolCalls,
    ],
    usage: { input_tokens: 12, output_tokens: 3 },
  };
}

function history(raw: unknown, toolCalls: ToolCall[] | undefined = calls): ConversationMessage[] {
  return [
    { role: "user", content: "inspect" },
    { role: "assistant", content: "canonical visible text", raw, toolCalls },
    ...calls.map((call) => ({ role: "tool" as const, content: `result for ${call.name}`, toolCallId: call.id, toolName: call.name })),
  ];
}

test("OpenAI history rebuilds Anthropic turns from canonical text and tool calls", async () => {
  const raw = [{ type: "text", text: "obsolete text" }, { type: "thinking", thinking: "hidden-canary" }, ...anthropicCalls];
  await withProvider("openai-compatible", openAIResponse(), async (provider, requests) => {
    await provider.complete("system", history(raw), []);
    assert.deepEqual(requests[0]?.messages, [
      { role: "system", content: "system" },
      { role: "user", content: "inspect" },
      { role: "assistant", content: "canonical visible text", tool_calls: openAICalls },
      ...calls.map((call) => ({ role: "tool", tool_call_id: call.id, content: `result for ${call.name}` })),
    ]);
  });
});

test("Anthropic history rebuilds OpenAI turns and groups parallel tool results", async () => {
  const raw = { role: "assistant", content: "obsolete text", reasoning_content: "hidden-canary", tool_calls: openAICalls };
  await withProvider("anthropic", anthropicResponse(), async (provider, requests) => {
    await provider.complete("system", history(raw), []);
    assert.deepEqual(requests[0]?.messages, [
      { role: "user", content: "inspect" },
      { role: "assistant", content: [{ type: "text", text: "canonical visible text" }, ...anthropicCalls] },
      { role: "user", content: calls.map((call) => ({ type: "tool_result", tool_use_id: call.id, content: `result for ${call.name}` })) },
    ]);
  });
});

test("legacy raw-only tool metadata is normalized without replaying hidden fields", async () => {
  for (const protocol of ["openai-compatible", "anthropic"] as const) {
    for (const raw of [
      { role: "assistant", content: "stale-canary", tool_calls: openAICalls, reasoning_content: "hidden-canary" },
      [{ type: "thinking", thinking: "hidden-canary" }, ...anthropicCalls],
    ]) {
      await withProvider(protocol, protocol === "anthropic" ? anthropicResponse() : openAIResponse(), async (provider, requests) => {
        const messages = history(raw);
        delete messages[1]!.toolCalls;
        await provider.complete("system", messages, []);
        const body = JSON.stringify(requests[0]);
        assert.match(body, /call-read/);
        assert.match(body, /read_file/);
        assert.match(body, /canonical visible text/);
        assert.doesNotMatch(body, /canary/);
      });
    }
  }
});

test("canonical empty calls do not resurrect old raw calls", async () => {
  for (const protocol of ["openai-compatible", "anthropic"] as const) {
    await withProvider(protocol, protocol === "anthropic" ? anthropicResponse() : openAIResponse(), async (provider, requests) => {
      await provider.complete("system", [{
        role: "assistant", content: "completed", toolCalls: [],
        raw: { role: "assistant", tool_calls: openAICalls, reasoning_content: "hidden-canary" },
      }], []);
      assert.doesNotMatch(JSON.stringify(requests[0]), /call-read|read_file|canary/);
    });
  }
});

test("OpenAI complete maps finish reasons and removes non-public raw fields", async () => {
  for (const reason of ["stop", "tool_calls", "length", "content_filter", "other", null]) {
    await withProvider("openai-compatible", openAIResponse(reason, openAICalls), async (provider) => {
      const result = await provider.complete("system", [{ role: "user", content: "hello" }], []);
      assert.equal(result.finishReason, reason === "other" || reason === null ? "unknown" : reason);
      assert.equal(result.text, "visible answer");
      assert.deepEqual(result.toolCalls, reason === "stop" || reason === "tool_calls" ? calls : []);
      assert.doesNotMatch(JSON.stringify(result), /canary|reasoning_content|private_metadata/);
    });
  }
});

test("Anthropic complete maps terminal states and never retains thinking blocks", async () => {
  for (const [reason, expected] of [
    ["end_turn", "stop"], ["stop_sequence", "stop"], ["tool_use", "tool_calls"],
    ["max_tokens", "length"], ["refusal", "content_filter"], ["pause_turn", "unknown"], [null, "unknown"],
  ]) {
    await withProvider("anthropic", anthropicResponse(reason, anthropicCalls), async (provider) => {
      const result = await provider.complete("system", [{ role: "user", content: "hello" }], []);
      assert.equal(result.finishReason, expected);
      assert.equal(result.text, "visible answer");
      assert.deepEqual(result.toolCalls, expected === "stop" || expected === "tool_calls" ? calls : []);
      assert.doesNotMatch(JSON.stringify(result), /canary|thinking|signature/);
    });
  }
});

function openAIStream(reason: string | null, argumentsText = '{"path":"src/index.ts"}') {
  const chunks = [
    { choices: [{ index: 0, delta: { content: "visible ", reasoning_content: "hidden-canary" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "answer", tool_calls: [{ index: 0, id: "call-read", type: "function", function: { name: "read_file", arguments: argumentsText } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: reason }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ];
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

test("OpenAI streaming preserves finish reasons through a final usage-only chunk", async () => {
  for (const reason of ["stop", "tool_calls", "length", "content_filter", null]) {
    await withProvider("openai-compatible", openAIStream(reason), async (provider) => {
      const chunks: string[] = [];
      const result = await provider.stream!("system", [{ role: "user", content: "hello" }], [], (text) => chunks.push(text));
      assert.equal(result.finishReason, reason ?? "unknown");
      assert.equal(chunks.join(""), "visible answer");
      assert.deepEqual(result.toolCalls, reason === "stop" || reason === "tool_calls" ? [calls[0]] : []);
      assert.equal(result.usage?.totalTokens, 12);
      assert.doesNotMatch(JSON.stringify(result), /hidden-canary|reasoning_content/);
    });
  }
});

test("truncated tool JSON is discarded without hiding the output-limit reason", async () => {
  await withProvider("openai-compatible", openAIStream("length", '{"path":'), async (provider) => {
    const result = await provider.stream!("system", [{ role: "user", content: "hello" }], [], () => {});
    assert.equal(result.finishReason, "length");
    assert.deepEqual(result.toolCalls, []);
    assert.doesNotMatch(JSON.stringify(result.raw), /call-read|tool_calls/);
  });
  const malformed = [{ id: "partial", type: "function", function: { name: "write_file", arguments: '{"path":' } }];
  await withProvider("openai-compatible", openAIResponse("length", malformed), async (provider) => {
    const result = await provider.complete("system", [{ role: "user", content: "hello" }], []);
    assert.equal(result.finishReason, "length");
    assert.deepEqual(result.toolCalls, []);
  });
});

test("finished tool calls reject non-object JSON arguments", async () => {
  for (const invalid of ["null", "[]", '"text"', "42", "{invalid"]) {
    await withProvider("openai-compatible", openAIStream("tool_calls", invalid), async (provider) => {
      await assert.rejects(provider.stream!("system", [], [], () => {}), /Invalid tool arguments/);
    });
  }
});

test("Anthropic streaming uses final message stop_reason", async () => {
  const events = [
    { type: "message_start", message: { id: "msg_stream", type: "message", role: "assistant", model: "offline-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial text" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  await withProvider("anthropic", events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), async (provider) => {
    const chunks: string[] = [];
    const result = await provider.stream!("system", [{ role: "user", content: "hello" }], [], (text) => chunks.push(text));
    assert.equal(result.finishReason, "length");
    assert.equal(chunks.join(""), "partial text");
    assert.equal(result.text, "partial text");
    assert.deepEqual(result.toolCalls, []);
  });
});
