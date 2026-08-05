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
      capabilities: { tools: {} },
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
  } else if (message.method === "notifications/cancelled") {
    clearTimeout(pendingTimers.get(message.params.requestId));
    pendingTimers.delete(message.params.requestId);
  }
});
