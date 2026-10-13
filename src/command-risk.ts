import type { ToolRisk } from "./types.js";

/**
 * Program-side risk classification for shell commands and direct processes.
 *
 * "read" skips approval entirely and is the only risk Plan mode permits, so it
 * is granted only to a single, uncomposed invocation from a fixed allowlist.
 * "dangerous" always requires explicit confirmation, including in the desktop
 * "approve for me" mode, so every command position is inspected: composed
 * segments, substitutions, wrappers (sudo, env, xargs, find -exec) and inline
 * shell scripts. Anything this module cannot inspect stays at least "execute".
 */

const DANGEROUS_PROGRAMS = new Set([
  "rm", "rmdir", "rd", "del", "erase", "remove-item", "ri", "format", "shutdown", "restart-computer", "stop-computer", "taskkill",
]);
// Programs that run (part of) their remaining arguments as another command.
const COMMAND_WRAPPERS = new Set([
  "sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice", "ionice", "timeout", "xargs", "stdbuf", "chroot", "runas", "watch", "parallel", "start-process",
]);
// Programs that run a script string. POSIX shells without -c read a script from stdin.
const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const SCRIPT_EVALUATORS = new Set(["invoke-expression", "iex"]);
const MAX_NESTING = 4;
const INSPECTED_LAUNCHERS = new Set(["git", "find", "cmd", "powershell", "pwsh", ...POSIX_SHELLS, ...COMMAND_WRAPPERS, ...SCRIPT_EVALUATORS]);

export function programName(program: string): string {
  const base = program.replace(/^[\\!]+/, "").split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/i, "");
}

