import fs from "node:fs/promises";
import path from "node:path";
import { safeWorkspacePath } from "./core.mjs";

async function rejectLinkedParents(workspace, target) {
  let current = path.dirname(target);
  const root = path.resolve(workspace);
  while (current !== root) {
    const stat = await fs.lstat(current).catch(() => undefined);
    if (stat?.isSymbolicLink()) throw new Error(`Linked workspace path is forbidden: ${current}`);
    current = path.dirname(current);
  }
}

export function createEvaluationTools(workspace) {
  return [
    {
      name: "eval_read_file", description: "Read one evaluation fixture file.", risk: "read", replaySafety: "safe",
      inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false },
      describe: (input) => `read ${input.path}`,
      execute: async (input) => fs.readFile(safeWorkspacePath(workspace, input.path), "utf8"),
    },
    {
      name: "eval_write_file", description: "Write one allowlisted evaluation fixture file.", risk: "write", replaySafety: "idempotent", changesWorkspace: true,
      inputSchema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } }, additionalProperties: false },
      describe: (input) => `write ${input.path}`,
      execute: async (input) => {
        const target = safeWorkspacePath(workspace, input.path);
        await rejectLinkedParents(workspace, target);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, String(input.content), "utf8");
        return `Wrote ${input.path}`;
      },
    },
    {
      name: "eval_replace_text", description: "Replace one exact occurrence in an evaluation fixture.", risk: "write", replaySafety: "idempotent", changesWorkspace: true,
      inputSchema: { type: "object", required: ["path", "oldText", "newText"], properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, additionalProperties: false },
      describe: (input) => `replace text in ${input.path}`,
      execute: async (input) => {
        const target = safeWorkspacePath(workspace, input.path);
        await rejectLinkedParents(workspace, target);
        const content = await fs.readFile(target, "utf8");
        const parts = content.split(String(input.oldText));
        if (parts.length !== 2) throw new Error(`Expected exactly one match in ${input.path}.`);
        await fs.writeFile(target, `${parts[0]}${input.newText}${parts[1]}`, "utf8");
        return `Updated ${input.path}`;
      },
    },
    {
      name: "eval_verify", description: "Verify exact deterministic expectations in fixture files.", risk: "execute", replaySafety: "safe",
      inputSchema: { type: "object", required: ["checks"], properties: { checks: { type: "array" } }, additionalProperties: false },
      describe: () => "verify evaluation fixture",
      isVerification: (_input, result) => result.startsWith("Verification passed:"),
      execute: async (input) => {
        if (!Array.isArray(input.checks) || input.checks.length < 1) throw new Error("At least one verification check is required.");
        for (const check of input.checks) {
          const content = await fs.readFile(safeWorkspacePath(workspace, check.path), "utf8");
          if (typeof check.equals === "string" && content !== check.equals) throw new Error(`${check.path} did not equal the expected content.`);
          if (typeof check.includes === "string" && !content.includes(check.includes)) throw new Error(`${check.path} did not include the expected text.`);
        }
        return `Verification passed: ${input.checks.length} deterministic check(s).`;
      },
    },
  ];
}
