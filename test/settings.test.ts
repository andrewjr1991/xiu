import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsStore, XIU_BETA_SEARCH_AUTH_ENDPOINT, XIU_BETA_SEARXNG_ENDPOINT, XIU_BETA_SEARXNG_TOKEN_ENV } from "../src/settings.js";

const managedBetaSearch = {
  enabled: true,
  provider: "searxng" as const,
  baseURL: XIU_BETA_SEARXNG_ENDPOINT,
  managedAuth: "xiu-device" as const,
  authBaseURL: XIU_BETA_SEARCH_AUTH_ENDPOINT,
  timeoutMs: 20_000,
};

test("language preference persists outside the project", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-settings-"));
  const filename = path.join(directory, "settings.json");
  const store = new SettingsStore(filename, {});
  assert.deepEqual(await store.load(), { webSearch: managedBetaSearch });
  await store.save({ language: "zh-CN" });
  assert.deepEqual(await store.load(), { language: "zh-CN", webSearch: managedBetaSearch });
  assert.match(await fs.readFile(filename, "utf8"), /"zh-CN"/);
});

test("new and upgraded users receive lazy managed beta search without an embedded secret", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-beta-search-managed-"));
  const filename = path.join(directory, "settings.json");
  const store = new SettingsStore(filename, {});
  assert.deepEqual(await store.load(), { webSearch: managedBetaSearch });
  await assert.rejects(fs.readFile(filename, "utf8"), { code: "ENOENT" });
  await fs.rm(directory, { recursive: true, force: true });
});

test("internal beta search activates from a dedicated environment variable without persisting the token", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-beta-search-"));
  const filename = path.join(directory, "settings.json");
  const token = "internal-test-token-that-must-not-be-persisted";
  const store = new SettingsStore(filename, { [XIU_BETA_SEARXNG_TOKEN_ENV]: token });

  assert.deepEqual(await store.load(), {
    webSearch: {
      enabled: true,
      provider: "searxng",
      baseURL: XIU_BETA_SEARXNG_ENDPOINT,
      apiKeyEnv: XIU_BETA_SEARXNG_TOKEN_ENV,
      timeoutMs: 20_000,
    },
  });
  await assert.rejects(fs.readFile(filename, "utf8"), { code: "ENOENT" });
  await fs.rm(directory, { recursive: true, force: true });
});

test("explicit web search settings override the internal beta preset", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-beta-search-override-"));
  const filename = path.join(directory, "settings.json");
  const store = new SettingsStore(filename, { [XIU_BETA_SEARXNG_TOKEN_ENV]: "internal-test-token" });
  await store.save({
    language: "zh-CN",
    webSearch: { enabled: false, provider: "searxng", baseURL: XIU_BETA_SEARXNG_ENDPOINT },
  });

  assert.deepEqual(await store.load(), {
    language: "zh-CN",
    webSearch: { enabled: false, provider: "searxng", baseURL: `${XIU_BETA_SEARXNG_ENDPOINT}/` },
  });
  assert.doesNotMatch(await fs.readFile(filename, "utf8"), /internal-test-token/);
  await fs.rm(directory, { recursive: true, force: true });
});

test("a persisted beta environment reference migrates to managed auth after the legacy token is removed", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-beta-search-migrate-"));
  const filename = path.join(directory, "settings.json");
  await fs.writeFile(filename, JSON.stringify({
    language: "zh-CN",
    webSearch: {
      enabled: true,
      provider: "searxng",
      baseURL: XIU_BETA_SEARXNG_ENDPOINT,
      apiKeyEnv: XIU_BETA_SEARXNG_TOKEN_ENV,
    },
  }));
  const store = new SettingsStore(filename, {});
  assert.deepEqual(await store.load(), { language: "zh-CN", webSearch: managedBetaSearch });
  await fs.rm(directory, { recursive: true, force: true });
});

test("a persisted custom beta token reference migrates to managed auth when the variable is missing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-beta-search-custom-migrate-"));
  const filename = path.join(directory, "settings.json");
  await fs.writeFile(filename, JSON.stringify({
    webSearch: {
      enabled: true,
      provider: "searxng",
      baseURL: XIU_BETA_SEARXNG_ENDPOINT,
      apiKeyEnv: "XIU_SEARXNG_TOKEN",
    },
  }));
  const store = new SettingsStore(filename, {});
  assert.deepEqual(await store.load(), { webSearch: managedBetaSearch });
  await fs.rm(directory, { recursive: true, force: true });
});

test("managed search auth and its independent proxy survive settings reload", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-managed-search-settings-"));
  const filename = path.join(directory, "settings.json");
  const store = new SettingsStore(filename, {});
  const configured = {
    ...managedBetaSearch,
    baseURL: "https://search.example.com",
    authBaseURL: "https://search.example.com/xiu-auth",
    proxy: "http://127.0.0.1:12334",
  };
  await store.save({ webSearch: configured });
  assert.deepEqual((await store.load()).webSearch, {
    ...configured,
    baseURL: "https://search.example.com/",
    authBaseURL: "https://search.example.com/xiu-auth",
    proxy: "http://127.0.0.1:12334/",
  });
  await fs.rm(directory, { recursive: true, force: true });
});

test("the managed beta proxy is persisted even when it originated from XIU_WEB_PROXY", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-managed-search-env-proxy-"));
  const filename = path.join(directory, "settings.json");
  const proxy = "http://127.0.0.1:12334";
  const environmentStore = new SettingsStore(filename, { XIU_WEB_PROXY: proxy });
  const loaded = await environmentStore.load();

  assert.equal(loaded.webSearch?.proxy, proxy);
  await environmentStore.save(loaded);

  const cleanEnvironmentStore = new SettingsStore(filename, {});
  assert.deepEqual((await cleanEnvironmentStore.load()).webSearch, {
    ...managedBetaSearch,
    baseURL: `${XIU_BETA_SEARXNG_ENDPOINT}/`,
    proxy: `${proxy}/`,
  });
  await fs.rm(directory, { recursive: true, force: true });
});

test("update notifications are opt-in and persist only when enabled", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-update-settings-"));
  const filename = path.join(directory, "settings.json");
  const store = new SettingsStore(filename, {});
  assert.equal((await store.load()).update, undefined);
  await store.save({ update: { notifications: true } });
  assert.deepEqual((await store.load()).update, { notifications: true });
  assert.match(await fs.readFile(filename, "utf8"), /"notifications": true/);
  await store.save({ update: { notifications: false } });
  assert.equal((await store.load()).update, undefined);
  assert.doesNotMatch(await fs.readFile(filename, "utf8"), /notifications/);
  await fs.rm(directory, { recursive: true, force: true });
});