export function unquotedText(value: string): string {
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

export function commandTokens(command: string): string[] {
  return command.match(/"(?:`[\s\S]|[^"`])*"|'(?:''|[^'])*'|[^\s]+/g)?.map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) return token.slice(1, -1);
    return token;
  }) ?? [];
}

function closingParenthesis(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

/**
 * Splits a command into the segments a POSIX shell or PowerShell may execute.
 * Where the two dialects disagree, the split errs toward more segments, so a
 * mismatch can only raise a classification. Substitutions are executed even
 * inside double quotes and are returned as their own segments.
 */
export function commandStructure(command: string): { segments: string[]; composite: boolean } {
  const segments: string[] = [];
  let composite = false;
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (quote === "'") {
      current += character;
      if (character === "'") quote = undefined;
      continue;
    }
    if ((character === "$" || character === "<" || character === ">") && command[index + 1] === "(") {
      const end = closingParenthesis(command, index + 1);
      segments.push(...commandStructure(command.slice(index + 2, end < 0 ? undefined : end)).segments);
      composite = true;
      current += " ";
      index = end < 0 ? command.length : end;
      continue;
    }
    if (character === "`") {
      const end = command.indexOf("`", index + 1);
      segments.push(...commandStructure(command.slice(index + 1, end < 0 ? undefined : end)).segments);
      composite = true;
      current += " ";
      index = end < 0 ? command.length : end;
      continue;
    }
    if (quote === '"') {
      current += character;
      if (character === '"') quote = undefined;
      continue;
    }
    if (character === "\\" && index + 1 < command.length) {
      // POSIX escapes the next character. Treating it as literal in PowerShell
      // too can only split text that PowerShell would have quoted.
      current += character + command[index + 1];
      index++;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (/[;&|\r\n(){}]/.test(character)) {
      segments.push(current);
      current = "";
      composite = true;
      continue;
    }
    if (character === "<" || character === ">") composite = true;
    current += character;
  }
  segments.push(current);
  return { segments: segments.map((segment) => segment.trim()).filter(Boolean), composite };
}

function shellScriptFlag(name: string, token: string): boolean {
  if (name === "cmd") return /^\/[ckr]$/i.test(token);
  if (name === "powershell" || name === "pwsh") return /^[-/]c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(token);
  return /^-[a-z]*c[a-z]*$/i.test(token);
}

/** True when the invocation, or a command it runs, is destructive or cannot be inspected. */
function dangerousInvocation(tokens: string[], depth: number): boolean {
  if (depth > MAX_NESTING) return true;
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index++;
  const program = tokens[index];
  if (!program) return false;
  const name = programName(program);
  const rest = tokens.slice(index + 1);
  if (DANGEROUS_PROGRAMS.has(name)) return true;
  if (name === "git") return gitRisk(rest) === "dangerous";
  if (name === "find") {
    return rest.some((token, position) => /^-delete$/i.test(token)
      || (/^-(?:exec|execdir|ok|okdir)$/i.test(token) && dangerousInvocation(rest.slice(position + 1), depth + 1)));
  }
  if (COMMAND_WRAPPERS.has(name)) {
    // Wrapper options take values (`timeout 5`, `sudo -u user`), so any later
    // destructive program name counts; only the first nested launcher recurses.
    if (rest.some((token) => DANGEROUS_PROGRAMS.has(programName(token)))) return true;
    const inner = rest.findIndex((token) => INSPECTED_LAUNCHERS.has(programName(token)));
    return inner >= 0 && dangerousInvocation(rest.slice(inner), depth + 1);
  }
  if (SCRIPT_EVALUATORS.has(name)) return dangerousScript(rest.join(" "), depth + 1);
  if (name === "cmd" || name === "powershell" || name === "pwsh" || POSIX_SHELLS.has(name)) {
    // -EncodedCommand (and its abbreviations) hides the script from inspection.
    if ((name === "powershell" || name === "pwsh") && rest.some((token) => /^[-/]e(?:c|n\w*)?$/i.test(token))) return true;
    const flag = rest.findIndex((token) => shellScriptFlag(name, token));
    if (flag >= 0) return dangerousScript(rest.slice(flag + 1).join(" "), depth + 1);
    // A POSIX shell with no script argument executes whatever is piped to it.
    if (POSIX_SHELLS.has(name)) return !rest.some((token) => !token.startsWith("-"));
  }
  return false;
}

function dangerousScript(script: string, depth: number): boolean {
  if (depth > MAX_NESTING) return true;
  if (LEGACY_DANGEROUS.test(unquotedText(script))) return true;
  return commandStructure(script).segments.some((segment) => dangerousInvocation(commandTokens(segment), depth));
}

const LEGACY_DANGEROUS = /(^|[;|]\s*)(remove-item\b|del\s+|erase\s+|rd\s+|rmdir\s+|rm\s+)|git\s+(reset\s+--hard|clean\s+-[^\r\n]*f)|\b(format|shutdown|restart-computer|stop-computer)\b/i;

const GIT_BRANCH_MUTATIONS = /^(?:-[dDmMcCuf]|--delete|--move|--copy|--force|--set-upstream-to(?:=.*)?|--unset-upstream|--edit-description|--track|--no-track)$/;

/** Risk of `git <args>`. Global `-c`/`--config-env` can configure executed helpers, so they never stay read-only. */
function gitRisk(args: string[]): ToolRisk {
  let index = 0;
  let configured = false;
  while (index < args.length) {
    const option = args[index] ?? "";
    if (option === "-C") { index += 2; continue; }
    if (option === "-c" || option === "--config-env" || option.startsWith("--config-env=") || option.startsWith("--exec-path")) {
      configured = true;
      index += option === "-c" || option === "--config-env" ? 2 : 1;
      continue;
    }
    if (option === "--no-pager" || option === "--paginate" || option === "-P" || option.startsWith("--git-dir=") || option.startsWith("--work-tree=")) { index++; continue; }
    break;
  }
  const subcommand = args[index]?.toLowerCase();
  const rest = args.slice(index + 1);
  const lowered = rest.map((token) => token.toLowerCase());
  if (subcommand === "reset" && lowered.includes("--hard")) return "dangerous";
  if (subcommand === "clean" && lowered.some((item) => /^-[a-z]*f/i.test(item) || item === "--force")) return "dangerous";
  if (configured || lowered.some((item) => item.startsWith("--output"))) return "execute";
  if (["status", "log", "diff", "show", "rev-parse"].includes(subcommand ?? "")) return "read";
  if (subcommand === "branch" && lowered.includes("--list") && !rest.some((item) => GIT_BRANCH_MUTATIONS.test(item))) return "read";
  if (subcommand === "worktree" && lowered[0] === "list") return "read";
  return "execute";
}

const READ_ONLY_CMDLETS = new Set(["get-content", "get-childitem", "test-path", "select-string", "get-filehash", "measure-object", "select-object", "where-object", "compare-object"]);

function readOnlyPowerShellScript(command: string): boolean {
  const tokens = commandTokens(command);
  const executable = programName(tokens[0] ?? "");
  let script = command;
  if (executable === "powershell" || executable === "pwsh") {
    const commandIndex = tokens.findIndex((token) => ["-command", "-c"].includes(token.toLowerCase()));
    if (commandIndex < 0 || !tokens[commandIndex + 1]) return false;
    script = tokens.slice(commandIndex + 1).join(" ");
  }
  const structure = unquotedText(script);
  // Statement separators, redirection, variables/subexpressions, script blocks,
  // type accessors, escapes and method calls can all run code or write files.
  if (/[;&><=\r\n${}[\]`]/.test(structure) || /\.\s*[A-Za-z_]\w*\s*\(/.test(structure)) return false;
  if (/\b(?:set|add|remove|new|clear|copy|move|rename|start|stop|invoke|out|export|import)-[a-z]+\b/i.test(structure)) return false;
  // Every pipeline element and parenthesized expression must start with an
  // allowlisted cmdlet; a trailing `.Property` reads the preceding result.
  const elements = structure.split(/[|()]/).map((element) => element.trim()).filter(Boolean);
  if (!elements.length) return false;
  return elements.every((element) => /^\.[A-Za-z_][\w.]*$/.test(element) || READ_ONLY_CMDLETS.has((element.split(/\s+/)[0] ?? "").toLowerCase()));
}

const READ_ONLY_COMMANDS = [
  /^(node|npm|python|py|git)\s+--version$/i,
  /^(get-content|get-childitem|test-path|select-string|get-filehash|measure-object)\b/i,
];

export function classifyCommand(command: string): ToolRisk {
  const shell = unquotedText(command).trim();
  if (dangerousScript(command, 0)) return "dangerous";
  if (readOnlyPowerShellScript(command)) return "read";
  const structure = commandStructure(command);
  if (structure.composite || structure.segments.length !== 1) return "execute";
  const tokens = commandTokens(command);
  if (programName(tokens[0] ?? "") === "git") return gitRisk(tokens.slice(1));
  return READ_ONLY_COMMANDS.some((pattern) => pattern.test(shell)) ? "read" : "execute";
}

export function classifyProcess(program: string, args: string[]): ToolRisk {
  if (dangerousInvocation([program, ...args], 0)) return "dangerous";
  const name = programName(program);
  if (name === "git") return gitRisk(args);
  if (args.length === 1 && ["--version", "-v"].includes(args[0]!.toLowerCase())) return "read";
  return "execute";
}
