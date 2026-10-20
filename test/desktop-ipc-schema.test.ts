import assert from "node:assert/strict";
import test from "node:test";
import { IpcArgumentError, PUSH_CHANNELS, hasIpcArgumentSchema, validateIpcArguments } from "../apps/desktop/main/ipc-schema.js";
import { desktopChannels } from "../apps/desktop/shared/protocol.js";

const rejects = (channel: string, args: unknown[], detail: RegExp): void => {
  assert.throws(() => validateIpcArguments(channel, args), (error: unknown) => {
    assert.ok(error instanceof IpcArgumentError, "IpcArgumentError expected");
    assert.equal(error.channel, channel);
    assert.match(error.message, detail);
    return true;
  });
};

test("every renderer invoke channel has an argument schema and push channels have none", () => {
  for (const [key, channel] of Object.entries(desktopChannels)) {
    if (PUSH_CHANNELS.has(channel)) {
      assert.equal(hasIpcArgumentSchema(channel), false, `${key} is pushed by main and must not accept invokes`);
    } else {
      assert.equal(hasIpcArgumentSchema(channel), true, `${key} has no IPC argument schema`);
    }
  }
  rejects("desktop:unknown", [], /no argument schema/);
});

test("well-formed requests pass through in canonical form", () => {
  assert.deepEqual(validateIpcArguments(desktopChannels.snapshot, []), []);
  assert.deepEqual(validateIpcArguments(desktopChannels.snapshot, [undefined]), []);
  assert.deepEqual(validateIpcArguments(desktopChannels.taskCreate, [{ text: "hello", answerTo: undefined }]), [{ text: "hello" }]);
  // Undeclared fields never reach the handler: UI-only form state and injected keys alike.
  assert.deepEqual(validateIpcArguments(desktopChannels.taskCreate, [{ text: "hello", shell: "rm -rf /", __proto__: { admin: true } }]), [{ text: "hello" }]);
  assert.deepEqual(validateIpcArguments(desktopChannels.providerUpsert, [{ id: "p", name: "P", kind: "openai", model: "m", features: { tools: true, vision: false, image: false, video: false, audio: false }, preset: "vendor", templateId: "deepseek" }]),
    [{ id: "p", name: "P", kind: "openai", model: "m", features: { tools: true, vision: false, image: false, video: false, audio: false } }]);
  assert.deepEqual(validateIpcArguments(desktopChannels.computerUse, [{ action: "stop", handle: "h" }]), [{ action: "stop" }]);
  assert.deepEqual(validateIpcArguments(desktopChannels.taskContinue, [{ text: "", taskId: "t1", answerTo: { taskId: "t1", questionId: "q1" } }]),
    [{ text: "", taskId: "t1", answerTo: { taskId: "t1", questionId: "q1" } }]);
  assert.deepEqual(validateIpcArguments(desktopChannels.runtimeConnect, []), [undefined]);
  assert.deepEqual(validateIpcArguments(desktopChannels.runtimeConnect, [{ afterSequence: 12 }]), [{ afterSequence: 12 }]);
  assert.deepEqual(validateIpcArguments(desktopChannels.skillPrepare, [undefined]), [undefined]);
  assert.deepEqual(validateIpcArguments(desktopChannels.skillPrepare, ["file"]), ["file"]);
  assert.deepEqual(validateIpcArguments(desktopChannels.copyMessage, ["copied text"]), ["copied text"]);
  assert.deepEqual(validateIpcArguments(desktopChannels.browser, [{ action: "layout", bounds: { x: 1.5, y: 2.25, width: 300, height: 200.5 }, visible: true }]),
    [{ action: "layout", bounds: { x: 1.5, y: 2.25, width: 300, height: 200.5 }, visible: true }]);
  assert.deepEqual(validateIpcArguments(desktopChannels.managementChange, [{ action: "fallback", revision: "r1", providerId: "a", chain: ["b", "c"] }]),
    [{ action: "fallback", revision: "r1", providerId: "a", chain: ["b", "c"] }]);
  assert.deepEqual(validateIpcArguments(desktopChannels.mcpManage, [{ action: "save", draft: { name: "docs", transport: "streamable-http", url: "https://example.test/mcp", risk: "read", oauth: { type: "oauth", scopes: ["read"] } } }]),
    [{ action: "save", draft: { name: "docs", transport: "streamable-http", url: "https://example.test/mcp", risk: "read", oauth: { type: "oauth", scopes: ["read"] } } }]);
  // The empty or null element id that models send with type/key is tolerated here and ignored by the controller.
  assert.deepEqual(validateIpcArguments(desktopChannels.computerUse, [{ action: "input", input: { kind: "type", frameId: "f1", elementId: null, text: "abc" } }]),
    [{ action: "input", input: { kind: "type", frameId: "f1", elementId: null, text: "abc" } }]);
  assert.deepEqual(validateIpcArguments(desktopChannels.computerUse, [{ action: "stop" }]), [{ action: "stop" }]);
  const data = new Uint8Array([1, 2, 3]);
  const [imported] = validateIpcArguments(desktopChannels.attachmentsImport, [{ files: [{ name: "a.png", data }] }]) as [{ files: Array<{ data: Uint8Array }> }];
  assert.equal(imported.files[0]?.data, data);
  assert.deepEqual(validateIpcArguments(desktopChannels.providerVisionTest, [{ providerId: "p", model: "m", allCandidates: false }]), [{ providerId: "p", model: "m", allCandidates: false }]);
  // Preferences are parsed by the store; the schema only requires the argument.
  assert.deepEqual(validateIpcArguments(desktopChannels.preferencesSave, [{ theme: "dark", anything: 1 }]), [{ theme: "dark", anything: 1 }]);
  rejects(desktopChannels.preferencesSave, [], /argument 1 must be present/);
});

