import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fg from "./glob.js";
import iconv from "iconv-lite";
import { listBackgroundProcesses, readBackgroundProcessOutput, startBackgroundProcess, stopBackgroundProcess } from "./background.js";
import { structuredExtractTools } from "./structured-extract.js";
import type { AgentTool, ToolContext, ToolRisk, ToolResult } from "./types.js";
import { normalizeToolResult, toolResult, toolErrorCode } from "./tool-result.js";
import { isVerificationCommand } from "./verification.js";
import { retryDecision, retryDelay } from "./retry-policy.js";
import { resolveWorkspacePath, resolveToolPath, validateWorkspaceGlob } from "./workspace-path.js";

export { resolveWorkspacePath } from "./workspace-path.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 60_000;
const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 500;
const DEFAULT_READ_CHARACTERS = 20_000;

function stringArg(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !value.length) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalStringArray(input: Record<string, unknown>, name: string): string[] {
  const value = input[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || value.some((item) => typeof item !== "string" || !item.length || item.length > 1_000)) {
    throw new Error(`${name} must be an array of at most 50 non-empty strings, each no longer than 1000 characters`);
  }
  return value as string[];
}

function processArgs(input: Record<string, unknown>): string[] {
  const value = input.args;
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || item.length > 20_000)) {
    throw new Error("args must be an array of at most 100 strings, each no longer than 20000 characters");
  }
  const args = value as string[];
  if (args.reduce((total, item) => total + item.length, 0) > 100_000) throw new Error("combined args must not exceed 100000 characters");
  return args;
}

function processProgram(input: Record<string, unknown>): string {
  const program = stringArg(input, "program");
  if (program !== program.trim() || program.length > 1_000 || /[\0\r\n]/.test(program)) throw new Error("program must be a single executable name or workspace-relative path");
  return program;
}

function processTimeout(input: Record<string, unknown>): number {
  if (input.timeout_ms === undefined) return 120_000;
  if (!Number.isInteger(input.timeout_ms) || (input.timeout_ms as number) < 1_000 || (input.timeout_ms as number) > 300_000) {
    throw new Error("timeout_ms must be an integer between 1000 and 300000");
  }
  return input.timeout_ms as number;
}

const SHELL_PROGRAMS = new Set(["powershell", "pwsh", "cmd", "command", "bash", "sh", "zsh", "fish", "wsl"]);

function programName(program: string): string {
  return path.basename(program).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/i, "");
}

function validateDirectProcess(input: Record<string, unknown>): void {
  const program = processProgram(input);
  processArgs(input);
  processTimeout(input);
  if (SHELL_PROGRAMS.has(programName(program))) {
    throw new Error("run_process does not accept a shell wrapper. Use run_command for PowerShell or shell syntax; otherwise pass the target program and each argument directly.");
  }
}

function quoteProcessArgument(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_./\\:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

export function formatProcessInvocation(program: string, args: string[]): string {
  return [quoteProcessArgument(program), ...args.map(quoteProcessArgument)].join(" ");
}

export function classifyProcess(program: string, args: string[]): ToolRisk {
  const name = programName(program);
  const lowered = args.map((item) => item.toLowerCase());
  if (["rm", "rmdir", "del", "erase", "format", "shutdown", "taskkill"].includes(name)) return "dangerous";
  if (name === "git") {
    if ((lowered[0] === "reset" && lowered.includes("--hard")) || (lowered[0] === "clean" && lowered.some((item) => /^-[a-z]*f/i.test(item)))) return "dangerous";
    if (["status", "log", "diff", "show", "rev-parse"].includes(lowered[0] ?? "") || (lowered[0] === "branch" && lowered.includes("--list"))) return "read";
  }
  if (lowered.length === 1 && ["--version", "-v"].includes(lowered[0]!)) return "read";
  return "execute";
}

function resolveProcessProgram(program: string, cwd: string, accessMode?: "workspace" | "full"): string {
  if (program.includes("/") || program.includes("\\")) return resolveToolPath({ cwd, accessMode }, program);
  if (process.platform === "win32" && ["npm", "npx", "pnpm", "yarn", "corepack"].includes(program.toLowerCase())) return `${program}.cmd`;
  return program;
}

async function resolveWindowsNodePackageCli(program: string): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  const name = programName(program);
  if (name !== "npm" && name !== "npx") return undefined;
  const script = name === "npm" ? "npm-cli.js" : "npx-cli.js";
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", script),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", script)] : []),
  ];
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; } catch { /* try the next standard Node/npm layout */ }
  }
  return undefined;
}

