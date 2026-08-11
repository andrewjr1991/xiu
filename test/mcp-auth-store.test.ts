import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpAuthStore, type McpAuthIdentity } from "../src/mcp-auth-store.js";

const first: McpAuthIdentity = {
  resource: "https://mcp.example.com/",
  issuer: "https://login.example.com/",
  clientId: "xiu-client-a",
};

test("MCP auth store persists versioned credentials bound to resource, issuer, and client", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-auth-store-"));
  const file = path.join(directory, "mcp-auth.json");
  const store = new McpAuthStore(file);
  const second = { ...first, issuer: "https://accounts.example.net/" };
  try {
    await store.save({
      ...first,
      tokens: { access_token: "access-a", refresh_token: "refresh-a", token_type: "Bearer", scope: "files:read" },
      clientInformation: { client_id: first.clientId },
      resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
    });
    await store.save({
      ...second,
      tokens: { access_token: "access-b", token_type: "Bearer" },
      clientInformation: { client_id: second.clientId },
    });
    await Promise.all([
      store.save({ ...first, tokens: { access_token: "access-a2", token_type: "Bearer" } }),
      store.save({ ...second, tokens: { access_token: "access-b2", token_type: "Bearer" } }),
    ]);

    const reloaded = new McpAuthStore(file);
    assert.equal((await reloaded.get(first))?.tokens?.access_token, "access-a2");
    assert.equal((await reloaded.get(second))?.tokens?.access_token, "access-b2");
    assert.equal((await reloaded.find(first.resource, first.issuer, first.clientId))[0]?.tokens?.access_token, "access-a2");
    assert.equal((await reloaded.find(first.resource)).length, 2);
    assert.equal((await reloaded.find("https://unrelated.example.com/")).length, 0);
    assert.equal(await reloaded.get({ ...first, clientId: "another-client" }), undefined);
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { version: number; entries: Record<string, unknown> };
    assert.equal(parsed.version, 1);
    assert.equal(Object.keys(parsed.entries).length, 2);
    assert.doesNotMatch(JSON.stringify(parsed), /code_verifier|authorization_code|\"state\"/i);

    assert.equal(await reloaded.delete(first), true);
    assert.equal(await reloaded.get(first), undefined);
    assert.equal((await reloaded.get(second))?.tokens?.access_token, "access-b2");
    assert.equal(await reloaded.delete(first), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("MCP auth store rejects corrupt or unsupported files without overwriting them", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-mcp-auth-corrupt-"));
  const file = path.join(directory, "mcp-auth.json");
  try {
    await fs.writeFile(file, JSON.stringify({ version: 2, entries: {} }));
    const store = new McpAuthStore(file);
    await assert.rejects(store.get(first), /unsupported.*version/i);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).version, 2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
