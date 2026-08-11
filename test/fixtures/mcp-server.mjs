import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, terminal: false });
const pendingTimers = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "xiu-test-mcp", version: "1.0.0" },
    } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "echo", description: "Echo a message", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
      { name: "change", description: "Pretend to change something", inputSchema: { type: "object", properties: {} } },
    ] } });
  } else if (message.method === "tools/call") {
    const respond = () => send({ jsonrpc: "2.0", id: message.id, result: {
      content: [{ type: "text", text: message.params.name === "echo" ? `echo:${message.params.arguments.message}` : "changed" }],
    } });
    if (message.params.arguments.message === "slow") pendingTimers.set(message.id, setTimeout(respond, 5_000));
    else respond();
  } else if (message.method === "resources/list") {
    send({ jsonrpc: "2.0", id: message.id, result: message.params?.cursor
      ? { resources: [{ name: "Second", uri: "test://second", mimeType: "text/plain" }] }
      : { resources: [{ name: "Greeting", uri: "test://greeting", description: "A test resource", mimeType: "text/plain" }], nextCursor: "page-2" } });
  } else if (message.method === "resources/templates/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { resourceTemplates: [{ name: "Document", uriTemplate: "test://docs/{id}", mimeType: "text/plain" }] } });
  } else if (message.method === "resources/read") {
    send({ jsonrpc: "2.0", id: message.id, result: { contents: [
      { uri: message.params.uri, mimeType: "text/plain", text: message.params.uri === "test://large" ? "x".repeat(40000) : `resource:${message.params.uri}` },
      { uri: message.params.uri, mimeType: "application/octet-stream", blob: "aGVsbG8=" },
    ] } });
  } else if (message.method === "prompts/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { prompts: [{ name: "review", description: "Review code", arguments: [{ name: "target", required: true }] }] } });
  } else if (message.method === "prompts/get") {
    send({ jsonrpc: "2.0", id: message.id, result: { description: "Review code", messages: [
      { role: "user", content: { type: "text", text: `review:${message.params.arguments.target}` } },
    ] } });
  } else if (message.method === "notifications/cancelled") {
    clearTimeout(pendingTimers.get(message.params.requestId));
    pendingTimers.delete(message.params.requestId);
  } else if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