function directProcessFailureHint(program: string, errorCode: string | number | undefined): string {
  if (errorCode === "ENOENT") return `\nHint: program '${program}' was not found. Check PATH or pass a workspace-relative executable path.`;
  if (errorCode === "EINVAL" && ["npm", "npx"].includes(programName(program))) return "\nHint: Windows could not launch the npm command directly. Use validate_project for typecheck, lint, test, or build; do not add cmd, /c, /p, or shell-wrapper arguments.";
  return "";
}

function shellFailureHint(command: string, output: string): string {
  const inlineInterpreter = /\b(?:python|py)\s+-c\b|\bnode\s+-e\b/i.test(command);
  const parserFailure = /ParserError|Unexpected token|The string is missing the terminator|字符串缺少终止符|意外的标记/i.test(output);
  return inlineInterpreter || parserFailure
    ? "\nHint: avoid PowerShell quoting for this command. Retry with run_process using program and args so every argument is passed directly."
    : "";
}

function truncate(value: string): string {
  if (value.length <= MAX_OUTPUT) return value;
  const marker = `\n... [output truncated; ${value.length.toLocaleString()} characters total; middle omitted] ...\n`;
  const available = MAX_OUTPUT - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
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

function commandTokens(command: string): string[] {
  return command.match(/"(?:`.|[^"])*"|'(?:''|[^'])*'|[^\s]+/g)?.map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) return token.slice(1, -1);
    return token;
  }) ?? [];
}

function readOnlyPowerShellScript(command: string): boolean {
  const tokens = commandTokens(command);
  const executable = path.basename(tokens[0] ?? "").toLowerCase().replace(/\.exe$/i, "");
  let script = command;
  if (executable === "powershell" || executable === "pwsh") {
    const commandIndex = tokens.findIndex((token) => ["-command", "-c"].includes(token.toLowerCase()));
    if (commandIndex < 0 || !tokens[commandIndex + 1]) return false;
    script = tokens.slice(commandIndex + 1).join(" ");
  }
  const structure = unquotedText(script);
  if (/[;&><=]/.test(structure) || /\b(?:set|add|remove|new|clear|copy|move|rename|start|stop|invoke|out|export|import)-[a-z]+\b/i.test(structure)) return false;
  const cmdlets = structure.match(/\b[A-Za-z]+-[A-Za-z]+\b/g) ?? [];
  if (!cmdlets.length) return false;
  const allowed = new Set(["get-content", "get-childitem", "test-path", "select-string", "get-filehash", "measure-object", "select-object", "where-object", "compare-object"]);
  return cmdlets.every((cmdlet) => allowed.has(cmdlet.toLowerCase()));
}

export function classifyCommand(command: string): ToolRisk {
  const shell = unquotedText(command).trim();
  const gitInvocation = classifyGitInvocation(command, shell);
  if (gitInvocation) return gitInvocation;
  const dangerous = /(^|[;|]\s*)(remove-item\b|del\s+|erase\s+|rd\s+|rmdir\s+|rm\s+)|git\s+(reset\s+--hard|clean\s+-[^\r\n]*f)|\b(format|shutdown|restart-computer|stop-computer)\b/i;
  if (dangerous.test(shell)) return "dangerous";
  const readOnly = [
    /^git\s+(status|log|diff|show|rev-parse|branch\s+--list)\b/i,
    /^(node|npm|python|py|git)\s+--version\b/i,
    /^(get-content|get-childitem|test-path|select-string|get-filehash|measure-object)\b/i,
  ];
  if (readOnlyPowerShellScript(command)) return "read";
  if (/[|;]/.test(shell)) return "execute";
  return readOnly.some((pattern) => pattern.test(shell)) ? "read" : "execute";
}

