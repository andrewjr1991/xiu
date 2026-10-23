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

test("a channel certificate file contributes its PEM blocks and fails closed when it is unreadable or holds none", async (t) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createTrustedDispatcher, readCertificateAuthorityFile } = await import("../src/trusted-dispatcher.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-ca-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pem = path.join(root, "gateway.pem");
  await fs.writeFile(pem, "# corporate gateway\n-----BEGIN CERTIFICATE-----\nMIIBfirst\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIIBsecond\n-----END CERTIFICATE-----\n");
  const certificates = readCertificateAuthorityFile(pem);
  assert.equal(certificates.length, 2);
  assert.match(certificates[1], /MIIBsecond/);
  assert.ok(createTrustedDispatcher(undefined, pem), "an explicit certificate file always yields a dispatcher with an explicit ca list");
  assert.ok(createTrustedDispatcher("http://127.0.0.1:12334", pem));
  const empty = path.join(root, "empty.pem");
  await fs.writeFile(empty, "not a certificate\n");
  assert.throws(() => readCertificateAuthorityFile(empty), /XIU_CA_CERT_INVALID/);
  assert.throws(() => readCertificateAuthorityFile(path.join(root, "missing.pem")), /XIU_CA_CERT_UNREADABLE/);
  assert.throws(() => createTrustedDispatcher(undefined, path.join(root, "missing.pem")), /XIU_CA_CERT_UNREADABLE/);
});
