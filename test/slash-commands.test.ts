import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { detectUnknownSlashCommand, formatUnknownSlashCommand, knownSlashCommandWords, SLASH_COMMAND_ALIASES, slashCommands } from "../src/slash-commands.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const noPath = { pathExists: () => false };

test("a lone mistyped slash word is an unknown command with the closest listed commands first", () => {
  assert.deepEqual(detectUnknownSlashCommand("/skils", noPath), { word: "/skils", suggestions: ["/skills"] });
  assert.deepEqual(detectUnknownSlashCommand("/hepl", noPath)?.suggestions, ["/help"]);
  assert.deepEqual(detectUnknownSlashCommand("/Help", noPath)?.suggestions, ["/help"]);
  assert.deepEqual(detectUnknownSlashCommand("/cancle", noPath)?.suggestions, ["/cancel"]);
  assert.deepEqual(detectUnknownSlashCommand("  /porvider add  ", noPath)?.suggestions, ["/provider", "/providers"]);
  assert.deepEqual(detectUnknownSlashCommand("/clearqueue", noPath)?.suggestions, ["/clear", "/clear-queue"]);
  assert.deepEqual(detectUnknownSlashCommand("/zzzz", noPath), { word: "/zzzz", suggestions: [] });
  // Aliases are accepted but never suggested: the listed command is.
  assert.deepEqual(detectUnknownSlashCommand("/exti", noPath)?.suggestions, ["/exit"]);
  assert.ok(detectUnknownSlashCommand("/quti", noPath)!.suggestions.every((suggestion) => !SLASH_COMMAND_ALIASES.includes(suggestion)));
});

test("accepted commands, task text and paths are not unknown commands", () => {
  for (const input of ["/skills", "/mcp lsit", "/provider fallback add", "/quit", "/model gpt", "fix the failing test", "", "/", "/etc/hosts explain", "/a.b", "/1abc", "x /help"]) {
    assert.equal(detectUnknownSlashCommand(input, noPath), undefined, JSON.stringify(input));
  }
  // A slash word that names an existing path is a task about that path, not a typo.
  assert.equal(detectUnknownSlashCommand("/tmp what is in here", { pathExists: (word) => word === "/tmp" }), undefined);
  assert.ok(detectUnknownSlashCommand("/tmp what is in here", noPath));
  // The real probe is used when none is given, and it never throws on odd input.
  assert.ok(detectUnknownSlashCommand("/surely-not-a-path-xyz"));
});

test("the unknown-command message names the word, the guesses and that nothing reached the model", () => {
  const typo = detectUnknownSlashCommand("/skils", noPath)!;
  assert.equal(formatUnknownSlashCommand(typo, "zh-CN"), "未知命令 /skils。你是想输入 /skills 吗？输入 /help 查看全部命令。这一行没有发送给模型；如果它是任务内容，请不要以斜杠开头。");
  assert.equal(formatUnknownSlashCommand(typo, "en-US"), "Unknown command /skils. Did you mean /skills? Type /help for the full list. This line was not sent to the model; if it is task text, do not start it with a slash.");
  const none = detectUnknownSlashCommand("/zzzz", noPath)!;
  assert.equal(formatUnknownSlashCommand(none, "en-US"), "Unknown command /zzzz. Type /help for the full list. This line was not sent to the model; if it is task text, do not start it with a slash.");
  assert.match(formatUnknownSlashCommand(detectUnknownSlashCommand("/clearqueue", noPath)!, "zh-CN"), /你是想输入 \/clear、\/clear-queue 吗？/);
});

test("the help list is unique, translated, and every command the loop dispatches on is listed or an alias", async () => {
  const zh = slashCommands("zh-CN");
  const en = slashCommands("en-US");
  assert.equal(new Set(zh.map((command) => command.name)).size, zh.length, "duplicate help entries");
  assert.deepEqual(zh.map((command) => command.name), en.map((command) => command.name));
  for (const [index, command] of zh.entries()) {
    assert.match(command.name, /^\/[a-z][a-z-]*( [a-z][a-z:-]*)*$/, command.name);
    assert.notEqual(command.description, en[index]!.description, `${command.name} has one description for both languages`);
  }
  const known = knownSlashCommandWords();
  const files = [path.join(root, "src", "cli.ts"), ...(await fs.readdir(path.join(root, "src", "commands"))).map((name) => path.join(root, "src", "commands", name))];
  const dispatched = new Set<string>();
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    for (const match of source.matchAll(/(?:===|!==|startsWith\()\s*"(\/[a-z][a-z-]*)/g)) dispatched.add(match[1]!);
    for (const match of source.matchAll(/\^\\\/\(?([a-z|-]+)\)?/g)) for (const word of match[1]!.split("|")) dispatched.add(`/${word}`);
  }
  assert.ok(dispatched.size >= 35, `only ${dispatched.size} dispatched words found; the scan is broken`);
  const unlisted = [...dispatched].filter((word) => !known.has(word)).sort();
  assert.deepEqual(unlisted, [], "slash commands the loop handles but /help does not list");
});

test("every listed command is documented in the Chinese guides", async () => {
  const guides = (await fs.readdir(path.join(root, "docs", "guide"))).filter((name) => name.endsWith(".zh-CN.md")).map((name) => path.join(root, "docs", "guide", name));
  const text = (await Promise.all([...guides, path.join(root, "README.zh-CN.md"), path.join(root, "QUICKSTART.md")].map((file) => fs.readFile(file, "utf8")))).join("\n");
  const undocumented = slashCommands("zh-CN").map((command) => command.name).filter((name) => !new RegExp(`(?<![\\w/])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(text));
  assert.deepEqual(undocumented, [], "commands /help lists that no guide mentions");
});