function classifyGitInvocation(command: string, shell: string): ToolRisk | undefined {
  // Only classify a single Git invocation here. Composed shell commands stay
  // conservative because a later segment may mutate the workspace.
  if (!/^git\b/i.test(shell) || /[;|&<>]/.test(shell)) return undefined;
  const tokens = commandTokens(command);
  if (tokens[0]?.toLowerCase() !== "git") return undefined;
  let index = 1;
  while (index < tokens.length) {
    const option = tokens[index]?.toLowerCase() ?? "";
    if (option === "-c") { index += 2; continue; }
    if (option === "--no-pager" || option === "--paginate" || option.startsWith("--git-dir=") || option.startsWith("--work-tree=")) { index++; continue; }
    break;
  }
  const subcommand = tokens[index]?.toLowerCase();
  const rest = tokens.slice(index + 1).map((token) => token.toLowerCase());
  if (subcommand === "reset" && rest.includes("--hard")) return "dangerous";
  if (subcommand === "clean" && rest.some((item) => /^-[a-z]*f/i.test(item))) return "dangerous";
  if (["status", "log", "diff", "show", "rev-parse"].includes(subcommand ?? "")) return "read";
  if (subcommand === "branch" && rest.includes("--list")) return "read";
  if (subcommand === "worktree" && rest[0] === "list") return "read";
  return "execute";
}

export function looksLikeVerification(command: string): boolean {
  return isVerificationCommand(command);
}

