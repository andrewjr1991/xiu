import assert from "node:assert/strict";
import test from "node:test";
import { resolveResourceUri } from "../src/commands/mcp-commands.js";
import type { McpManager } from "../src/mcp.js";

function manager(): { manager: McpManager; listed: number } {
  const state = { listed: 0 };
  const fake = {
    listResources: async (server: string) => {
      state.listed++;
      return { server, truncated: false, resources: [{ name: "readme", uri: "notes://readme" }], templates: [{ name: "note", uriTemplate: "notes://{folder}/{id}{?format}", description: "one note" }] };
    },
  } as unknown as McpManager;
  return { manager: fake, get listed() { return state.listed; } };
}

test("/mcp read uses a plain URI as given without listing the catalog", async () => {
  const f = manager();
  assert.equal(await resolveResourceUri(f.manager, "srv", "notes://readme", [], "en-US"), "notes://readme");
  assert.equal(f.listed, 0);
});

test("/mcp read expands a template chosen by name or typed directly from name=value arguments", async () => {
  const f = manager();
  assert.equal(await resolveResourceUri(f.manager, "srv", "note", ["folder=work notes", "id=7", "format=md"], "en-US"), "notes://work%20notes/7?format=md");
  assert.equal(await resolveResourceUri(f.manager, "srv", "notes://{folder}/{id}{?format}", ["folder=a", "id=b", "format="], "en-US"), "notes://a/b?format=");
  assert.equal(await resolveResourceUri(f.manager, "srv", "notes://{folder}/{id}{?format}", ["folder=a", "id=b", "format="], "zh-CN"), "notes://a/b?format=");
});

test("/mcp read rejects unknown template names and malformed variable arguments", async () => {
  const f = manager();
  await assert.rejects(resolveResourceUri(f.manager, "srv", "missing", ["id=1"], "en-US"), /has no resource template named "missing"; list them with \/mcp resources srv/);
  await assert.rejects(resolveResourceUri(f.manager, "srv", "note", ["id"], "en-US"), /Expected name=value after the resource template, got "id"/);
  await assert.rejects(resolveResourceUri(f.manager, "srv", "note", ["=1"], "en-US"), /Expected name=value/);
});
