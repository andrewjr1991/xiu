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

test("a keyless local provider lists models and completes through the compatible API", async () => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/v1/models") {
      response.end(JSON.stringify({ object: "list", data: [{ id: "local-coder", object: "model", owned_by: "local" }] }));
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
    assert.equal((await provider.listModels?.())?.[0]?.id, "local-coder");
    assert.equal((await provider.complete("system", [{ role: "user", content: "hello" }], [])).text, "local response");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
