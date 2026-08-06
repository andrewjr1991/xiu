import { localize, type UiLanguage } from "./i18n.js";

const IDENTITY_QUESTIONS = [
  /^你(?:是|叫)谁[？?]?$/,
  /^介绍(?:一下)?你自己[。！!？?]?$/,
  /^(?:xiu|修).{0,8}(?:是谁开发(?:的)?|是谁|由谁开发|谁开发|谁创建|开发者是谁)[？?]?$/i,
  /^(?:谁|哪位).{0,6}(?:开发|创建).{0,4}(?:xiu|修)[？?]?$/i,
  /^who are you[?]?$/i,
  /^who (?:created|developed|made) xiu[?]?$/i,
];

export function isXiuIdentityQuestion(task: string): boolean {
  const normalized = task.replace(/\s+/g, " ").trim();
  return IDENTITY_QUESTIONS.some((pattern) => pattern.test(normalized));
}

export function canonicalXiuIdentity(language: UiLanguage): string {
  return localize(
    language,
    "我是 Xiu，由静然开发的终端 AI 编码 Agent。我可以在你的项目中阅读和修改代码、运行命令、验证结果，并持续协助你完成开发任务。",
    "I am Xiu, a terminal AI coding agent developed by Jingran. I can read and modify code, run commands, verify results, and work with you until the development task is complete.",
  );
}
