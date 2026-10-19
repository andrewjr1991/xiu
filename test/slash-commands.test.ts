import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RUNNING_TASK_COMMAND_WORDS } from "../src/commands/running-task-commands.js";
import { explainOneShotSlashInput, explainScriptCommandTypo, explainUnhandledSlashInput, formatScriptCommandTypo, formatOneShotSlashProblem, formatHelpEntries, formatSlashInputProblem, helpEntriesFor, knownSlashCommandWords, SLASH_COMMAND_ALIASES, slashCommands } from "../src/slash-commands.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const noPath = { pathExists: () => false };
const running = { ...noPath, runningCommandWords: RUNNING_TASK_COMMAND_WORDS };
const suggestionsOf = (input: string, options = noPath) => {
  const problem = explainUnhandledSlashInput(input, options);
  assert.ok(problem && problem.kind !== "unavailable-while-running", input);
  return problem.suggestions;
};

test("a lone mistyped slash word is an unknown command with the closest listed commands first", () => {
  assert.deepEqual(explainUnhandledSlashInput("/skils", noPath), { kind: "unknown-command", word: "/skils", suggestions: ["/skills"] });
  assert.deepEqual(suggestionsOf("/hepl"), ["/help"]);
  assert.deepEqual(suggestionsOf("/Help"), ["/help"]);
  assert.deepEqual(suggestionsOf("/cancle"), ["/cancel"]);
  assert.deepEqual(suggestionsOf("  /porvider add  "), ["/provider", "/providers"]);
  assert.deepEqual(suggestionsOf("/clearqueue"), ["/clear", "/clear-queue"]);
  assert.deepEqual(explainUnhandledSlashInput("/zzzz", noPath), { kind: "unknown-command", word: "/zzzz", suggestions: [] });
  // Aliases are accepted but never suggested: the listed command is.
  assert.deepEqual(suggestionsOf("/exti"), ["/exit"]);
  assert.ok(suggestionsOf("/quti").every((suggestion) => !SLASH_COMMAND_ALIASES.includes(suggestion)));
});

test("a known command word whose handler declined the rest is an unknown usage with that command's usages", () => {
  const typo = explainUnhandledSlashInput("/mcp  premissions ", noPath);
  assert.equal(typo?.kind, "unknown-usage");
  assert.equal(typo?.kind === "unknown-usage" && typo.input, "/mcp premissions");
  assert.deepEqual(suggestionsOf("/mcp premissions"), ["/mcp permissions"]);
  assert.ok(typo?.kind === "unknown-usage" && typo.usage.includes("/mcp") && typo.usage.includes("/mcp reload") && !typo.usage.includes("/plugins"));
  assert.deepEqual(explainUnhandledSlashInput("/plan onn", noPath), { kind: "unknown-usage", word: "/plan", input: "/plan onn", usage: ["/plan", "/plan on", "/plan off"], suggestions: ["/plan on"] });
  assert.deepEqual(suggestionsOf("/web proxy sett"), ["/web proxy set", "/web proxy"]);
  assert.deepEqual(suggestionsOf("/provider fallbck add"), ["/provider fallback add", "/provider fallback"]);
  assert.deepEqual(suggestionsOf("/history bogus"), []);
  // An alias lists what it stands for.
  assert.deepEqual(explainUnhandledSlashInput("/quit now", noPath), { kind: "unknown-usage", word: "/quit", input: "/quit now", usage: ["/exit"], suggestions: [] });
  // Long task text after a command word is shortened in the message, not in what is sent anywhere (nothing is).
  const long = explainUnhandledSlashInput(`/mcp ${"x".repeat(80)}`, noPath);
  assert.ok(long?.kind === "unknown-usage" && long.input.length === 60 && long.input.endsWith("..."));
});

test("while a task runs, a listed command the steer> prompt does not accept is unavailable rather than steering", () => {
  const problem = explainUnhandledSlashInput("/mcp", running);
  assert.equal(problem?.kind, "unavailable-while-running");
  assert.ok(problem?.kind === "unavailable-while-running" && problem.available.includes("/cancel") && problem.available.includes("/queue") && !problem.available.includes("/quit"));
  assert.equal(explainUnhandledSlashInput("/plan on", running)?.kind, "unavailable-while-running");
  // Words the prompt does accept keep their usage explanation; unknown words stay unknown commands.
  assert.equal(explainUnhandledSlashInput("/credentials bogus", running)?.kind, "unknown-usage");
  assert.equal(explainUnhandledSlashInput("/skils", running)?.kind, "unknown-command");
  assert.equal(explainUnhandledSlashInput("fix the failing test", running), undefined);
});

test("task text and paths are not slash-command problems", () => {
  for (const input of ["fix the failing test", "", "/", "/etc/hosts explain", "/a.b", "/1abc", "x /help"]) {
    assert.equal(explainUnhandledSlashInput(input, noPath), undefined, JSON.stringify(input));
  }
  // A slash word that names an existing path is a task about that path, not a typo.
  assert.equal(explainUnhandledSlashInput("/tmp what is in here", { pathExists: (word) => word === "/tmp" }), undefined);
  assert.ok(explainUnhandledSlashInput("/tmp what is in here", noPath));
  // The real probe is used when none is given, and it never throws on odd input.
  assert.ok(explainUnhandledSlashInput("/surely-not-a-path-xyz"));
});

