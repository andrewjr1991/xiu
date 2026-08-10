import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { createProvider, probeProvider } from "../src/providers.js";

test("local OpenAI-compatible providers do not require a cloud API key", () => {
  const config = resolveConfig({
    provider: "ollama", providerId: "ollama", model: "local-model", baseURL: "http://127.0.0.1:11434/v1",
    providerFeatures: { text: true, tools: true, vision: false, image: false, video: false },
  });
  assert.doesNotThrow(() => createProvider(config));
});

test("custom providers require the configured key environment variable when named", () => {
  const variable = "XIU_TEST_MISSING_PROVIDER_KEY";
  delete process.env[variable];
  const config = resolveConfig({
    provider: "openai-compatible", providerId: "private", model: "coder", baseURL: "https://example.test/v1", apiKeyEnv: variable,
    providerFeatures: { text: true, tools: true, vision: false, image: false, video: false },
  });
  assert.throws(() => createProvider(config), new RegExp(variable));
});

test("a locally saved provider key is used for compatible API requests", async () => {
  let authorization = "";
  const server = http.createServer((request, response) => {
    authorization = request.headers.authorization ?? "";
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      id: "chat-key", object: "chat.completion", created: 1, model: "private-coder",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "authenticated" } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const config = resolveConfig({
      provider: "openai-compatible", providerId: "private", model: "private-coder",
      baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "saved-provider-key",
      providerFeatures: { text: true, tools: true, vision: false, image: false, video: false },
    });
    const response = await createProvider(config).complete("system", [{ role: "user", content: "hello" }], []);
    assert.equal(response.text, "authenticated");
    assert.equal(authorization, "Bearer saved-provider-key");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("OpenAI-compatible usage reports server-side prompt cache tokens", async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: "chat-cache", object: "chat.completion", created: 1, model: "coder",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "cached" } }],
        usage: { prompt_tokens: 1200, completion_tokens: 20, total_tokens: 1220, prompt_tokens_details: { cached_tokens: 1000 } },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const config = resolveConfig({ provider: "openai-compatible", providerId: "private", model: "coder", baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "test" });
    const result = await createProvider(config).complete("stable system", [{ role: "user", content: "hello" }], []);
    assert.equal(result.usage?.inputTokens, 1200);
    assert.equal(result.usage?.cacheReadInputTokens, 1000);
    assert.equal(result.usage?.cacheCreationInputTokens, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Anthropic marks the stable system prompt ephemeral and reports cache usage", async () => {
  let requestBody: Record<string, unknown> = {};
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: "msg_cache", type: "message", role: "assistant", model: "claude-test", stop_reason: "end_turn", stop_sequence: null,
        content: [{ type: "text", text: "cached" }],
        usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 400 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const config = resolveConfig({ provider: "anthropic", providerId: "anthropic", model: "claude-test", baseURL: `http://127.0.0.1:${address.port}`, apiKey: "test" });
    const result = await createProvider(config).complete("stable system", [{ role: "user", content: "hello" }], []);
    assert.deepEqual(requestBody.system, [{ type: "text", text: "stable system", cache_control: { type: "ephemeral" } }]);
    assert.equal(result.usage?.inputTokens, 1000);
    assert.equal(result.usage?.cacheCreationInputTokens, 500);
    assert.equal(result.usage?.cacheReadInputTokens, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("concurrent model discovery requests are coalesced without caching chat completions", async () => {
  let modelCalls = 0;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/v1/models") {
      modelCalls++;
      setTimeout(() => response.end(JSON.stringify({ object: "list", data: [{ id: "coder", object: "model", owned_by: "test" }] })), 20);
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const config = resolveConfig({ provider: "openai-compatible", providerId: "dedupe", model: "coder", baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "test" });
    const left = createProvider(config);
    const right = createProvider(config);
    const [first, second] = await Promise.all([left.listModels!(), right.listModels!()]);
    assert.equal(modelCalls, 1);
    assert.equal(first[0]?.id, "coder");
    assert.equal(second[0]?.id, "coder");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("provider probing falls back to a minimal chat request when model discovery is unsupported", async () => {
  let chatCalls = 0;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/v1/models") {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "unsupported" }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      chatCalls += 1;
      response.end(JSON.stringify({
        id: "chat-probe", object: "chat.completion", created: 1, model: "private-coder",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const config = resolveConfig({
      provider: "openai-compatible", providerId: "private", model: "private-coder",
      baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "saved-provider-key",
    });
    const result = await probeProvider(config);
    assert.deepEqual(result.models, []);
    assert.match(result.discoveryError ?? "", /unsupported|404/i);
    assert.equal(chatCalls, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("provider probing verifies text completion even when model discovery succeeds", async () => {
  let chatCalls = 0;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/v1/models") {
      response.end(JSON.stringify({ object: "list", data: [{ id: "coder", object: "model", owned_by: "test" }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      chatCalls += 1;
      response.end(JSON.stringify({ id: "chat-probe", object: "chat.completion", created: 1, model: "coder", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const result = await probeProvider(resolveConfig({ provider: "openai-compatible", providerId: "private", model: "coder", baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "test" }));
    assert.equal(result.models[0]?.id, "coder");
    assert.equal(chatCalls, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a keyless local provider lists models and completes through the compatible API", async () => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/v1/models") {
      response.end(JSON.stringify({ object: "list", data: [{ id: "local-coder", object: "model", owned_by: "local", context_window: 1_000_000 }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      response.end(JSON.stringify({ id: "chat-1", object: "chat.completion", created: 1, model: "local-coder", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "local response" } }] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const config = resolveConfig({ provider: "ollama", providerId: "ollama", model: "local-coder", baseURL: `http://127.0.0.1:${address.port}/v1` });
    const provider = createProvider(config);
    const listed = await provider.listModels?.();
    assert.equal(listed?.[0]?.id, "local-coder");
    assert.equal(listed?.[0]?.contextWindow, 1_000_000);
    assert.equal((await provider.complete("system", [{ role: "user", content: "hello" }], [])).text, "local response");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("OpenAI-compatible tool probing forces an inert structured tool call", async () => {
  let requestBody: Record<string, unknown> = {};
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: "chat-tool-probe", object: "chat.completion", created: 1, model: "private-coder",
        choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "xiu_capability_probe", arguments: '{"value":"OK"}' } }] } }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const config = resolveConfig({ provider: "openai-compatible", providerId: "private", model: "private-coder", baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "test" });
    assert.equal(await createProvider(config).probeToolSupport?.(), true);
    assert.deepEqual(requestBody.tool_choice, { type: "function", function: { name: "xiu_capability_probe" } });
    assert.equal((requestBody.tools as Array<{ function: { name: string } }>)[0]?.function.name, "xiu_capability_probe");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("OpenAI-compatible tool probing falls back to auto for thinking models", async () => {
  const requestBodies: Record<string, unknown>[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requestBodies.push(body);
      response.setHeader("content-type", "application/json");
      const structured = body.tool_choice === "auto";
      response.end(JSON.stringify({
        id: "chat-tool-probe", object: "chat.completion", created: 1, model: "thinking-coder",
        choices: [{ index: 0, finish_reason: structured ? "tool_calls" : "stop", message: structured
          ? { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "xiu_capability_probe", arguments: '{"value":"OK"}' } }] }
          : { role: "assistant", content: '<tool_call name="xiu_capability_probe">{"value":"OK"}</tool_call>' } }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const config = resolveConfig({ provider: "openai-compatible", providerId: "private", model: "thinking-coder", baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "test" });
    assert.equal(await createProvider(config).probeToolSupport?.(), true);
    assert.equal(requestBodies.length, 2);
    assert.deepEqual(requestBodies[0]?.tool_choice, { type: "function", function: { name: "xiu_capability_probe" } });
    assert.equal(requestBodies[1]?.tool_choice, "auto");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("OpenAI-compatible tool probing never executes textual pseudo tool calls", async () => {
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requestCount += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: "chat-tool-probe", object: "chat.completion", created: 1, model: "text-only",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '<tool_call name="xiu_capability_probe">{"value":"OK"}</tool_call>' } }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const config = resolveConfig({ provider: "openai-compatible", providerId: "private", model: "text-only", baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "test" });
    assert.equal(await createProvider(config).probeToolSupport?.(), false);
    assert.equal(requestCount, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
