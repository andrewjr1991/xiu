/**
 * This small CommonJS entry point runs before the optional development loader.
 * It uses only Node built-ins so missing/broken worker imports leave durable,
 * non-secret failure evidence even after the launcher has exited.
 */
import { lifecycleGate } from "./background-lifecycle.js";

export const BACKGROUND_BOOTSTRAP_SOURCE = `const lifecycleGate = ${lifecycleGate.toString()};\n` + String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const [requestFile, source, loader] = process.argv.slice(2);
let request;
const safeCodes = new Set(["ENOENT", "EACCES", "EPERM", "EEXIST", "ENOTDIR", "EISDIR", "ENOSPC", "EMFILE", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_UNKNOWN_FILE_EXTENSION", "ERR_INVALID_PACKAGE_CONFIG", "ERR_UNSUPPORTED_ESM_URL_SCHEME", "ERR_DLOPEN_FAILED"]);
function readRecord() {
  const stat = fs.lstatSync(request.recordFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe record");
  return JSON.parse(fs.readFileSync(request.recordFile, "utf8"));
}
function writeRecord(record) {
  const temporary = request.recordFile + "." + process.pid + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, request.recordFile);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
function fail(error) {
  try {
    if (!request) request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
    lifecycleGate(fs, request.recordFile, () => {
    const current = readRecord();
    if (current.state !== "starting") return;
    const code = safeCodes.has(error && error.code) ? error.code : "UNKNOWN";
    const directory = fs.lstatSync(path.dirname(request.outputFile));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe output directory");
    // Never save exception messages/stacks: they can contain source or secrets.
    fs.writeFileSync(request.outputFile, "Background worker bootstrap failed (" + code + ").\n", { flag: "wx", mode: 0o600 });
    writeRecord({ ...current, pid: process.pid, state: "failed", exitCode: 1,
      failure: { stage: "bootstrap", code }, updatedAt: new Date().toISOString(),
      outputBytes: fs.statSync(request.outputFile).size });
    });
  } catch { /* Unwritable or unsafe storage must never trigger command execution. */ }
  finally { try { fs.unlinkSync(requestFile); } catch {} }
  process.exitCode = 1;
}
(async () => {
  try { fs.unlinkSync(__filename); } catch {}
  request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  const claimed = lifecycleGate(fs, request.recordFile, () => {
    const current = readRecord();
    if (current.state !== "starting") return false;
    writeRecord({ ...current, pid: process.pid, updatedAt: new Date().toISOString() });
    return true;
  });
  if (!claimed) { try { fs.unlinkSync(requestFile); } catch {} return; }
  if (loader) await import(loader);
  await import(source);
})().catch(fail);
`;
