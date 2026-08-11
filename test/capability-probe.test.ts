import assert from "node:assert/strict";
import test from "node:test";
import { applyCapabilityProbe, capabilityProbeFlightKey, CAPABILITY_PROBE_PROTOCOL_VERSION, probeIsFresh, probeModelCapabilities } from "../src/capability-probe.js";
import { resolveConfig } from "../src/config.js";
import type { MediaBackend } from "../src/media.js";
import type { ModelProvider } from "../src/types.js";

const config = resolveConfig({
  provider: "openai-compatible", providerId: "private", model: "coder", baseURL: "https://example.test/v1", apiKey: "test",
  providerFeatures: { text: true, tools: true, vision: true, image: false, video: false },
});

test("capability probe single-flight key uses credential revision without deriving from the secret", () => {
  const first = { ...config, apiKey: "first-secret", credentialRevision: 7 };
  const rotatedWithoutRevision = { ...config, apiKey: "second-secret", credentialRevision: 7 };
  const rotated = { ...config, apiKey: "second-secret", credentialRevision: 8 };
  assert.equal(capabilityProbeFlightKey(first), capabilityProbeFlightKey(rotatedWithoutRevision));
  assert.notEqual(capabilityProbeFlightKey(first), capabilityProbeFlightKey(rotated));
});

function provider(probe: () => Promise<boolean>): ModelProvider {
  return {
    complete: async () => ({ text: "", toolCalls: [] }),
    probeToolSupport: probe,
  };
}

test("capability probe records verified tool and vision support without project data", async () => {
  let receivedImage = "";
  const mediaBackend: MediaBackend = {
    analyzeImage: async (_prompt, image) => {
      receivedImage = image;
      if (image.includes("NklEQVR4")) return "GREEN";
      if (image.includes("OUlEQVR4")) return "BLUE";
      return "RED";
    },
  };
  const result = await probeModelCapabilities(config, {
    provider: provider(async () => true), mediaBackend, now: () => new Date("2026-08-10T00:00:00.000Z"),
  });
  assert.deepEqual(result, {
    protocolVersion: CAPABILITY_PROBE_PROTOCOL_VERSION,
    providerId: "private", model: "coder", checkedAt: "2026-08-10T00:00:00.000Z",
    text: "supported", tools: "supported", vision: "supported",
  });
  assert.match(receivedImage, /^data:image\/png;base64,/);
});

test("vision probe rejects endpoints that accept but ignore image content", async () => {
  const result = await probeModelCapabilities(config, {
    provider: provider(async () => true),
    mediaBackend: { analyzeImage: async () => "OK" },
  });
  assert.equal(result.vision, "unsupported");
});

test("capability probe distinguishes unsupported responses from transient unknown failures", async () => {
  const unsupported = await probeModelCapabilities(config, {
    provider: provider(async () => false),
    mediaBackend: { analyzeImage: async () => { throw new Error("400 unsupported image input"); } },
  });
  assert.equal(unsupported.tools, "unsupported");
  assert.equal(unsupported.vision, "unsupported");

  const unknown = await probeModelCapabilities(config, {
    provider: provider(async () => { throw new Error("503 gateway unavailable"); }),
    mediaBackend: { analyzeImage: async () => { throw new Error("network reset"); } },
  });
  assert.equal(unknown.tools, "unknown");
  assert.equal(unknown.vision, "unknown");
  assert.deepEqual(applyCapabilityProbe(config.providerFeatures!, unknown), {
    text: true, tools: false, vision: false, image: false, video: false,
  });
  assert.equal(applyCapabilityProbe(config.providerFeatures!, { ...unknown, tools: "unsupported", vision: "supported" }).vision, false);
});

test("capability probe cache freshness is bounded and future timestamps are rejected", () => {
  const checkedAt = "2026-08-10T00:00:00.000Z";
  const probe = { protocolVersion: CAPABILITY_PROBE_PROTOCOL_VERSION, providerId: "private", model: "coder", checkedAt, text: "supported", tools: "supported", vision: "unsupported" } as const;
  const now = Date.parse(checkedAt);
  assert.equal(probeIsFresh(probe, now + 6 * 24 * 60 * 60 * 1000), true);
  assert.equal(probeIsFresh(probe, now + 8 * 24 * 60 * 60 * 1000), false);
  assert.equal(probeIsFresh(probe, now - 120_000), false);
  assert.equal(probeIsFresh({ ...probe, protocolVersion: 1 }, now), false);
});