test("malformed requests are rejected with the channel and field, never the value", () => {
  rejects(desktopChannels.snapshot, ["unexpected"], /at most 0 arguments/);
  rejects(desktopChannels.taskCreate, [{ text: "ok" }, "extra"], /at most 1 argument\./);
  rejects(desktopChannels.taskCreate, [{ text: 42 }], /argument 1\.text must be a string/);
  rejects(desktopChannels.taskCreate, ["just text"], /argument 1 must be an object/);
  rejects(desktopChannels.taskCreate, [["text"]], /argument 1 must be an object/);
  rejects(desktopChannels.taskCreate, [null], /argument 1 must be an object/);
  rejects(desktopChannels.taskDelete, [{ taskId: "t1", confirmed: "yes" }], /argument 1\.confirmed must be one of true/);
  rejects(desktopChannels.taskDelete, [{ taskId: "t1" }], /argument 1\.confirmed must be one of true/);
  rejects(desktopChannels.approvalModeSet, [{ mode: "root", contextId: "c" }], /argument 1\.mode must be one of "ask", "workspace", "full"/);
  rejects(desktopChannels.approvalDecide, [{ approvalId: "a", allowed: "true" }], /argument 1\.allowed must be a boolean/);
  rejects(desktopChannels.approvalDecide, [{ approvalId: "a", allowed: true, confirmedRisk: "execute" }], /confirmedRisk must be one of "dangerous"/);
  rejects(desktopChannels.copyMessage, ["x".repeat(200_001)], /argument 1 must be a string of at most 200000 characters/);
  rejects(desktopChannels.copyMessage, [{ text: "x" }], /argument 1 must be a string/);
  rejects(desktopChannels.skillPrepare, ["url"], /argument 1 must be one of "directory", "file"/);
  rejects(desktopChannels.terminalResize, [{ sessionId: "s", cols: 80.5, rows: 24 }], /argument 1\.cols must be an integer between 1 and 10000/);
  rejects(desktopChannels.terminalResize, [{ sessionId: "s", cols: Number.POSITIVE_INFINITY, rows: 24 }], /argument 1\.cols must be an integer/);
  rejects(desktopChannels.terminalWrite, [{ sessionId: "s", data: Buffer.from("x") }], /argument 1\.data must be a string/);
  rejects(desktopChannels.attachmentsImport, [{ files: [{ name: "a", data: "not-bytes" }] }], /argument 1\.files\[0\]\.data must be binary data/);
  rejects(desktopChannels.attachmentsImport, [{ files: "a.png" }], /argument 1\.files must be an array/);
  rejects(desktopChannels.browser, [{ action: "navigate" }], /argument 1\.url must be a string/);
  rejects(desktopChannels.browser, [{ action: "open-devtools" }], /argument 1\.action must be one of/);
  rejects(desktopChannels.browser, [{ action: "layout", bounds: { x: 0, y: 0, width: -1, height: 1 }, visible: true }], /bounds\.width must be a finite number between 0/);
  rejects(desktopChannels.mcpManage, [{ action: "save", draft: { name: "n", transport: "http", risk: "read" } }], /draft\.transport must be one of "stdio", "streamable-http"/);
  rejects(desktopChannels.mcpManage, [{ action: "delete", name: "n", fingerprint: "f" }], /argument 1\.confirmed must be one of true/);
  rejects(desktopChannels.mcpBrowse, [{ name: "n", action: "read", args: { key: 1 } }], /argument 1\.args\.key must be a string/);
  rejects(desktopChannels.managementChange, [{ action: "stage", revision: "r", phase: "deploy" }], /phase must be one of "planning", "implementation", "verification"/);
  rejects(desktopChannels.pluginChange, [{ action: "approve", id: "acme.demo", fingerprint: "f".repeat(64), confirmed: false }], /confirmed must be one of true/);
  rejects(desktopChannels.managementChange, [{ action: "skill-install", revision: "r", token: "t", confirmed: true, replace: false }], /replace must be one of true/);
  rejects(desktopChannels.managementChange, [{ action: "skill-uninstall", revision: "r", name: "fixture" }], /confirmed must be one of true/);
  rejects(desktopChannels.skillPrepareRemote, [{ url: 7 }], /url must be a string/);
  assert.deepEqual(validateIpcArguments(desktopChannels.skillPrepareRemote, [{ url: "https://example.test/skills.git", extra: 1 }]), [{ url: "https://example.test/skills.git" }]);
  assert.deepEqual(validateIpcArguments(desktopChannels.managementChange, [{ action: "skill-uninstall", revision: "r", name: "fixture", confirmed: true }]), [{ action: "skill-uninstall", revision: "r", name: "fixture", confirmed: true }]);
  rejects(desktopChannels.pluginChange, [{ action: "approve", id: "acme.demo", fingerprint: "f".repeat(65), confirmed: true }], /fingerprint must be a string of at most 64/);
  rejects(desktopChannels.pluginChange, [{ action: "revoke", id: "acme.demo" }], /confirmed must be one of true/);
  rejects(desktopChannels.pluginChange, [{ action: "uninstall", id: "acme.demo" }], /action must be one of/);
  assert.deepEqual(validateIpcArguments(desktopChannels.pluginChange, [{ action: "disable", id: "acme.demo", confirmed: true }]), [{ action: "disable", id: "acme.demo" }]);
  rejects(desktopChannels.managementChange, [{ action: "web", revision: "r", enabled: true, provider: "google", endpoint: "" }], /provider must be one of/);
  rejects(desktopChannels.computerUse, [{ action: "select" }], /argument 1\.handle must be a string/);
  rejects(desktopChannels.computerUse, [{ action: "input", input: { kind: "launch", frameId: "f" } }], /input\.kind must be one of/);
  rejects(desktopChannels.computerUse, [{ action: "input", input: { kind: "key", frameId: "f", key: "Backspace", repeat: 0 } }], /input\.repeat must be an integer between 1/);
  rejects(desktopChannels.providerUpsert, [{ id: "p", name: "P", kind: "openai", model: "m", features: { tools: true, vision: false, image: false, video: false } }], /features\.audio must be a boolean/);
  rejects(desktopChannels.providerUpsert, [{ id: "p", name: "P", kind: "google", model: "m", features: { tools: true, vision: false, image: false, video: false, audio: false } }], /kind must be one of/);
  // A rejected credential never comes back in the message.
  const secret = "sk-live-top-secret-value";
  assert.throws(() => validateIpcArguments(desktopChannels.providerCredentialSave, [{ providerId: 7, apiKey: secret }]), (error: Error) => {
    assert.ok(!error.message.includes(secret));
    assert.match(error.message, /argument 1\.providerId must be a string/);
    return true;
  });
  assert.throws(() => validateIpcArguments(desktopChannels.providerCredentialSave, [{ providerId: "p", apiKey: secret.repeat(1_000) }]), (error: Error) => {
    assert.ok(!error.message.includes(secret));
    return true;
  });
});
