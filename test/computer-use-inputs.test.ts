import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { EDITOR_ONLY_KEYS, MAX_KEY_REPEAT, POINTER_KINDS, REPEATABLE_KEYS, TIER1_KEYS, TIER2_KEYS, inputTier, isEditorOnlyKey, isRepeatableKey } from "../apps/desktop/shared/computer-use-inputs.js";
import { FRAME_MAX_EDGE, frameScale, inputNeedsConfirmation, scaleElements, scaledSize, toClientCoordinate } from "../apps/desktop/main/computer-use-policy.js";

const bridge = fs.readFileSync(new URL("../apps/desktop/native/ComputerBridge.cs", import.meta.url), "utf8");
const keyArray = (name: string) => { const match = bridge.match(new RegExp(`static readonly string\\[\\] ${name}=\\{([^}]*)\\};`)); assert.ok(match, `${name} missing from ComputerBridge.cs`); return [...match[1]!.matchAll(/"([^"]+)"/g)].map(entry => entry[1]); };

test("the native helper embeds the same key tiers as the main process", () => {
  assert.deepEqual(keyArray("Tier1Keys"), [...TIER1_KEYS]);
  assert.deepEqual(keyArray("Tier2Keys"), [...TIER2_KEYS]);
  assert.deepEqual(keyArray("EditorOnlyKeys"), [...EDITOR_ONLY_KEYS]);
  assert.deepEqual(keyArray("RepeatableKeys"), [...REPEATABLE_KEYS]);
  // Repeat is for editing and navigation keys only, bounded identically on both sides; Enter, Tab, Escape and combinations never repeat.
  for (const key of REPEATABLE_KEYS) assert.ok((TIER1_KEYS as readonly string[]).includes(key) && !isEditorOnlyKey(key), key);
  for (const key of ["Enter", "Tab", "Escape", "F2", "Ctrl+A", "Ctrl+C", "Shift+End"]) assert.equal(isRepeatableKey(key), false, key);
  assert.equal(MAX_KEY_REPEAT, 50);
  assert.match(bridge, /repeat<1\|\|repeat>50\|\|\(repeat>1&&Array\.IndexOf\(RepeatableKeys,key\)<0\)\)throw new Exception\("repeat-denied"\)/);
  // Clipboard, select-all, undo/redo and Shift selection are editor-only; Ctrl+S (save) works app-wide but still confirms; system shortcuts are in no list at all.
  for (const key of [...TIER1_KEYS, ...TIER2_KEYS]) { assert.doesNotMatch(key, /^(Win|Alt|Meta)/); assert.equal(isEditorOnlyKey(key), key !== "Ctrl+S" && /^(Ctrl|Shift)\+/.test(key), key); }
  for (const key of ["Alt+Tab", "Alt+F4", "Win", "Ctrl+Alt+Delete", "Ctrl+Shift+Escape", "Ctrl+W", "F1", "PrintScreen"]) assert.equal(inputTier({ kind: "key", key }), undefined, key);
  // The helper refuses anything outside the two lists before touching SendInput, and gates editor keys on a focused editable control.
  assert.match(bridge, /Array\.IndexOf\(Tier1Keys,key\)<0&&Array\.IndexOf\(Tier2Keys,key\)<0\)throw new Exception\("shortcut-denied"\)/);
  assert.match(bridge, /editor-control-required/);
  assert.match(bridge, /bool multiline=text\.IndexOf\('\\r'\)>=0\|\|text\.IndexOf\('\\n'\)>=0;if\(multiline\)RequireEditor\(focused\)/);
  const editorPath = bridge.slice(bridge.indexOf("static bool SendEditorCommand("), bridge.indexOf("static void CheckControl("));
  assert.ok(editorPath.indexOf("RequireEditor(focused)") >= 0 && editorPath.indexOf("RequireEditor(focused)") < editorPath.indexOf("return h;"), "message routing must obtain its HWND through the editor guard");
});

test("pointer actions, text and tier-1 keys run automatically; drag and tier-2 keys always confirm", () => {
  for (const kind of ["click", "doubleclick", "rightclick", "scroll", "type"]) assert.equal(inputTier({ kind }), "automatic", kind);
  assert.equal(inputTier({ kind: "drag" }), "confirm");
  assert.deepEqual([...POINTER_KINDS], ["click", "doubleclick", "rightclick", "drag", "scroll"]);
  for (const key of TIER1_KEYS) assert.equal(inputTier({ kind: "key", key }), "automatic", key);
  for (const key of TIER2_KEYS) assert.equal(inputTier({ kind: "key", key }), "confirm", key);
  for (const kind of ["hover", "middleclick", "shortcut", ""]) assert.equal(inputTier({ kind }), undefined, kind);
  assert.equal(inputTier({ kind: "key" }), undefined);
  assert.equal(inputNeedsConfirmation({ automatic: true, origin: "model", tier: "automatic" }), false);
  assert.equal(inputNeedsConfirmation({ automatic: true, origin: "model", tier: "confirm" }), true);
  assert.equal(inputNeedsConfirmation({ automatic: false, origin: "model", tier: "automatic" }), true);
});

test("large windows are downscaled for the model and coordinates map back into the client area", () => {
  assert.equal(frameScale(1280, 720), 1);
  assert.equal(frameScale(3840, 2160), FRAME_MAX_EDGE / 3840);
  const scale = frameScale(1080, 3000);
  assert.deepEqual(scaledSize(1080, 3000, scale), { width: Math.round(1080 * scale), height: FRAME_MAX_EDGE });
  const elements = scaleElements([{ id: "a", x: 100, y: 2000, width: 50, height: 3 }], 0.5);
  assert.deepEqual(elements, [{ id: "a", x: 50, y: 1000, width: 25, height: 2 }]);
  const same = [{ id: "a", x: 1, y: 1, width: 1, height: 1 }];
  assert.equal(scaleElements(same, 1), same);
  assert.equal(toClientCoordinate(784, 0.5, 1600), 1568);
  assert.equal(toClientCoordinate(5000, 0.5, 1600), 1599);
  assert.equal(toClientCoordinate(-4, 0.5, 1600), 0);
  assert.equal(toClientCoordinate(300, 1, 720), 300);
});
