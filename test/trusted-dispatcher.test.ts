import assert from "node:assert/strict";
import test from "node:test";
import { combineCertificateAuthorities } from "../src/trusted-dispatcher.js";

test("combines bundled and system certificate authorities without duplicates", () => {
  assert.deepEqual(
    combineCertificateAuthorities(["public-a", "shared"], ["enterprise", "shared"]),
    ["public-a", "shared", "enterprise"],
  );
});

test("leaves the default TLS behavior unchanged when no system roots are available", () => {
  assert.equal(combineCertificateAuthorities(["public-a"], []), undefined);
});