async function projectScriptEvidenceNote(cwd: string, command: string, seen = new Set<string>()): Promise<string> {
  const [executable, ...args] = commandTokens(command);
  if (!["npm", "pnpm", "yarn", "bun"].includes(programName(executable ?? "")) || !looksLikeVerification(command)) return "";
  if (args[0] === "run" || args[0] === "run-script") args.shift();
  const check = args[0] ?? "";
  const unavailable = "\nCheck evidence unavailable: project script is informational or is not a recognized deterministic check.";
  if (seen.has(check) || seen.size >= 5) return unavailable;
  seen.add(check);
  try {
    const pkg = JSON.parse(await fs.readFile(resolveWorkspacePath(cwd, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    const script = pkg.scripts?.[check];
    if (typeof script !== "string" || !looksLikeVerification(script)) return unavailable;
    return projectScriptEvidenceNote(cwd, script, seen);
  } catch { return unavailable; }
}

export function verificationCommandPassed(result: string): boolean {
  if (!/^Exit code: 0\b/.test(result)) return false;
  if (result.includes("Check evidence unavailable:")) return false;
  const negativeEvidence = [
    /(?:验证|校验)(?:失败|未通过|错误)/i,
    /\b(?:verification|validation|check)\s*(?::|result\s*:?)?\s*(?:false|failed|failure|error)\b/im,
    /^\s*(?:false|failed|failure|error)\s*$/im,
    /\b[1-9]\d*\s+(?:failed|failures|errors)\b/i,
    /^\s*(?:FAIL\b|not ok\b)/im,
  ];
  return !negativeEvidence.some((pattern) => pattern.test(result));
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
      if (context.accessMode !== "full") validateWorkspaceGlob(pattern);
      const files = await fg(pattern, {
        cwd: context.cwd,
        onlyFiles: true,
        dot: true,
        unique: true,
        followSymbolicLinks: false,
        ignore: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/.xiu/**"],
      });
      return files.sort().slice(0, 1000).join("\n") || "No matching files.";
    },
  },
  {
    name: "read_file",
    risk: "read",
    description: "Read a bounded UTF-8 text-file window. Defaults to 200 lines. Use line paging for normal files or character paging for minified and giant single-line files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
        start_character: { type: "integer", minimum: 0, description: "Zero-based character offset for minified or giant single-line files." },
        max_characters: { type: "integer", minimum: 1, maximum: 20000, description: "Character window size; defaults to and cannot exceed 20000." },
      },
      required: ["path"], additionalProperties: false,
    },
    describe: (input) => `read ${String(input.path)}`,
    async execute(input, context) {
      const target = resolveToolPath(context, stringArg(input, "path"));
      const content = await fs.readFile(target, "utf8");
      const characterMode = typeof input.start_character === "number" || typeof input.max_characters === "number";
      if (characterMode) {
        const start = typeof input.start_character === "number" ? Math.max(0, Math.floor(input.start_character)) : 0;
        const requested = typeof input.max_characters === "number" ? Math.floor(input.max_characters) : DEFAULT_READ_CHARACTERS;
        const size = Math.max(1, Math.min(DEFAULT_READ_CHARACTERS, requested));
        if (start >= content.length && content.length > 0) throw new Error(`start_character ${start} exceeds file length ${content.length}`);
        const endExclusive = Math.min(content.length, start + size);
        const body = content.slice(start, endExclusive);
        const notice = endExclusive < content.length
          ? `\n[PARTIAL view: characters ${start}-${endExclusive - 1} of ${content.length}; continue with start_character=${endExclusive}]`
          : "";
        return `Characters ${start}-${Math.max(start, endExclusive - 1)} of ${content.length}\n${body}${notice}`;
      }
      const lines = content.split(/\r?\n/);
      const start = typeof input.start_line === "number" ? Math.max(1, input.start_line) : 1;
      if (start > lines.length) throw new Error(`start_line ${start} exceeds file length ${lines.length} lines`);
      const requestedEnd = typeof input.end_line === "number" ? Math.max(start, input.end_line) : start + DEFAULT_READ_LINES - 1;
      const end = Math.min(lines.length, requestedEnd, start + MAX_READ_LINES - 1);
      const body = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");
      const notices: string[] = [];
      if (end < lines.length) notices.push(`[PARTIAL view: lines ${start}-${end} of ${lines.length}; continue with start_line=${end + 1}]`);
      if (body.length > MAX_OUTPUT - 500) notices.push("[This line window is very large. For minified or giant single-line files, use start_character and max_characters to page precisely.]");
      return truncate(`Lines ${start}-${end} of ${lines.length}\n${body}${notices.length ? `\n${notices.join("\n")}` : ""}`);
    },
  },
  ...structuredExtractTools,
  {
    name: "verify_output",
    risk: "read",
    description: "Deterministically verify a generated UTF-8 text artifact with substring and byte-size expectations, or explicitly assert a removed artifact is absent with exists:false. Any unmet condition returns Verification failed. This is bounded artifact validation, not a project test suite.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        exists: { type: "boolean", description: "Set false to verify absence; cannot combine false with content or size expectations." },
        required_substrings: { type: "array", items: { type: "string", minLength: 1, maxLength: 1000 }, maxItems: 50 },
        forbidden_substrings: { type: "array", items: { type: "string", minLength: 1, maxLength: 1000 }, maxItems: 50 },
        min_bytes: { type: "integer", minimum: 0 },
        max_bytes: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    describe: (input) => `verify generated output ${String(input.path)}`,
    validate(input) {
      const required = optionalStringArray(input, "required_substrings");
      const forbidden = optionalStringArray(input, "forbidden_substrings");
      const hasMinimum = typeof input.min_bytes === "number";
      const hasMaximum = typeof input.max_bytes === "number";
      if (input.exists !== undefined && typeof input.exists !== "boolean") throw new Error("exists must be a boolean");
      if (input.exists === false) {
        if (required.length || forbidden.length || hasMinimum || hasMaximum) throw new Error("exists:false cannot be combined with content or size expectations");
        return;
      }
      if (!required.length && !forbidden.length && !hasMinimum && !hasMaximum) {
        throw new Error("verify_output requires at least one substring or byte-size expectation");
      }
      if (hasMinimum && (!Number.isInteger(input.min_bytes) || Number(input.min_bytes) < 0)) throw new Error("min_bytes must be a non-negative integer");
      if (hasMaximum && (!Number.isInteger(input.max_bytes) || Number(input.max_bytes) < 1)) throw new Error("max_bytes must be a positive integer");
      if (hasMinimum && hasMaximum && Number(input.min_bytes) > Number(input.max_bytes)) throw new Error("min_bytes must not exceed max_bytes");
    },
    isVerification: (_input, result) => result.startsWith("Verification passed:"),
    async execute(input, context) {
      const requested = stringArg(input, "path");
      const target = resolveToolPath(context, requested);
      if (input.exists === false) {
        try { await fs.lstat(target); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return `Verification passed: ${requested}\n- absent`;
          throw error;
        }
        return `Verification failed: ${requested}\n- expected path to be absent`;
      }
      const data = await fs.readFile(target);
      const content = new TextDecoder("utf-8", { fatal: true }).decode(data);
      const bytes = data.byteLength;
      const required = optionalStringArray(input, "required_substrings");
      const forbidden = optionalStringArray(input, "forbidden_substrings");
      const missing = required.filter((value) => !content.includes(value));
      const present = forbidden.filter((value) => content.includes(value));
      const failures: string[] = [];
      if (missing.length) failures.push(`missing required substring(s): ${missing.map((value) => JSON.stringify(value)).join(", ")}`);
      if (present.length) failures.push(`found forbidden substring(s): ${present.map((value) => JSON.stringify(value)).join(", ")}`);
      if (typeof input.min_bytes === "number" && bytes < input.min_bytes) failures.push(`size ${bytes} bytes is below minimum ${input.min_bytes}`);
      if (typeof input.max_bytes === "number" && bytes > input.max_bytes) failures.push(`size ${bytes} bytes exceeds maximum ${input.max_bytes}`);
      if (failures.length) return `Verification failed: ${requested}\n- ${failures.join("\n- ")}`;
      return `Verification passed: ${requested}\n- size: ${bytes} bytes\n- required substrings: ${required.length}/${required.length}\n- forbidden substrings absent: ${forbidden.length}/${forbidden.length}`;
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
      if (context.accessMode !== "full") validateWorkspaceGlob(pattern);
      let regex: RegExp;
      try { regex = new RegExp(query, "i"); } catch { throw new Error("query must be a valid regular expression"); }
      const files = await fg(pattern, { cwd: context.cwd, onlyFiles: true, dot: true, followSymbolicLinks: false, ignore: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/.xiu/**"] });
      const matches: string[] = [];
      for (const file of files.slice(0, 3000)) {
        let content: string;
        try { content = await fs.readFile(resolveToolPath(context, file), "utf8"); } catch { continue; }
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
    approvalScope: "workspace-files:write",
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
      const target = resolveToolPath(context, stringArg(input, "path"));
      if (typeof input.content !== "string") throw new Error("content must be a string");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, input.content, "utf8");
      return `Wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${path.relative(context.cwd, target)}`;
    },
  },
  {
    name: "replace_text",
    approvalScope: "workspace-files:edit",
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
      const target = resolveToolPath(context, stringArg(input, "path"));
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
    approvalScope: "workspace-files:edit",
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
      const content = await fs.readFile(resolveToolPath(context, file), "utf8");
      const patches = patchArray(input);
      applyExactPatches(content, patches);
      return patchPreview(file, patches);
    },
    async execute(input, context) {
      const target = resolveToolPath(context, stringArg(input, "path"));
      const content = await fs.readFile(target, "utf8");
      const updated = applyExactPatches(content, patchArray(input));
      await fs.writeFile(target, updated, "utf8");
      return `Applied ${patchArray(input).length} change(s) to ${path.relative(context.cwd, target)}`;
    },
  },
  {
    name: "run_process",
    approvalScope: (input) => classifyProcess(processProgram(input), processArgs(input)) === "dangerous" ? undefined : `run-process:${programName(processProgram(input))}`,
    risk: (input) => classifyProcess(processProgram(input), processArgs(input)),
    changesWorkspace: (input) => classifyProcess(processProgram(input), processArgs(input)) !== "read",
    description: "Run a program directly with an argument array, without PowerShell or shell parsing. Prefer this for Node, Python, Git, npm, test runners, paths with spaces, JSON, regex, and inline code. Use run_command only when PowerShell or shell syntax is required.",
    inputSchema: {
      type: "object",
      properties: {
        program: { type: "string", description: "Executable name from PATH or a workspace-relative executable path. Do not include arguments here." },
        args: { type: "array", items: { type: "string" }, maxItems: 100, description: "Exact argument values. They are passed directly and are never parsed by PowerShell." },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
      },
      required: ["program", "args"],
      additionalProperties: false,
    },
    describe: (input) => `run directly: ${formatProcessInvocation(processProgram(input), processArgs(input))}`,
    isVerification: (input, result) => looksLikeVerification(formatProcessInvocation(processProgram(input), processArgs(input))) && verificationCommandPassed(result),
    validate: validateDirectProcess,
    async preview(input, context) {
      const program = processProgram(input);
      const resolved = resolveProcessProgram(program, context.cwd, context.accessMode);
      return `Direct process (no shell parsing):\n${formatProcessInvocation(resolved, processArgs(input))}`;
    },
    async execute(input, context) { return (await this.executeResult!(input, context)).output; },
    async executeResult(input, context) {
      const requestedProgram = processProgram(input);
      const requestedArgs = processArgs(input);
      const evidenceNote = await projectScriptEvidenceNote(context.cwd, formatProcessInvocation(requestedProgram, requestedArgs));
      const nodePackageCli = await resolveWindowsNodePackageCli(requestedProgram);
      const program = nodePackageCli ? process.execPath : resolveProcessProgram(requestedProgram, context.cwd, context.accessMode);
      const args = nodePackageCli ? [nodePackageCli, ...requestedArgs] : requestedArgs;
      const timeout = processTimeout(input);
      const outputEncoding = process.platform === "win32" ? await windowsConsoleEncoding() : "utf8";
      try {
        const result = await execFileAsync(program, args, { cwd: context.cwd, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: "buffer", signal: context.signal, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
        const stdout = decodeOutput(result.stdout, outputEncoding);
        const stderr = decodeOutput(result.stderr, outputEncoding);
        return toolResult(truncate(`Exit code: 0${evidenceNote}\n${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim()), "success", { exitCode: 0, sideEffectState: "possible" });
      } catch (error) {
        const failure = error as Error & { code?: string | number; stdout?: string | Buffer; stderr?: string | Buffer; killed?: boolean };
        const stdout = decodeOutput(failure.stdout, outputEncoding);
        const stderr = decodeOutput(failure.stderr, outputEncoding);
        if (context.signal?.aborted) return toolResult("Process cancelled by user.", "cancelled", { errorCode: "cancelled", sideEffectState: "unknown" });
        if (failure.killed) return toolResult(truncate(`Process timed out after ${timeout}ms.\n${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim()), "failure", { errorCode: "timeout", sideEffectState: "unknown" });
        const output = `Exit code: ${failure.code ?? "failed"}\n${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim();
        return toolResult(truncate(`${output}${directProcessFailureHint(requestedProgram, failure.code)}`), "failure", { errorCode: typeof failure.code === "number" ? "execution_failed" : toolErrorCode(String(failure.code)), exitCode: typeof failure.code === "number" ? failure.code : undefined, sideEffectState: "unknown" });
      }
    },
  },
  {
    name: "run_command",
    risk: (input) => classifyCommand(stringArg(input, "command")),
    changesWorkspace: (input) => classifyCommand(stringArg(input, "command")) !== "read",
    description: process.platform === "win32"
      ? "Run Windows PowerShell 5.1 syntax in the workspace. Use only for cmdlets, variables, pipelines, redirection, or command composition. Prefer run_process for programs and complex arguments. Requires approval unless --yes is active."
      : "Run POSIX shell syntax in the workspace. Use only for pipelines, redirection, variables, or command composition. Prefer run_process for programs and complex arguments. Requires approval unless --yes is active.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
      },
      required: ["command"], additionalProperties: false,
    },
    describe: (input) => `run: ${String(input.command)}`,
    isVerification: (input, result) => looksLikeVerification(String(input.command)) && verificationCommandPassed(result),
    validate(input) {
      const command = stringArg(input, "command");
      if (process.platform === "win32" && (/&&|\|\||\/dev\/null/.test(unquotedText(command)))) {
        throw new Error("This runtime uses Windows PowerShell 5.1. Retry without Bash operators (&& or ||) and /dev/null; the command already starts in the workspace.");
      }
    },
    async execute(input, context) { return (await this.executeResult!(input, context)).output; },
    async executeResult(input, context) {
      const command = stringArg(input, "command");
      const evidenceNote = await projectScriptEvidenceNote(context.cwd, command);
      const timeout = typeof input.timeout_ms === "number" ? input.timeout_ms : 120_000;
      const isWindows = process.platform === "win32";
      const executable = isWindows ? "powershell.exe" : "/bin/sh";
      const args = isWindows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-lc", command];
      const outputEncoding = isWindows ? await windowsConsoleEncoding() : "utf8";
      try {
        const result = await execFileAsync(executable, args, { cwd: context.cwd, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: "buffer", signal: context.signal, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
        const stdout = decodeOutput(result.stdout, outputEncoding);
        const stderr = decodeOutput(result.stderr, outputEncoding);
        return toolResult(truncate(`Exit code: 0${evidenceNote}\n${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim()), "success", { exitCode: 0, sideEffectState: "possible" });
      } catch (error) {
        const failure = error as Error & { code?: string | number; stdout?: string | Buffer; stderr?: string | Buffer; killed?: boolean };
        const stdout = decodeOutput(failure.stdout, outputEncoding);
        const stderr = decodeOutput(failure.stderr, outputEncoding);
        if (context.signal?.aborted) return toolResult("Command cancelled by user.", "cancelled", { errorCode: "cancelled", sideEffectState: "unknown" });
        if (failure.killed) return toolResult(truncate(`Command timed out after ${timeout}ms.\n${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim()), "failure", { errorCode: "timeout", sideEffectState: "unknown" });
        const output = `Exit code: ${failure.code ?? "failed"}\n${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim();
        return toolResult(truncate(`${output}${shellFailureHint(command, output)}`), "failure", { errorCode: "execution_failed", exitCode: typeof failure.code === "number" ? failure.code : undefined, sideEffectState: "unknown" });
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
    description: "Start a durable long-running command such as a development server under Xiu management. It can continue after Xiu exits; inspect or stop it explicitly with the background-process tools.",
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
    description: "Read persisted output from a managed background command. Pass the returned nextCursor to fetch only new output later.",
    risk: "read",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, cursor: { type: "integer", minimum: 0 } },
      required: ["id"],
      additionalProperties: false,
    },
    describe: (input) => `read background output ${String(input.id)}`,
    async execute(input) {
      const page = readBackgroundProcessOutput(stringArg(input, "id"), typeof input.cursor === "number" ? input.cursor : 0);
      return truncate(JSON.stringify(page, null, 2));
    },
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
    approvalScope: "project-verification",
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
    isVerification: (_input, result) => verificationCommandPassed(result) && !result.includes("Check evidence unavailable:"),
    async execute(input, context) { return (await this.executeResult!(input, context)).output; },
    async executeResult(input, context) {
      const check = stringArg(input, "check");
      const packageFile = resolveToolPath(context, "package.json");
      const pkg = JSON.parse(await fs.readFile(packageFile, "utf8")) as { scripts?: Record<string, string> };
      if (!["typecheck", "lint", "test", "build"].includes(check) || !pkg.scripts?.[check]) return toolResult(`Verification unavailable: package.json has no ${check} script.`, "failure", { errorCode: "unavailable" });
      const nodePackageCli = await resolveWindowsNodePackageCli("npm");
      const executable = nodePackageCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
      const args = nodePackageCli ? [nodePackageCli, "run", check] : ["run", check];
      const timeout = typeof input.timeout_ms === "number" ? input.timeout_ms : 120_000;
      const outputEncoding = process.platform === "win32" ? await windowsConsoleEncoding() : "utf8";
      try {
        const result = await execFileAsync(executable, args, { cwd: context.cwd, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: "buffer", signal: context.signal, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
        const evidenceNote = await projectScriptEvidenceNote(context.cwd, `npm run ${check}`);
        return toolResult(truncate(`Exit code: 0${evidenceNote}\n${decodeOutput(result.stdout, outputEncoding)}${result.stderr.length ? `\nSTDERR:\n${decodeOutput(result.stderr, outputEncoding)}` : ""}`.trim()), "success", { exitCode: 0, sideEffectState: "possible" });
      } catch (error) {
        const failure = error as Error & { code?: string | number; stdout?: string | Buffer; stderr?: string | Buffer; killed?: boolean };
        if (context.signal?.aborted) return toolResult("Verification cancelled by user.", "cancelled", { errorCode: "cancelled", sideEffectState: "unknown" });
        if (failure.killed) return toolResult(`Verification timed out after ${timeout}ms.`, "failure", { errorCode: "timeout", sideEffectState: "unknown" });
        return toolResult(truncate(`Exit code: ${failure.code ?? "failed"}\n${decodeOutput(failure.stdout, outputEncoding)}${failure.stderr ? `\nSTDERR:\n${decodeOutput(failure.stderr, outputEncoding)}` : ""}`.trim()), "failure", { errorCode: "execution_failed", exitCode: typeof failure.code === "number" ? failure.code : undefined, sideEffectState: "unknown" });
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
  return (await executeToolResult(tool, input, context)).output;
}

export async function executeToolResult(tool: AgentTool, input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const cancelled = () => toolResult("Task cancelled by user.", "cancelled", { errorCode: "cancelled" });
  if (context.signal?.aborted) return cancelled();
  try { tool.validate?.(input); }
  catch (error) { return toolResult(`Tool error: ${error instanceof Error ? error.message : String(error)}`, "failure", { errorCode: "invalid_input" }); }
  let risk = typeof tool.risk === "function" ? tool.risk(input) : tool.risk;
  let scriptSnapshot: string | undefined;
  let packageFile: string | undefined;
  let scriptPreview = "";
  let scriptHash = "";
  if (tool.name === "validate_project") {
    try {
      if (!["typecheck", "lint", "test", "build"].includes(String(input.check))) throw new Error("Unknown project check.");
      packageFile = resolveToolPath(context, "package.json");
      scriptSnapshot = await fs.readFile(packageFile, "utf8");
      const scripts = (JSON.parse(scriptSnapshot) as { scripts?: Record<string, string> }).scripts ?? {};
      const check = String(input.check);
      if (typeof scripts[check] !== "string" || !scripts[check]?.trim()) return toolResult(`Verification unavailable: package.json has no ${check} script.`, "failure", { errorCode: "unavailable" });
      const entries = [`pre${check}`, check, `post${check}`].filter(name => typeof scripts[name] === "string");
      scriptPreview = entries.map(name => `${name}: ${scripts[name]}`).join("\n");
      scriptHash = createHash("sha256").update(scriptSnapshot).digest("hex");
      if (entries.some(name => classifyCommand(scripts[name]!) === "dangerous" || /\b(?:npm\s+(?:publish|unpublish)|git\s+push\b.*--force)/i.test(scripts[name]!))) risk = "dangerous";
    } catch (error) { return toolResult(`Tool error: ${error instanceof Error ? error.message : String(error)}`, "failure", { errorCode: "invalid_input" }); }
  }
  if (risk !== "read") {
    let preview: string | undefined;
    try { preview = scriptPreview || await tool.preview?.(input, context); }
    catch (error) { return toolResult(`Tool error: ${error instanceof Error ? error.message : String(error)}`, "failure", { errorCode: toolErrorCode(String(error)) }); }
    const scope = typeof tool.approvalScope === "function" ? tool.approvalScope(input) : tool.approvalScope;
    const sessionScope = scriptHash ? `${scope}:${input.check}:${scriptHash}` : scope;
    if (!(await context.approve({ description: tool.describe(input), risk, preview, sessionScope }))) return toolResult("Tool execution denied by user.", "denied", { errorCode: "denied" });
  }
  if (context.signal?.aborted) return cancelled();
  if (packageFile && await fs.readFile(packageFile, "utf8") !== scriptSnapshot) return toolResult("Tool error: package.json changed after approval. Review the scripts again.", "failure", { errorCode: "stale_input" });
  const replaySafety = typeof tool.replaySafety === "function" ? tool.replaySafety(input) : tool.replaySafety ?? (risk === "read" ? "safe" : "side-effecting");
  const maxAttempts = Math.max(1, Math.min(5, tool.maxAttempts ?? (replaySafety === "safe" || replaySafety === "idempotent" ? 3 : 1)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (context.signal?.aborted) return cancelled();
      const result = normalizeToolResult(tool.executeResult ? await tool.executeResult(input, context) : await tool.execute(input, context));
      if (risk !== "read" && result.status === "success") result.sideEffectState = "possible";
      return result;
    } catch (error) {
      if (context.signal?.aborted) return { ...cancelled(), sideEffectState: risk === "read" ? "none" : "unknown" };
      const decision = retryDecision({ operation: tool.name.startsWith("mcp__") ? "mcp" : "tool", error, attempt, maxAttempts, replaySafety,
        commitState: replaySafety === "safe" || replaySafety === "idempotent" ? "not-committed" : "unknown" });
      if (!decision.retry) return toolResult(`Tool error: ${error instanceof Error ? error.message : String(error)}`, "failure",
        { errorCode: toolErrorCode(String(error)), sideEffectState: risk === "read" ? "none" : "unknown" });
      context.reportProgress?.(`${tool.name}: transient ${decision.category} failure; retrying ${attempt + 1}/${maxAttempts} in ${decision.delayMs}ms`);
      context.setRuntimeState?.("backoff", `${tool.name} retry ${attempt + 1}/${maxAttempts}`);
      try { await retryDelay(decision.delayMs ?? 0, context.signal); }
      catch { return cancelled(); }
      finally { context.setRuntimeState?.("working"); }
    }
  }
}
