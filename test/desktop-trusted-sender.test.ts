import assert from "node:assert/strict";
import test from "node:test";
import { assertTrustedIpcSender } from "../apps/desktop/main/security-policy.js";

const trusted = { sender: { id: 7 }, senderFrame: { url: "xiu-app://bundle/index.html" } };

test("privileged IPC accepts only the main window's renderer from the bundled origin", () => {
  assert.doesNotThrow(() => assertTrustedIpcSender(trusted, 7));
  const rejected = /untrusted renderer/;
  // No main window yet: nothing is trusted.
  assert.throws(() => assertTrustedIpcSender(trusted, undefined), rejected);
  // Another webContents (a web tab, a dialog, a second window) with the right URL shape.
  assert.throws(() => assertTrustedIpcSender({ ...trusted, sender: { id: 8 } }, 7), rejected);
  // The main window navigated or embedded something from elsewhere.
  assert.throws(() => assertTrustedIpcSender({ sender: { id: 7 }, senderFrame: { url: "https://bundle/index.html" } }, 7), rejected);
  assert.throws(() => assertTrustedIpcSender({ sender: { id: 7 }, senderFrame: { url: "xiu-app://bundle.evil/index.html" } }, 7), rejected);
  assert.throws(() => assertTrustedIpcSender({ sender: { id: 7 }, senderFrame: { url: "file:///C:/app/index.html" } }, 7), rejected);
  // A frame that is already gone has no URL and is rejected rather than assumed.
  assert.throws(() => assertTrustedIpcSender({ sender: { id: 7 }, senderFrame: null }, 7), rejected);
  assert.throws(() => assertTrustedIpcSender({ sender: { id: 7 } }, 7), rejected);
});
