const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { evaluate, waitFor, resizeViewport, settleLayout } = require("./ui-smoke-helpers.cjs");

module.exports = async function historyWindowSmoke(window, screenshotRoot) {
  const taskCalls = await evaluate(window, `window.xiuSmoke.calls().filter(call => /^task:(create|continue|steer)(:|$)/.test(call)).length`);
  const action = async name => evaluate(window, `document.querySelector('[data-history-action="${name}"]').click()`);
  const choose = async key => {
    await evaluate(window, `document.querySelector('[aria-label="前往历史回合"]').click()`);
    await waitFor(window, `document.querySelector('[role="listbox"][aria-label="前往历史回合"]')`, "history round picker");
    await evaluate(window, `document.querySelector('[role="listbox"][aria-label="前往历史回合"]').dispatchEvent(new KeyboardEvent('keydown',{key:'${key}',bubbles:true}))`);
    await waitFor(window, `(() => { const menu=document.querySelector('[role="listbox"][aria-label="前往历史回合"]'); return menu?.querySelector('.highlighted')?.dataset.index === ${key === "Home" ? "'0'" : "String(menu.querySelectorAll('[role=option]').length-1)"}; })()`, "history picker keyboard highlight");
    await evaluate(window, `document.querySelector('[role="listbox"][aria-label="前往历史回合"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  };
  for (const width of [1366, 900]) {
    await resizeViewport(window, width, 768, "history round window viewport");
    await evaluate(window, `window.xiuSmoke.historyStressFixture(500, true)`);
    await waitFor(window, `document.querySelector('.history-row')?.textContent.includes('合成历史 500')`, "large history row");
    await evaluate(window, `document.querySelector('.history-row').click()`);
    await waitFor(window, `document.querySelectorAll('.conversation-round').length===50 && document.querySelector('[data-history-round="499"]')`, "latest fifty historical rounds");
    await waitFor(window, `document.querySelector('[data-history-round="499"] .attachment-tile img')?.complete`, "latest historical attachment");
    await evaluate(window, `(() => { const input=document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'历史浏览中保留的草稿'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    assert(await evaluate(window, `document.querySelector('.history-window-range').textContent.includes('451–500') && !document.querySelector('[data-history-round="0"]')`), "Initial history must identify its range without eagerly mounting older rounds.");
    await evaluate(window, `(() => { const scroll=document.querySelector('.task-scroll'); scroll.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true})); const round=document.querySelector('[data-history-round="450"]'); scroll.scrollTop += round.getBoundingClientRect().top-scroll.getBoundingClientRect().top-document.querySelector('.history-window-controls').offsetHeight-(Number.parseFloat(getComputedStyle(scroll).paddingTop)||0)-8; round.querySelector('.turn-process').open=true; })()`);
    await waitFor(window, `document.querySelector('[data-history-round="450"] .process-row')`, "expanded record before loading older rounds");
    await settleLayout(window);
    const before = await evaluate(window, `document.querySelector('[data-history-round="450"]').getBoundingClientRect().top`);
    await action("earlier");
    await waitFor(window, `document.querySelectorAll('.conversation-round').length===100`, "load earlier batch");
    await settleLayout(window);
    const after = await evaluate(window, `document.querySelector('[data-history-round="450"]').getBoundingClientRect().top`);
    assert(Math.abs(before - after) < 3, `Loading older rounds moved the reading anchor: ${before} -> ${after}`);
    assert(await evaluate(window, `document.querySelector('[data-history-round="450"] .turn-process').open && Boolean(document.querySelector('[data-history-round="450"] .process-row'))`), "Loading earlier records must retain an expanded round.");

    await evaluate(window, `window.xiuSmoke.resolveHistoryMedia()`);
    await waitFor(window, `document.querySelector('.generated-media.ready img')?.complete`, "late media above the reading anchor");
    await settleLayout(window);
    const afterMedia = await evaluate(window, `document.querySelector('[data-history-round="450"]').getBoundingClientRect().top`);
    assert(Math.abs(before - afterMedia) < 3, `Late media moved the reading anchor: ${before} -> ${afterMedia}`);

    await action("latest");
    await waitFor(window, `document.querySelectorAll('.conversation-round').length===50 && !document.querySelector('.generated-media')`, "reset before checking manual scroll intent");
    await evaluate(window, `window.xiuSmoke.delayHistoryMedia()`);
    await action("earlier");
    await waitFor(window, `document.querySelectorAll('.conversation-round').length===100 && document.querySelector('.generated-media.pending')`, "pending media before user scroll intent");
    await settleLayout(window);
    await evaluate(window, `document.querySelector('.task-scroll').dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}))`);
    const manualTop = await evaluate(window, `document.querySelector('.task-scroll').scrollTop`);
    await evaluate(window, `window.xiuSmoke.resolveHistoryMedia()`);
    await waitFor(window, `document.querySelector('.generated-media.ready img')?.complete`, "late media after user scroll intent");
    await settleLayout(window);
    assert(Math.abs(manualTop - await evaluate(window, `document.querySelector('.task-scroll').scrollTop`)) < 3, "An earlier anchor must not take control back after user scroll intent.");

    await choose("Home");
    await waitFor(window, `document.querySelectorAll('.conversation-round').length===50 && document.querySelector('[data-history-round="0"]') && !document.querySelector('[data-history-round="499"]')`, "jump directly to an unmounted oldest round");
    assert(await evaluate(window, `document.activeElement?.getAttribute('aria-label')==='前往历史回合'`), "The keyboard picker must retain focus after loading its target.");
    await waitFor(window, `document.querySelector('[data-history-round="0"] .attachment-tile img')?.complete`, "oldest historical attachment after jumping");
    await waitFor(window, `document.querySelector('.timeline-jump-rail button')`, "navigation rail in the loaded range");
    await evaluate(window, `document.querySelector('.timeline-jump-rail button').click()`);
    await waitFor(window, `document.querySelector('[data-history-round="0"] .event-card').getBoundingClientRect().top >= document.querySelector('.history-window-controls').getBoundingClientRect().bottom-3`, "navigation target remains below the sticky history controls");
    await evaluate(window, `document.querySelector('[data-history-round="0"] .event-task-started .message-copy').click()`);
    await waitFor(window, `window.xiuSmoke.copiedMessage()==='只读检查第 1 个合成模块'`, "copy original historical request");
    await evaluate(window, `document.querySelector('[data-history-round="0"] .event-task-finished .message-copy').click()`);
    await waitFor(window, `window.xiuSmoke.copiedMessage().includes('历史回合 1') && window.xiuSmoke.copiedMessage().includes('| 文件 | 结果 |') && window.xiuSmoke.copiedMessage().endsWith('保留历史内容、运行记录与最终回复。')`, "copy complete original historical response");
    await action("later");
    await waitFor(window, `document.querySelectorAll('.conversation-round').length===100 && document.querySelector('[data-history-round="99"]')`, "load a later batch");
    await action("all");
    await waitFor(window, `document.querySelectorAll('.conversation-round').length===500 && document.querySelector('[data-history-round="0"]') && document.querySelector('[data-history-round="499"]')`, "explicit full history retains all rounds", 20000);
    assert.equal(await evaluate(window, `document.querySelectorAll('.history-round-browser .attachment-tile img').length`), 2, "Both ends' saved attachments remain available when showing all history.");
    await choose("Home");
    await waitFor(window, `document.querySelectorAll('.conversation-round').length===50 && document.querySelector('[data-history-round="0"]')`, "return to a bounded older window");
    await evaluate(window, `document.querySelector('.return-to-latest').click()`);
    await waitFor(window, `document.querySelectorAll('.conversation-round').length===50 && document.querySelector('[data-history-round="499"]') && !document.querySelector('[data-history-round="0"]')`, "global return-to-latest restores the actual latest window");
    await settleLayout(window);
    assert(await evaluate(window, `(() => { const scroll=document.querySelector('.task-scroll'); return scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<3 && !document.querySelector('.return-to-latest'); })()`), "Returning to latest must reach the end and resume following.");
    assert(await evaluate(window, `document.querySelector('.task-scroll').scrollWidth<=document.querySelector('.task-scroll').clientWidth`), "History controls must fit the viewport.");
    assert(await evaluate(window, `document.querySelector('.composer textarea').value==='历史浏览中保留的草稿'`), "History navigation must preserve the current unsent draft.");
    await fs.writeFile(path.join(screenshotRoot, `history-window-${width}.png`), (await window.webContents.capturePage()).toPNG());
    await evaluate(window, `window.xiuSmoke.historyStressFixture(75)`);
    await waitFor(window, `document.querySelector('.history-row').textContent.includes('合成历史 75')`, "different conversation");
    await evaluate(window, `document.querySelector('.history-row').click()`);
    await waitFor(window, `document.querySelectorAll('.conversation-round').length===50 && document.querySelector('[data-history-round="74"]') && !document.querySelector('[data-history-round="0"]')`, "a different conversation resets its own window");
  }
  assert.equal(await evaluate(window, `window.xiuSmoke.calls().filter(call => /^task:(create|continue|steer)(:|$)/.test(call)).length`), taskCalls, "Browsing history must not start or continue an agent task.");
};
