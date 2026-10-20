import assert from "node:assert/strict";
import test from "node:test";
import { classifyCommand, classifyProcess } from "../src/tools.js";

// "read" skips approval and is all Plan mode permits; "dangerous" always asks,
// including in the desktop "approve for me" mode. Each row is an invocation a
// model could emit that must not be under-classified.
const commandCases: Array<[string, "read" | "execute" | "dangerous"]> = [
 ["git status","read"],["git status && npm publish","execute"],["git status\nnode evil.js","execute"],["git log & node evil.js","execute"],
 ["git status > out.txt","execute"],["get-content a.txt > b.txt","execute"],['git diff "$(node evil.js)"',"execute"],["git status `node x`","execute"],
 ["git -c core.fsmonitor='touch x' status","execute"],["git diff --output=x","execute"],["git branch --list -D main","execute"],["git branch --list","read"],
 ["ls && rm -rf x","dangerous"],["echo hi\nrm -rf build","dangerous"],["sh -c 'rm -rf build'","dangerous"],['bash -lc "rm -rf /"',"dangerous"],
 ["git status | xargs rm","dangerous"],["find . -name '*.tmp' -delete","dangerous"],["find . -exec rm {} ;","dangerous"],["sudo rm -rf /","dangerous"],
 ["env FOO=1 /bin/rm x","dangerous"],["echo $(rm -rf x)","dangerous"],['echo "$(rm -rf x)"',"dangerous"],["echo 'rm -rf x'","execute"],
 ["cmd /c rd /s /q build","dangerous"],["powershell -EncodedCommand AAAA","dangerous"],['powershell -Command "Remove-Item x"',"dangerous"],
 ["iex 'rm x'","dangerous"],["echo rm | sh","dangerous"],["timeout 5 git reset --hard","dangerous"],["cd x && git reset --hard","dangerous"],
 ["npm test","execute"],["npm test 2>&1","execute"],['git commit -m "fix; rm old"',"execute"],["node --version","read"],
 [`powershell -Command "(Get-Content '.xiu/worktrees/run/result.txt' | Measure-Object -Character).Characters"`,"read"],
 ["Get-Content a.txt | node evil.js","execute"],["Get-Content $(node evil.js)","execute"],["(Get-ChildItem x).Delete()","execute"],
 ["Get-ChildItem | Where-Object { $_.Delete() }","execute"],["Get-Content a.txt | Measure-Object","read"],["Get-Content a.txt\nnode evil","execute"],
 ["echo \\'; rm x","dangerous"],
 // Quoting and naming tricks that only hide the program from inspection; auto-approval modes skip everything but "dangerous".
 ["$'rm' -rf build","dangerous"],["$'\\x72m' -rf build","dangerous"],["rm${IFS}-rf${IFS}build","dangerous"],["rm$IFS-rf$IFS build","dangerous"],
 ["r\\m -rf build","dangerous"],['"r"m -rf build',"dangerous"],["/bin/r? -rf build","dangerous"],["r[m] -rf build","dangerous"],["sudo r\\m -rf x","dangerous"],
 ["busybox rm -rf build","dangerous"],["echo x | busybox sh","dangerous"],["eval 'rm -rf x'","dangerous"],["eval rm -rf x","dangerous"],
 // Inspectable commands keep their class: a script file, a sourced file, a variable assignment and globbed arguments are not obfuscation.
 ["sh build.sh","execute"],["source ~/.nvm/nvm.sh && nvm use 20","execute"],["$files = Get-ChildItem","execute"],["x=rm; $x -rf y","execute"],
 ["timeout 5 ls *.txt","execute"],["Get-ChildItem *.txt","read"],[`git commit -m "it''s $IFS"`,"execute"],["$'r''m' -rf build","dangerous"],
];

for (const [command, expected] of commandCases) {
  test(`classifyCommand ${JSON.stringify(command)} is ${expected}`, () => {
    assert.equal(classifyCommand(command), expected);
  });
}

test("direct processes inspect wrappers, inline shell scripts and git output options", () => {
  assert.equal(classifyProcess("sh", ["-c", "rm -rf x"]), "dangerous");
  assert.equal(classifyProcess("xargs", ["rm"]), "dangerous");
  assert.equal(classifyProcess("find", [".", "-delete"]), "dangerous");
  assert.equal(classifyProcess("env", ["git", "reset", "--hard"]), "dangerous");
  assert.equal(classifyProcess("git", ["diff", "--output=x"]), "execute");
  assert.equal(classifyProcess("git", ["-c", "core.fsmonitor=x", "status"]), "execute");
  assert.equal(classifyProcess("git", ["status"]), "read");
  assert.equal(classifyProcess("node", ["--version"]), "read");
  assert.equal(classifyProcess("busybox", ["rm", "-rf", "x"]), "dangerous");
  assert.equal(classifyProcess("eval", ["rm", "-rf", "x"]), "dangerous");
  assert.equal(classifyProcess("r\\m", ["-rf", "x"]), "dangerous");
  assert.equal(classifyProcess("/bin/r?", ["-rf", "x"]), "dangerous");
});

test("command words join adjacent quoted and unquoted parts the way a shell does", async () => {
  const { commandTokens } = await import("../src/command-risk.js");
  assert.deepEqual(commandTokens('"r"m -rf "a b"c'), ["rm", "-rf", "a bc"]);
  assert.deepEqual(commandTokens("powershell -Command \"(Get-Content 'x' | Measure-Object).Count\""), ["powershell", "-Command", "(Get-Content 'x' | Measure-Object).Count"]);
  assert.deepEqual(commandTokens("echo 'it''s' \"a`\"b\""), ["echo", "it''s", "a`\"b"]);
  assert.deepEqual(commandTokens('echo "unterminated x'), ["echo", '"unterminated x']);
});

test("deeply nested wrappers fail closed without exponential work", () => {
  const started = Date.now();
  assert.equal(classifyCommand(`${"env ".repeat(2_000)}true`), "dangerous");
  assert.ok(Date.now() - started < 1_000);
});

test("unterminated quotes full of PowerShell escapes tokenize in linear time", () => {
  const started = Date.now();
  assert.equal(classifyCommand(`echo "${"`".repeat(5_000)}`), "execute");
  assert.equal(classifyCommand(`git status "${"`".repeat(5_000)}x`), "execute");
  assert.ok(Date.now() - started < 1_000, "command classification must not backtrack exponentially");
});
