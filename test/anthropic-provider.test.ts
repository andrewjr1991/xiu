import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { createProvider } from "../src/providers.js";
import type { ConversationMessage, ModelProvider } from "../src/types.js";

type Reply = { status?: number; json: unknown } | { sse: unknown[] };

function message(content: unknown[], stop_reason = "end_turn") {
  return { id: "msg", type: "message", role: "assistant", model: "claude-test", stop_reason, stop_sequence: null, content, usage: { input_tokens: 5, output_tokens: 2 } };
}

function badRequest(text: string): Reply {
  return { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: text } } };
}

const probeCall = { type: "tool_use", id: "probe", name: "xiu_capability_probe", input: { value: "OK" } };

/** Serves the replies in order and records every request body. */
async function withAnthropic(replies: Reply[], run: (provider: ModelProvider, requests: Record<string, unknown>[]) => Promise<void>): Promise<void> {
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      const reply = replies.shift();
      if (!reply) { response.statusCode = 500; response.end("{}"); return; }
      if ("sse" in reply) {
        response.setHeader("content-type", "text/event-stream");
        response.end(reply.sse.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
        return;
      }
      response.statusCode = reply.status ?? 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const config = resolveConfig({ provider: "anthropic", providerId: "anthropic", model: "claude-test", baseURL: `http://127.0.0.1:${address.port}`, apiKey: "test" });
    await run(createProvider(config), requests);
    assert.equal(replies.length, 0, "every scripted reply was consumed");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("tool probing falls back to auto when the model rejects a forced tool choice", async () => {
  await withAnthropic([
    badRequest('tool_choice: type "tool" and "any" are not supported for this model.'),
    { json: message([probeCall], "tool_use") },
  ], async (provider, requests) => {
    assert.equal(await provider.probeToolSupport?.(), true);
    assert.deepEqual(requests.map((request) => request.tool_choice), [{ type: "tool", name: "xiu_capability_probe" }, { type: "auto" }]);
  });
});

test("tool probing does not retry other rejections", async () => {
  await withAnthropic([badRequest("model: claude-test is not available")], async (provider) => {
    await assert.rejects(provider.probeToolSupport!(), /not available/);
  });
});

test("requests leave room for reasoning and fall back once to the legacy output limit", async () => {
  await withAnthropic([
    badRequest("max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for claude-test"),
    { json: message([{ type: "text", text: "fits" }]) },
    { json: message([{ type: "text", text: "still fits" }]) },
  ], async (provider, requests) => {
    assert.equal((await provider.complete("system", [{ role: "user", content: "hi" }], [])).text, "fits");
    assert.equal((await provider.complete("system", [{ role: "user", content: "again" }], [])).text, "still fits");
    assert.deepEqual(requests.map((request) => request.max_tokens), [32_000, 8192, 8192]);
  });
});

test("streaming applies the same output-limit fallback before any text is emitted", async () => {
  const events = [
    { type: "message_start", message: message([], null as unknown as string) },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "streamed" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  await withAnthropic([badRequest("max_tokens: 32000 > 4096"), { sse: events }], async (provider, requests) => {
    const chunks: string[] = [];
    const result = await provider.stream!("system", [{ role: "user", content: "hi" }], [], (text) => chunks.push(text));
    assert.equal(result.text, "streamed");
    assert.deepEqual(chunks, ["streamed"]);
    assert.deepEqual(requests.map((request) => request.max_tokens), [32_000, 8192]);
  });
});

const toolTurn = [
  { type: "thinking", thinking: "", signature: "sig-opaque" },
  { type: "redacted_thinking", data: "enc-opaque" },
  { type: "text", text: "reading" },
  { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
];

test("a tool-calling turn keeps only opaque thinking state and replays it first", async () => {
  await withAnthropic([
    { json: message(toolTurn, "tool_use") },
    { json: message([{ type: "text", text: "done" }]) },
  ], async (provider, requests) => {
    const turn = await provider.complete("system", [{ role: "user", content: "read a.ts" }], []);
    assert.deepEqual(turn.thinkingReplay, [{ type: "thinking", thinking: "", signature: "sig-opaque" }, { type: "redacted_thinking", data: "enc-opaque" }]);
    assert.deepEqual(turn.raw, [{ type: "text", text: "reading" }, { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } }]);

    const history: ConversationMessage[] = [
      { role: "user", content: "read a.ts" },
      { role: "assistant", content: turn.text, raw: turn.raw, toolCalls: turn.toolCalls, thinkingReplay: turn.thinkingReplay },
      { role: "tool", content: "export {}", toolCallId: "call-1", toolName: "read_file" },
    ];
    await provider.complete("system", history, []);
    const messages = requests[1]?.messages as Array<{ role: string; content: unknown }>;
    assert.deepEqual(messages[1], { role: "assistant", content: [...turn.thinkingReplay!, ...(turn.raw as unknown[])] });
    assert.deepEqual(messages[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "export {}" }] });
  });
});

test("readable thinking text is never kept, and nothing is kept without tool calls", async () => {
  await withAnthropic([
    { json: message([{ type: "thinking", thinking: "private reasoning", signature: "sig" }, { type: "text", text: "answer" }, toolTurn[3]!], "tool_use") },
    { json: message([{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "plain answer" }]) },
  ], async (provider) => {
    const withText = await provider.complete("system", [{ role: "user", content: "q" }], []);
    assert.equal(withText.thinkingReplay, undefined);
    assert.doesNotMatch(JSON.stringify(withText), /private reasoning|signature/);
    const plain = await provider.complete("system", [{ role: "user", content: "q" }], []);
    assert.equal(plain.thinkingReplay, undefined);
    assert.doesNotMatch(JSON.stringify(plain), /thinking|signature/);
  });
});

test("rejected thinking blocks are stripped from the whole history and stay off", async () => {
  const history: ConversationMessage[] = [
    { role: "user", content: "read a.ts" },
    { role: "assistant", content: "reading", toolCalls: [{ id: "call-1", name: "read_file", input: { path: "a.ts" } }], thinkingReplay: [{ type: "thinking", thinking: "", signature: "stale" }] },
    { role: "tool", content: "export {}", toolCallId: "call-1", toolName: "read_file" },
  ];
  await withAnthropic([
    badRequest("messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."),
    { json: message([{ type: "text", text: "recovered" }]) },
    { json: message([{ type: "text", text: "later" }]) },
  ], async (provider, requests) => {
    assert.equal((await provider.complete("system", history, [])).text, "recovered");
    assert.equal((await provider.complete("system", history, [])).text, "later");
    const assistant = (index: number) => (requests[index]?.messages as Array<{ content: unknown[] }>)[1]!.content.map((block) => (block as { type: string }).type);
    assert.deepEqual(assistant(0), ["thinking", "text", "tool_use"]);
    assert.deepEqual(assistant(1), ["text", "tool_use"]);
    assert.deepEqual(assistant(2), ["text", "tool_use"]);
  });
});
