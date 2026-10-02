import assert from "node:assert/strict";
import test from "node:test";
import { COMPOSITION_END_GRACE_MS, createComposerEnterGuard } from "../apps/desktop/renderer/src/composer-enter-guard.js";

const enter = { key: "Enter", code: "Enter" };

function guard() {
  let time = 1000;
  return { value: createComposerEnterGuard(() => time), advance: (ms: number) => { time += ms; } };
}

test("desktop composer keeps ordinary Enter submission and Shift+Enter newline", () => {
  const { value } = guard();
  assert.equal(value.shouldSubmit(enter), true);
  assert.equal(value.shouldSubmit({ ...enter, shiftKey: true }), false);
  assert.equal(value.shouldSubmit({ key: "a" }), false);
  assert.equal(value.shouldSubmit({ ...enter, code: "NumpadEnter" }), true);
});

test("desktop composer never submits Enter while composition lifecycle is active", () => {
  const { value, advance } = guard();
  value.compositionStart();
  advance(5000);
  assert.equal(value.shouldSubmit(enter), false, "lifecycle state also covers missing native flags");
  value.keyUp();
  assert.equal(value.shouldSubmit(enter), false, "a keyup must not end an active composition");
  assert.equal(value.shouldSubmit({ ...enter, shiftKey: true }), false);
});

test("desktop composer honors native isComposing and legacy keyCode 229 without lifecycle events", () => {
  const { value } = guard();
  assert.equal(value.shouldSubmit({ ...enter, isComposing: true }), false);
  value.keyUp();
  assert.equal(value.shouldSubmit({ ...enter, keyCode: 229 }), false);
  value.keyUp();
  assert.equal(value.shouldSubmit({ key: "Process", code: "Enter", keyCode: 229 }), false);
  value.keyUp();
  assert.equal(value.shouldSubmit(enter), true);
});

test("desktop composer blocks candidate Enter after compositionend then allows an immediate second press", () => {
  const { value, advance } = guard();
  value.compositionStart();
  value.compositionEnd();
  advance(1);
  assert.equal(value.shouldSubmit(enter), false);
  value.keyUp();
  assert.equal(value.shouldSubmit(enter), true, "release identifies a deliberate new press without a cooldown");
});

test("desktop composer handles the ordinary keydown, compositionend, keyup ordering", () => {
  const { value } = guard();
  value.compositionStart();
  assert.equal(value.shouldSubmit({ ...enter, isComposing: true }), false);
  value.compositionEnd();
  value.keyUp();
  assert.equal(value.shouldSubmit(enter), true);
});

test("desktop composer expires compositionend grace when mouse acceptance has no keyup", () => {
  const { value, advance } = guard();
  value.compositionStart();
  value.compositionEnd();
  advance(COMPOSITION_END_GRACE_MS);
  assert.equal(value.shouldSubmit(enter), true);
});

test("desktop composer forgets a completed composition on subsequent ordinary typing", () => {
  const { value } = guard();
  value.compositionStart();
  value.compositionEnd();
  assert.equal(value.shouldSubmit({ key: "a" }), false);
  assert.equal(value.shouldSubmit(enter), true);
});

test("desktop composer never submits repeat keydowns from a held IME confirmation Enter", () => {
  const { value, advance } = guard();
  value.compositionStart();
  assert.equal(value.shouldSubmit({ ...enter, isComposing: true }), false);
  value.compositionEnd();
  advance(1000);
  assert.equal(value.shouldSubmit({ ...enter, repeat: true }), false);
  value.keyUp();
  assert.equal(value.shouldSubmit(enter), true);
});

test("desktop composer repeat guard also covers legacy Process and NumpadEnter keys", () => {
  const { value, advance } = guard();
  assert.equal(value.shouldSubmit({ key: "Process", code: "NumpadEnter", keyCode: 229 }), false);
  advance(1000);
  assert.equal(value.shouldSubmit({ ...enter, code: "NumpadEnter", repeat: true }), false);
  value.keyUp();
  assert.equal(value.shouldSubmit({ ...enter, code: "NumpadEnter" }), true);
});

test("desktop composer missing keyup does not suppress a new non-repeated Enter", () => {
  const { value, advance } = guard();
  value.compositionEnd();
  assert.equal(value.shouldSubmit(enter), false);
  advance(COMPOSITION_END_GRACE_MS);
  assert.equal(value.shouldSubmit(enter), true);
});

test("desktop composer reset cleans active composition and pending end/repeat state", () => {
  const { value } = guard();
  value.compositionStart();
  value.reset();
  assert.equal(value.shouldSubmit(enter), true, "blur or unmount clears an interrupted composition");
  value.compositionStart();
  assert.equal(value.shouldSubmit(enter), false);
  value.compositionEnd();
  value.reset();
  assert.equal(value.shouldSubmit({ ...enter, repeat: true }), true);
});

test("desktop composer instances and restarted compositions do not inherit stale end state", () => {
  const { value, advance } = guard();
  value.compositionEnd();
  value.compositionStart();
  advance(1000);
  assert.equal(value.shouldSubmit(enter), false);
  value.compositionEnd();
  value.keyUp();
  assert.equal(value.shouldSubmit(enter), true);
  value.compositionStart();
  assert.equal(guard().value.shouldSubmit(enter), true);
});
