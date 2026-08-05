import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import iconv from "iconv-lite";
import { backgroundProcessOutput, listBackgroundProcesses, startBackgroundProcess, stopBackgroundProcess } from "./background.js";
import type { AgentTool, ToolContext, ToolRisk } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 60_000;

function stringArg(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !value.length) throw new Error(`${name} must be a non-empty string`);
  return value;
}

export function resolveWorkspacePath(cwd: string, requested: string): string {
  const root = path.resolve(cwd);
  const target = path.resolve(root, requested);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${requested}`);
  }
  return target;
}

function truncate(value: string): string {
  return value.length <= MAX_OUTPUT ? value : `${value.slice(0, MAX_OUTPUT)}\n... [output truncated]`;
}

async function windowsConsoleEncoding(): Promise<string> {
  try {
    const result = await execFileAsync("chcp.com", [], { encoding: "utf8", windowsHide: true });
    const codePage = result.stdout.match(/\d+/)?.[0];
    const encoding = codePage === "65001" ? "utf8" : codePage ? `cp${codePage}` : "utf8";
    return iconv.encodingExists(encoding) ? encoding : "utf8";
  } catch {
    return "utf8";
  }
}

function decodeOutput(value: string | Buffer | undefined, encoding: string): string {
  if (value === undefined) return "";
  if (!Buffer.isBuffer(value)) return value;
  const utf8 = value.toString("utf8");
  if (!utf8.includes("\uFFFD") && Buffer.from(utf8, "utf8").equals(value)) return utf8;
  return iconv.decode(value, encoding);
}

function unquotedText(value: string): string {
  let quote: "'" | '"' | undefined;
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      if (character === "`" && index + 1 < value.length) index++;
      else if (character === quote) quote = undefined;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else {
      result += character;
    }
  }
  return result;
}

export function classifyCommand(command: string): ToolRisk {
  const shell = unquotedText(command).trim();
  const dangerous = /(^|[;|]\s*)(remove-item\b|del\s+|erase\s+|rd\s+|rmdir\s+|rm\s+)|git\s+(reset\s+--hard|clean\s+-[^\r\n]*f)|\b(format|shutdown|restart-computer|stop-computer)\b/i;
  if (dangerous.test(shell)) return "dangerous";
  const readOnly = [
    /^git\s+(status|log|diff|show|rev-parse|branch\s+--list)\b/i,
    /^(node|npm|python|py|git)\s+--version\b/i,
    /^(get-content|get-childitem|test-path|select-string|get-filehash|measure-object)\b/i,
  ];
  return readOnly.some((pattern) => pattern.test(shell)) ? "read" : "execute";
}

function looksLikeVerification(command: string): boolean {
  return /(^|\s)(test|tests|lint|check|typecheck|build|verify)(\s|$|:)/i.test(command)
    || /\b(tsc\b|pytest\b|vitest\b|jest\b|eslint\b|cargo\s+test\b|go\s+test\b)/i.test(command);
}

function patchArray(input: Record<string, unknown>): Array<{ old_text: string; new_text: string }> {
  if (!Array.isArray(input.patches) || input.patches.length === 0) throw new Error("patches must be a non-empty array");
  return input.patches.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`patches[${index}] must be an object`);
    const patch = item as Record<string, unknown>;
    if (typeof patch.old_text !== "string" || patch.old_text.length === 0) throw new Error(`patches[${index}].old_text must be non-empty`);
    if (typeof patch.new_text !== "string") throw new Error(`patches[${index}].new_text must be a string`);
    return { old_text: patch.old_text, new_text: patch.new_text };
  });
}

function applyExactPatches(content: string, patches: Array<{ old_text: string; new_text: string }>): string {
  let updated = content;
  for (const [index, patch] of patches.entries()) {
    const first = updated.indexOf(patch.old_text);
    if (first < 0) throw new Error(`patches[${index}].old_text was not found`);
    if (updated.indexOf(patch.old_text, first + patch.old_text.length) >= 0) {
      throw new Error(`patches[${index}].old_text is not unique; provide more context`);
    }
    updated = updated.slice(0, first) + patch.new_text + updated.slice(first + patch.old_text.length);
  }
  return updated;
}