test("the messages name the word, the guesses or usages, and that nothing reached the model", () => {
  const typo = explainUnhandledSlashInput("/skils", noPath)!;
  assert.equal(formatSlashInputProblem(typo, "zh-CN"), "未知命令 /skils。你是想输入 /skills 吗？输入 /help 查看全部命令。这一行没有发送给模型；如果它是任务内容，请不要以斜杠开头。");
  assert.equal(formatSlashInputProblem(typo, "en-US"), "Unknown command /skils. Did you mean /skills? Type /help for the full list. This line was not sent to the model; if it is task text, do not start it with a slash.");
  assert.equal(formatSlashInputProblem(explainUnhandledSlashInput("/zzzz", noPath)!, "en-US"), "Unknown command /zzzz. Type /help for the full list. This line was not sent to the model; if it is task text, do not start it with a slash.");
  assert.match(formatSlashInputProblem(explainUnhandledSlashInput("/clearqueue", noPath)!, "zh-CN"), /你是想输入 \/clear、\/clear-queue 吗？/);
  assert.equal(formatSlashInputProblem(explainUnhandledSlashInput("/plan onn", noPath)!, "zh-CN"), "/plan 没有「/plan onn」这种用法。你是想输入 /plan on 吗？可用：/plan、/plan on、/plan off；输入 /help plan 查看说明。这一行没有发送给模型；如果它是任务内容，请不要以斜杠开头。");
  assert.equal(formatSlashInputProblem(explainUnhandledSlashInput("/plan onn", noPath)!, "en-US"), "/plan has no usage \"/plan onn\". Did you mean /plan on? Available: /plan, /plan on, /plan off; type /help plan for details. This line was not sent to the model; if it is task text, do not start it with a slash.");
  assert.match(formatSlashInputProblem(explainUnhandledSlashInput("/mcp", running)!, "zh-CN"), /^\/mcp 在任务运行时不可用，等任务结束后再用。运行中可用：\/cancel、\/exit、\/queue、.*\/language。这一行没有发送给模型，也没有作为补充。$/);
  assert.match(formatSlashInputProblem(explainUnhandledSlashInput("/mcp", running)!, "en-US"), /^\/mcp is not available while a task runs; use it after the task ends\. Available now: \/cancel, \/exit, .*\. This line was not sent to the model or added as steering\.$/);
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

test("the steer> prompt's command words are listed commands and cover every word its handler dispatches on", async () => {
  const known = knownSlashCommandWords();
  assert.deepEqual([...RUNNING_TASK_COMMAND_WORDS].filter((word) => !known.has(word)), []);
  for (const word of ["/cancel", "/exit", "/quit"]) assert.ok(RUNNING_TASK_COMMAND_WORDS.has(word), `${word} ends the running-task loop in cli.ts`);
  const source = await fs.readFile(path.join(root, "src", "commands", "running-task-commands.ts"), "utf8");
  const dispatched = new Set([...source.matchAll(/(?:===|startsWith\()\s*"(\/[a-z][a-z-]*)/g)].map((match) => match[1]!));
  assert.ok(dispatched.size >= 10, `only ${dispatched.size} dispatched words found; the scan is broken`);
  assert.deepEqual([...dispatched].filter((word) => !RUNNING_TASK_COMMAND_WORDS.has(word)), [], "words handled at steer> but missing from RUNNING_TASK_COMMAND_WORDS");
});

test("every listed command is documented in the Chinese guides", async () => {
  const guides = (await fs.readdir(path.join(root, "docs", "guide"))).filter((name) => name.endsWith(".zh-CN.md")).map((name) => path.join(root, "docs", "guide", name));
  const text = (await Promise.all([...guides, path.join(root, "README.zh-CN.md"), path.join(root, "QUICKSTART.md")].map((file) => fs.readFile(file, "utf8")))).join("\n");
  const undocumented = slashCommands("zh-CN").map((command) => command.name).filter((name) => !new RegExp(`(?<![\\w/])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(text));
  assert.deepEqual(undocumented, [], "commands /help lists that no guide mentions");
});

test("/help narrows to one command's entries by word, by full prefix, through an alias, and to nothing for an unknown word", () => {
  const names = (topic: string) => helpEntriesFor(topic, "en-US").map((command) => command.name);
  assert.deepEqual(names("plan"), ["/plan", "/plan on", "/plan off"]);
  assert.deepEqual(names("/plan"), names("plan"));
  assert.deepEqual(names("MCP login"), ["/mcp login"]);
  assert.deepEqual(names("mcp lgin"), names("mcp"), "an unmatched second word falls back to the command's full list");
  assert.deepEqual(names("quit"), ["/exit"]);
  assert.deepEqual(names("zzz"), []);
  assert.deepEqual(names("  "), slashCommands("en-US").map((command) => command.name));
  assert.equal(helpEntriesFor("plan", "zh-CN")[1]!.description, "开启只读 Plan 模式");
});

test("a one-shot task that is a slash command does not start, and names the script form where one exists", () => {
  assert.deepEqual(explainOneShotSlashInput("/doctor json", noPath), { word: "/doctor", known: true, equivalent: "xiu doctor [json]", suggestions: [] });
  assert.deepEqual(explainOneShotSlashInput("/help", noPath), { word: "/help", known: true, equivalent: undefined, suggestions: [] });
  assert.equal(explainOneShotSlashInput("/quit", noPath)?.known, true);
  assert.deepEqual(explainOneShotSlashInput("/skils", noPath), { word: "/skils", known: false, suggestions: ["/skills"] });
  for (const task of ["fix the failing test", "/etc/hosts explain", "/a.b", ""]) assert.equal(explainOneShotSlashInput(task, noPath), undefined, task);
  assert.equal(explainOneShotSlashInput("/tmp what is here", { pathExists: (word) => word === "/tmp" }), undefined);
  assert.equal(formatOneShotSlashProblem(explainOneShotSlashInput("/doctor", noPath)!, "zh-CN"), "/doctor 是交互命令，一次性运行（xiu <任务>）不执行斜杠命令：不带任务启动 xiu 进入交互模式后再输入它。脚本里请用 xiu doctor [json]。这次运行没有开始，也没有把它发给模型。");
  assert.equal(formatOneShotSlashProblem(explainOneShotSlashInput("/help", noPath)!, "en-US"), "/help is an interactive command; a one-shot run (xiu <task>) does not run slash commands: start xiu without a task and type it at the prompt. This run did not start and nothing was sent to the model.");
  assert.equal(formatOneShotSlashProblem(explainOneShotSlashInput("/skils", noPath)!, "en-US"), "Unknown command /skils. Did you mean /skills? Slash commands run only at the interactive prompt, and a one-shot run does not send one to the model; if it is task text, do not start it with a slash.");
  assert.match(formatOneShotSlashProblem(explainOneShotSlashInput("/zzzz", noPath)!, "zh-CN"), /^未知命令 \/zzzz。斜杠命令只在交互模式可用/);
});


test("a one-shot task that is a mistyped script command is recognised, task text is not", () => {
  assert.deepEqual(explainScriptCommandTypo("doctr"), { word: "doctr", command: "doctor" });
  assert.deepEqual(explainScriptCommandTypo("Doctor"), { word: "Doctor", command: "doctor" });
  assert.deepEqual(explainScriptCommandTypo("reprot json"), { word: "reprot", command: "report" });
  assert.deepEqual(explainScriptCommandTypo("recovr status"), { word: "recovr", command: "recover" });
  assert.deepEqual(explainScriptCommandTypo("audti approvals JSON"), { word: "audti", command: "audit" });
  assert.deepEqual(explainScriptCommandTypo("reports runs"), { word: "reports", command: "report" });
  for (const task of ["doctor", "report runs", "export json", "edit README", "recovr abandon 1234", "doctr fix the tests", "fix doctr", "doctor.js", "", "   "]) {
    assert.equal(explainScriptCommandTypo(task), undefined, task);
  }
  assert.equal(formatScriptCommandTypo({ word: "doctr", command: "doctor" }, "en-US"),
    "Unknown command doctr. Did you mean xiu doctor? xiu doctor, xiu report, xiu recover and xiu audit run without an interactive session; this run did not start and nothing was sent to the model as a task. If it is task text, write it as a full sentence.");
  assert.equal(formatScriptCommandTypo({ word: "reprot", command: "report" }, "zh-CN"),
    "未知命令 reprot。你是想运行 xiu report 吗？xiu doctor、xiu report、xiu recover、xiu audit 不进入交互模式；这次运行没有开始，也没有把它当作任务发给模型。如果它就是任务内容，请写成完整的一句话。");
});

test("/help lists every description in one column, after the longest listed command", () => {
  const entries = helpEntriesFor("", "en-US");
  const longest = Math.max(...entries.map((command) => command.name.length));
  assert.ok(longest > 20, "some command names are longer than the old fixed 20-column pad");
  const lines = formatHelpEntries(entries).split("\n");
  assert.equal(lines.length, entries.length);
  for (const [index, command] of entries.entries()) {
    assert.equal(lines[index], `${command.name.padEnd(longest)} ${command.description}`, `before: ${command.name} ran into its description when the name was longer than 20 columns`);
  }
  // A topic listing is as narrow as its own longest name allows, but never narrower than the usual 20 columns.
  const mcp = helpEntriesFor("mcp", "en-US");
  const mcpWidth = Math.max(20, ...mcp.map((command) => command.name.length));
  assert.ok(mcpWidth < longest);
  assert.deepEqual(formatHelpEntries(mcp).split("\n"), mcp.map((command) => `${command.name.padEnd(mcpWidth)} ${command.description}`));
  assert.equal(formatHelpEntries([{ name: "/exit", description: "Exit Xiu" }]), `${"/exit".padEnd(20)} Exit Xiu`);
});
