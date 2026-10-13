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
 ["git status | xargs rm","dangerous"],["find . -name '*.tmp' -delete","dangerous"],["find . -exec rm {} \;","dangerous"],["sudo rm -rf /","dangerous"],
 ["env FOO=1 /bin/rm x","dangerous"],["echo $(rm -rf x)","dangerous"],['echo "$(rm -rf x)"',"dangerous"],["echo 'rm -rf x'","execute"],
 ["cmd /c rd /s /q build","dangerous"],["powershell -EncodedCommand AAAA","dangerous"],['powershell -Command "Remove-Item x"',"dangerous"],
 ["iex 'rm x'","dangerous"],["echo rm | sh","dangerous"],["timeout 5 git reset --hard","dangerous"],["cd x && git reset --hard","dangerous"],
 ["npm test","execute"],["npm test 2>&1","execute"],['git commit -m "fix; rm old"',"execute"],["node --version","read"],
 [`powershell -Command "(Get-Content '.xiu/worktrees/run/result.txt' | Measure-Object -Character).Characters"`,"read"],
 ["Get-Content a.txt | node evil.js","execute"],["Get-Content $(node evil.js)","execute"],["(Get-ChildItem x).Delete()","execute"],
 ["Get-ChildItem | Where-Object { $_.Delete() }","execute"],["Get-Content a.txt | Measure-Object","read"],["Get-Content a.txt\nnode evil","execute"],
 ["echo \\'; rm x","dangerous"],
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
});

test("deeply nested wrappers fail closed without exponential work", () => {
  const started = Date.now();
  assert.equal(classifyCommand(`${"env ".repeat(2_000)}true`), "dangerous");
  assert.ok(Date.now() - started < 1_000);
});
