const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createSmokeWindow, evaluate, waitFor } = require("./ui-smoke-helpers.cjs");

const root = path.resolve(__dirname, "../../..", ".desktop-build-temp");
fs.mkdirSync(root, { recursive: true });
const userData = fs.mkdtempSync(path.join(root, "history-performance-"));
app.setPath("userData", userData);
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
app.on("will-quit", () => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* Temporary Chromium handles may linger. */ }
});

app.whenReady().then(async () => {
  let window;
  try {
    const observations = [];
    for (const count of [100, 500, 2000]) {
      window = createSmokeWindow(BrowserWindow, path.join(__dirname, "ui-smoke-preload.cjs"));
      window.show();
      await window.loadFile(path.resolve(__dirname, "../dist/renderer/index.html"));
      await waitFor(window, `document.body.innerText.includes('G5C 验收工作区')`, "workspace");
      await evaluate(window, `window.xiuSmoke.historyStressFixture(${count})`);
      await waitFor(window, `document.querySelector('.history-row')`, "synthetic history row");
      await evaluate(window, `window.historyRenderStart = performance.now(); document.querySelector('.history-row').click()`);
      await waitFor(window, `document.querySelectorAll('.conversation-round').length === ${Math.min(count, 50)}`, "complete history", 20000);
      const observation = await evaluate(window, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
        sourceRounds: ${count}, mountedRounds: document.querySelectorAll('.conversation-round').length,
        renderMs: Math.round(performance.now() - window.historyRenderStart),
        domNodes: document.querySelectorAll('*').length,
        lastReplyVisible: document.querySelector('.task-scroll').innerText.includes('历史回合 ${count}')
      }))))`);
      assert(observation.lastReplyVisible, "Last historical result was omitted.");
      const samples = [];
      for (let sample = 0; sample < 9; sample++) {
        samples.push(await evaluate(window, `new Promise(resolve => {
          const input = document.querySelector('.composer textarea');
          const started = performance.now();
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '合成输入 ${sample}');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(performance.now() - started))));
        })`));
      }
      samples.sort((a, b) => a - b);
      observation.inputFrameMs = { median: samples[4], maximum: samples[8], samples };
      await evaluate(window, `document.querySelector('.turn-process').open = true`);
      await waitFor(window, `document.querySelector('.turn-process .process-row')`, "expanded process record");
      assert(await evaluate(window, `document.querySelectorAll('.conversation-round').length === ${Math.min(count, 50)} && document.querySelector('.turn-process').innerText.includes('合成')`), "Expanding must retain the stored tool record and all displayed rounds.");
      await evaluate(window, `document.querySelector('.turn-process').open = false`);
      await waitFor(window, `!document.querySelector('.turn-process .process-row')`, "closed details released");
      await evaluate(window, `document.querySelector('.turn-process').open = true`);
      await waitFor(window, `document.querySelector('.turn-process .process-row')`, "reopened process record");
      await evaluate(window, `window.expandAllStart = performance.now(); document.querySelector('[data-history-action="all"]').click()`);
      await waitFor(window, `document.querySelectorAll('.conversation-round').length === ${count}`, "explicit complete history", 30000);
      observation.expandAllMs = await evaluate(window, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(performance.now()-window.expandAllStart)))))`);
      assert(await evaluate(window, `document.querySelector('[data-history-round="0"]') && document.querySelector('[data-history-round="${count-1}"]')`), "Showing all must retain the oldest and newest rounds.");
      observations.push(observation);
      window.destroy();
      window = undefined;
    }
    console.log(JSON.stringify({
      platform: process.platform, electron: process.versions.electron,
      note: "Synthetic offline history, visible window, software rendering, one renderer per size; input includes two animation frames. Observations are not device latency or a release threshold.",
      observations,
    }, null, 2));
    app.exit(0);
  } catch (error) {
    console.error(error?.stack ?? String(error));
    window?.destroy();
    app.exit(1);
  }
}).catch((error) => { console.error(error?.stack ?? String(error)); app.exit(1); });
