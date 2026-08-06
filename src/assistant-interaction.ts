import { localize, type UiLanguage } from "./i18n.js";

export interface AssistantInteraction {
  text: string;
  question?: string;
}

const REQUIRED_MARKER = /^USER_INPUT_REQUIRED:\s*(.+)$/im;

function lastMeaningfulLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

/** Extract an explicit blocking question so the terminal can enter a visible waiting-for-user state. */
export function parseAssistantInteraction(value: string, language: UiLanguage): AssistantInteraction {
  const marked = REQUIRED_MARKER.exec(value);
  if (marked) {
    const question = marked[1]!.trim();
    let text = value.replace(marked[0], "").trim();
    if (lastMeaningfulLine(text) === question) {
      const lines = text.split(/\r?\n/);
      while (lines.length && !lines.at(-1)?.trim()) lines.pop();
      lines.pop();
      text = lines.join("\n").trim();
    }
    return { text, ...(question ? { question } : {}) };
  }

  const last = lastMeaningfulLine(value);
  if (!/[？?]$/.test(last)) return { text: value.trim() };
  const asksForInput = language === "zh-CN"
    ? /(?:请(?:选择|告诉|确认|提供)|需要(?:你|先).{0,6}确认|无法继续|才能继续|你希望|你选择|^是否|哪(?:个|种)|什么|怎么)/.test(last)
    : /(?:please (?:choose|confirm|provide|tell)|need you to|cannot continue|before i continue|which|what|how)/i.test(last);
  return { text: value.trim(), ...(asksForInput ? { question: last } : {}) };
}

export function continueTaskAfterAnswer(originalTask: string, question: string, answer: string, language: UiLanguage): string {
  return localize(language,
    `继续此前因等待用户回答而暂停的任务。\n\n原始任务：\n${originalTask}\n\nXiu 提出的问题：\n${question}\n\n用户回答：\n${answer}\n\n请根据回答继续完成原始任务，不要把回答本身当成新的独立目标。`,
    `Continue the task that paused for user input.\n\nOriginal task:\n${originalTask}\n\nXiu's question:\n${question}\n\nUser answer:\n${answer}\n\nUse the answer to continue and complete the original task; do not treat the answer as an independent goal.`);
}
