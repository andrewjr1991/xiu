import fs from "node:fs/promises";
import path from "node:path";
import { safeWorkspacePath } from "./core.mjs";

export class EvaluationToolError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "EvaluationToolError";
    this.evaluationCode = code;
  }
}

export function evaluationToolFailureCode(error) {
  return error instanceof EvaluationToolError ? error.evaluationCode : "tool_error";
}

function portableRelative(workspace, target) {
  return path.relative(path.resolve(workspace), target).split(path.sep).join("/");
}

function resolveEvaluationPath(workspace, inputPath, allowedChanges) {
  let target;
  try {
    target = safeWorkspacePath(workspace, inputPath);
  } catch (error) {
    throw new EvaluationToolError("outside_workspace", "Evaluation paths must be portable workspace-relative paths.", { cause: error });
  }
  const relative = portableRelative(workspace, target);
  if (allowedChanges && !allowedChanges.has(relative)) {
    throw new EvaluationToolError("outside_allowlist", "The requested write is outside this task's allowed file set.");
  }
  return target;
}

function normalizeFileError(error) {
  if (error instanceof EvaluationToolError) return error;
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code === "ENOENT") return new EvaluationToolError("not_found", "Evaluation fixture file was not found. Use a workspace-relative path named in the task.", { cause: error });
  if (code === "EISDIR" || code === "ENOTDIR") return new EvaluationToolError("invalid_path", "Evaluation path must identify a regular fixture file.", { cause: error });
  throw new EvaluationToolError("tool_error", "Evaluation file operation failed.", { cause: error });
}

async function rejectLinkedParents(workspace, target) {
  let current = path.dirname(target);
  const root = path.resolve(workspace);
  while (current !== root) {
    const stat = await fs.lstat(current).catch(() => undefined);
    if (stat?.isSymbolicLink()) throw new Error(`Linked workspace path is forbidden: ${current}`);
    current = path.dirname(current);
  }
}

export function createEvaluationTools(workspace, options = {}) {
  const allowedChanges = new Set((options.allowedChanges ?? []).map((file) => String(file).replaceAll("\\", "/")));
  return [
    {
      name: "eval_read_file", description: "Read one evaluation fixture file.", risk: "read", replaySafety: "safe",
      inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false },
      describe: (input) => `read ${input.path}`,
      execute: async (input) => {
        try { return await fs.readFile(resolveEvaluationPath(workspace, input.path), "utf8"); }
        catch (error) { throw normalizeFileError(error); }
      },
    },
    {
      name: "eval_write_file", description: "Write one allowlisted evaluation fixture file.", risk: "write", replaySafety: "idempotent", changesWorkspace: true,
      inputSchema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } }, additionalProperties: false },
      describe: (input) => `write ${input.path}`,
      execute: async (input) => {
        try {
          const target = resolveEvaluationPath(workspace, input.path, allowedChanges);
          await rejectLinkedParents(workspace, target);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, String(input.content), "utf8");
          return `Wrote ${portableRelative(workspace, target)}`;
        } catch (error) { throw normalizeFileError(error); }
      },
    },
    {
      name: "eval_replace_text", description: "Replace one exact occurrence in an evaluation fixture.", risk: "write", replaySafety: "idempotent", changesWorkspace: true,
      inputSchema: { type: "object", required: ["path", "oldText", "newText"], properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, additionalProperties: false },
      describe: (input) => `replace text in ${input.path}`,
      execute: async (input) => {
        try {
          const target = resolveEvaluationPath(workspace, input.path, allowedChanges);
          await rejectLinkedParents(workspace, target);
          const content = await fs.readFile(target, "utf8");
          const parts = content.split(String(input.oldText));
          if (parts.length !== 2) throw new EvaluationToolError("match_count", "Expected exactly one text match in the requested fixture file.");
          await fs.writeFile(target, `${parts[0]}${input.newText}${parts[1]}`, "utf8");
          return `Updated ${portableRelative(workspace, target)}`;
        } catch (error) { throw normalizeFileError(error); }
      },
    },
    {
      name: "eval_verify", description: "Verify exact deterministic expectations in fixture files.", risk: "execute", replaySafety: "safe",
      inputSchema: { type: "object", required: ["checks"], properties: { checks: { type: "array" } }, additionalProperties: false },
      describe: () => "verify evaluation fixture",
      isVerification: (_input, result) => result.startsWith("Verification passed:"),
      execute: async (input) => {
        try {
          if (!Array.isArray(input.checks) || input.checks.length < 1) throw new EvaluationToolError("invalid_input", "At least one verification check is required.");
          for (const check of input.checks) {
            const content = await fs.readFile(resolveEvaluationPath(workspace, check.path), "utf8");
            if (typeof check.equals === "string" && content !== check.equals) throw new EvaluationToolError("verification_failed", "A fixture file did not equal the expected content.");
            if (typeof check.includes === "string" && !content.includes(check.includes)) throw new EvaluationToolError("verification_failed", "A fixture file did not include the expected text.");
          }
          return `Verification passed: ${input.checks.length} deterministic check(s).`;
        } catch (error) { throw normalizeFileError(error); }
      },
    },
  ];
}