function patchPreview(file: string, patches: Array<{ old_text: string; new_text: string }>): string {
  const sections = patches.map((patch, index) => {
    const removed = patch.old_text.split(/\r?\n/).map((line) => `- ${line}`).join("\n");
    const added = patch.new_text.split(/\r?\n/).map((line) => `+ ${line}`).join("\n");
    return `@@ change ${index + 1} @@\n${removed}\n${added}`;
  });
  return truncate(`--- ${file}\n+++ ${file}\n${sections.join("\n")}`);
}

export const builtinTools: AgentTool[] = [
  {
    name: "list_files",
    risk: "read",
    description: "List workspace files matching a glob. Ignores common generated directories.",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string", description: "Glob such as **/*.ts" } },
      required: ["pattern"], additionalProperties: false,
    },
    describe: (input) => `list files matching ${String(input.pattern)}`,
    async execute(input, context) {
      const pattern = stringArg(input, "pattern");
      if (path.isAbsolute(pattern) || pattern.includes("..")) throw new Error("Glob must stay inside workspace");
      const files = await fg(pattern, {
        cwd: context.cwd,
        onlyFiles: true,
        dot: true,
        unique: true,
        ignore: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/.xiu/**"],
      });
      return files.sort().slice(0, 1000).join("\n") || "No matching files.";
    },
  },
  {
    name: "read_file",
    risk: "read",
    description: "Read a UTF-8 text file, optionally selecting an inclusive line range.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
      },
      required: ["path"], additionalProperties: false,
    },
    describe: (input) => `read ${String(input.path)}`,
    async execute(input, context) {
      const target = resolveWorkspacePath(context.cwd, stringArg(input, "path"));
      const content = await fs.readFile(target, "utf8");
      const lines = content.split(/\r?\n/);
      const start = typeof input.start_line === "number" ? Math.max(1, input.start_line) : 1;
      const end = typeof input.end_line === "number" ? Math.min(lines.length, input.end_line) : lines.length;
      return truncate(lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n"));
    },
  },
  {
    name: "search_text",
    risk: "read",
    description: "Search text in workspace files with a regular expression.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        pattern: { type: "string", description: "Optional file glob, defaults to **/*" },
      },
      required: ["query"], additionalProperties: false,
    },
    describe: (input) => `search for ${String(input.query)}`,
    async execute(input, context) {
      const query = stringArg(input, "query");
      const pattern = typeof input.pattern === "string" ? input.pattern : "**/*";
      let regex: RegExp;
      try { regex = new RegExp(query, "i"); } catch { throw new Error("query must be a valid regular expression"); }
      const files = await fg(pattern, { cwd: context.cwd, onlyFiles: true, dot: true, ignore: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/.xiu/**"] });
      const matches: string[] = [];
      for (const file of files.slice(0, 3000)) {
        let content: string;
        try { content = await fs.readFile(path.join(context.cwd, file), "utf8"); } catch { continue; }
        for (const [index, line] of content.split(/\r?\n/).entries()) {
          if (regex.test(line)) matches.push(`${file}:${index + 1}:${line}`);
          regex.lastIndex = 0;
          if (matches.length >= 500) return truncate(matches.join("\n") + "\n... [match limit reached]");
        }
      }
      return matches.join("\n") || "No matches.";
    },
  },
  {
    name: "write_file",
    risk: "write",
    changesWorkspace: true,
    description: "Create or fully overwrite a UTF-8 file. Parent directories are created automatically.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"], additionalProperties: false,
    },
    describe: (input) => `write ${String(input.path)}`,
    async execute(input, context) {
      const target = resolveWorkspacePath(context.cwd, stringArg(input, "path"));
      if (typeof input.content !== "string") throw new Error("content must be a string");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, input.content, "utf8");
      return `Wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${path.relative(context.cwd, target)}`;
    },
  },
  {
    name: "replace_text",
    risk: "write",
    changesWorkspace: true,
    description: "Replace one exact, unique text block in a UTF-8 file. Safer than overwriting an existing file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
      required: ["path", "old_text", "new_text"], additionalProperties: false,
    },
    describe: (input) => `edit ${String(input.path)}`,
    async execute(input, context) {
      const target = resolveWorkspacePath(context.cwd, stringArg(input, "path"));
      const oldText = stringArg(input, "old_text");
      if (typeof input.new_text !== "string") throw new Error("new_text must be a string");
      const content = await fs.readFile(target, "utf8");
      const first = content.indexOf(oldText);
      if (first < 0) throw new Error("old_text was not found");
      if (content.indexOf(oldText, first + oldText.length) >= 0) throw new Error("old_text is not unique; provide more context");
      await fs.writeFile(target, content.slice(0, first) + input.new_text + content.slice(first + oldText.length), "utf8");
      return `Updated ${path.relative(context.cwd, target)}`;
    },
  },
  {
    name: "apply_patch",
    description: "Apply one or more exact, unique replacements to a file atomically. A structured diff preview is shown before approval.",
    risk: "write",
    changesWorkspace: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        patches: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: { old_text: { type: "string" }, new_text: { type: "string" } },
            required: ["old_text", "new_text"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "patches"],
      additionalProperties: false,
    },
    describe: (input) => `patch ${String(input.path)}`,
    validate(input) { patchArray(input); },
    async preview(input, context) {
      const file = stringArg(input, "path");
      const content = await fs.readFile(resolveWorkspacePath(context.cwd, file), "utf8");
      const patches = patchArray(input);
      applyExactPatches(content, patches);
      return patchPreview(file, patches);
    },
    async execute(input, context) {
      const target = resolveWorkspacePath(context.cwd, stringArg(input, "path"));
      const content = await fs.readFile(target, "utf8");
      const updated = applyExactPatches(content, patchArray(input));
      await fs.writeFile(target, updated, "utf8");
      return `Applied ${patchArray(input).length} change(s) to ${path.relative(context.cwd, target)}`;
    },
  },
  {
    name: "run_command",
    risk: (input) => classifyCommand(stringArg(input, "command")),
    changesWorkspace: (input) => classifyCommand(stringArg(input, "command")) !== "read",
    description: process.platform === "win32"
      ? "Run a Windows PowerShell 5.1 command in the workspace. Do not use Bash syntax such as &&, ||, or /dev/null. Use for tests, builds, Git, and project tooling. Requires approval unless --yes is active."
      : "Run a POSIX shell command in the workspace. Use for tests, builds, Git, and project tooling. Requires approval unless --yes is active.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
      },
      required: ["command"], additionalProperties: false,
    },
    describe: (input) => `run: ${String(input.command)}`,
    isVerification: (input, result) => looksLikeVerification(String(input.command)) && /^Exit code: 0\b/.test(result),
    validate(input) {
      const command = stringArg(input, "command");
      if (process.platform === "win32" && (/&&|\|\||\/dev\/null/.test(unquotedText(command)))) {
        throw new Error("This runtime uses Windows PowerShell 5.1. Retry without Bash operators (&& or ||) and /dev/null; the command already starts in the workspace.");
      }
    },
    async execute(input, context) {
      const command = stringArg(input, "command");
      const timeout = typeof input.timeout_ms === "number" ? input.timeout_ms : 120_000;
      const isWindows = process.platform === "win32";
      const executable = isWindows ? "powershell.exe" : "/bin/sh";
      const args = isWindows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-lc", command];
      const outputEncoding = isWindows ? await windowsConsoleEncoding() : "utf8";
      try {
        const result = await execFileAsync(executable, args, { cwd: context.cwd, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: "buffer", signal: context.signal });
        const stdout = decodeOutput(result.stdout, outputEncoding);
        const stderr = decodeOutput(result.stderr, outputEncoding);
        return truncate(`Exit code: 0\n${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim());
      } catch (error) {
        const failure = error as Error & { code?: string | number; stdout?: string | Buffer; stderr?: string | Buffer; killed?: boolean };
        const stdout = decodeOutput(failure.stdout, outputEncoding);
        const stderr = decodeOutput(failure.stderr, outputEncoding);
        if (context.signal?.aborted) return "Command cancelled by user.";
        if (failure.killed) return truncate(`Command timed out after ${timeout}ms.\n${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim());
        return truncate(`Exit code: ${failure.code ?? "failed"}\n${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim());
      }
    },
  },
  {
    name: "project_info",
    description: "Detect the project type, package scripts, and common verification commands without executing project code.",
    risk: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    describe: () => "detect project type and checks",
    async execute(_input, context) {
      const markers = ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle"];
      const present: string[] = [];
      for (const marker of markers) {
        try { await fs.access(path.join(context.cwd, marker)); present.push(marker); } catch { /* absent */ }
      }
      const info: Record<string, unknown> = { markers: present, suggested_checks: [] as string[] };
      if (present.includes("package.json")) {
        try {
          const pkg = JSON.parse(await fs.readFile(path.join(context.cwd, "package.json"), "utf8")) as { name?: string; scripts?: Record<string, string> };
          info.name = pkg.name;
          info.scripts = pkg.scripts ?? {};
          info.suggested_checks = ["typecheck", "lint", "test", "build"].filter((name) => Boolean(pkg.scripts?.[name]));
        } catch (error) {
          info.package_error = (error as Error).message;
        }
      }
      return JSON.stringify(info, null, 2);
    },
  },
  {
    name: "start_background_command",
    description: "Start a long-running command such as a development server under Xiu session management. It is stopped when Xiu exits.",
    risk: (input) => classifyCommand(stringArg(input, "command")) === "dangerous" ? "dangerous" : "execute",
    changesWorkspace: (input) => classifyCommand(stringArg(input, "command")) !== "read",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    describe: (input) => `start in background: ${String(input.command)}`,
    async execute(input, context) {
      const started = startBackgroundProcess(stringArg(input, "command"), context.cwd);
      return `Background process ${started.id} started (PID ${started.pid ?? "unknown"}).`;
    },
  },
  {
    name: "list_background_commands",
    description: "List commands running in the background during this Xiu session.",
    risk: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    describe: () => "list background commands",
    async execute() {
      const running = listBackgroundProcesses();
      return running.length ? JSON.stringify(running, null, 2) : "No background commands.";
    },
  },
  {
    name: "read_background_output",
    description: "Read recent output from a managed background command.",
    risk: "read",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    describe: (input) => `read background output ${String(input.id)}`,
    async execute(input) { return truncate(backgroundProcessOutput(stringArg(input, "id"))); },
  },
  {
    name: "stop_background_command",
    description: "Stop a command previously started and tracked by Xiu.",
    risk: "execute",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    describe: (input) => `stop background command ${String(input.id)}`,
    async execute(input) {
      const id = stringArg(input, "id");
      await stopBackgroundProcess(id);
      return `Background process ${id} stopped.`;
    },
  },
  {
    name: "git_status",
    description: "Show concise Git repository and working-tree status without invoking a shell.",
    risk: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    describe: () => "inspect git status",
    async execute(_input, context) {
      try {
        const result = await execFileAsync("git", ["status", "--short", "--branch"], { cwd: context.cwd, timeout: 30_000, windowsHide: true, encoding: "utf8", signal: context.signal });
        return result.stdout.trim() || "Git working tree is clean.";
      } catch {
        return "Not a Git repository or Git is unavailable.";
      }
    },
  },
  {
    name: "git_log",
    description: "Read recent Git commit history without invoking a shell.",
    risk: "read",
    inputSchema: {
      type: "object",
      properties: { count: { type: "integer", minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
    describe: () => "read recent git history",
    async execute(input, context) {
      const count = typeof input.count === "number" ? Math.min(50, Math.max(1, input.count)) : 10;
      try {
        const result = await execFileAsync("git", ["log", `-${count}`, "--oneline", "--decorate"], { cwd: context.cwd, timeout: 30_000, windowsHide: true, encoding: "utf8", signal: context.signal });
        return result.stdout.trim() || "No commits.";
      } catch {
        return "No Git history is available.";
      }
    },
  },
  {
    name: "validate_project",
    description: "Run a named npm verification script (typecheck, lint, test, or build) directly, without shell composition.",
    risk: "execute",
    inputSchema: {
      type: "object",
      properties: {
        check: { type: "string", enum: ["typecheck", "lint", "test", "build"] },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
      },
      required: ["check"],
      additionalProperties: false,
    },
    describe: (input) => `run project ${String(input.check)}`,
    isVerification: (_input, result) => /^Exit code: 0\b/.test(result),
    async execute(input, context) {
      const check = stringArg(input, "check");
      const packageFile = path.join(context.cwd, "package.json");
      const pkg = JSON.parse(await fs.readFile(packageFile, "utf8")) as { scripts?: Record<string, string> };
      if (!pkg.scripts?.[check]) return `Verification unavailable: package.json has no ${check} script.`;
      const executable = process.platform === "win32" ? "npm.cmd" : "npm";
      const timeout = typeof input.timeout_ms === "number" ? input.timeout_ms : 120_000;
      const outputEncoding = process.platform === "win32" ? await windowsConsoleEncoding() : "utf8";
      try {
        const result = await execFileAsync(executable, ["run", check], { cwd: context.cwd, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: "buffer", signal: context.signal });
        return truncate(`Exit code: 0\n${decodeOutput(result.stdout, outputEncoding)}${result.stderr.length ? `\nSTDERR:\n${decodeOutput(result.stderr, outputEncoding)}` : ""}`.trim());
      } catch (error) {
        const failure = error as Error & { code?: string | number; stdout?: string | Buffer; stderr?: string | Buffer; killed?: boolean };
        if (context.signal?.aborted) return "Verification cancelled by user.";
        if (failure.killed) return `Verification timed out after ${timeout}ms.`;
        return truncate(`Exit code: ${failure.code ?? "failed"}\n${decodeOutput(failure.stdout, outputEncoding)}${failure.stderr ? `\nSTDERR:\n${decodeOutput(failure.stderr, outputEncoding)}` : ""}`.trim());
      }
    },
  },
  {
    name: "git_diff",
    risk: "read",
    description: "Show the current Git working-tree diff. This is read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    describe: () => "inspect git diff",
    async execute(_input, context) {
      try {
        const result = await execFileAsync("git", ["diff", "--", "."], { cwd: context.cwd, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, signal: context.signal });
        return truncate(result.stdout || "No tracked changes. Note: untracked files are not shown.");
      } catch (error) {
        return `Unable to read Git diff: ${(error as Error).message}`;
      }
    },
  },
];

export async function executeTool(tool: AgentTool, input: Record<string, unknown>, context: ToolContext): Promise<string> {
  try { tool.validate?.(input); }
  catch (error) { return `Tool error: ${error instanceof Error ? error.message : String(error)}`; }
  const risk = typeof tool.risk === "function" ? tool.risk(input) : tool.risk;
  if (risk !== "read") {
    let preview: string | undefined;
    try { preview = await tool.preview?.(input, context); }
    catch (error) { return `Tool error: ${error instanceof Error ? error.message : String(error)}`; }
    if (!(await context.approve({ description: tool.describe(input), risk, preview }))) return "Tool execution denied by user.";
  }
  try { return await tool.execute(input, context); }
  catch (error) { return `Tool error: ${error instanceof Error ? error.message : String(error)}`; }
}
