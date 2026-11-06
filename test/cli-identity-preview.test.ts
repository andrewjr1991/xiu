import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

for (const trusted of [false, true]) {
  test(`real CLI identity preview ${trusted ? "returns JSON without writes or network" : "refuses untrusted workspaces"}`, { timeout: 60_000 }, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-cli-identity-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, "project");
    const isolatedHome = path.join(root, "isolated user");
    await fs.mkdir(workspace);
    await fs.mkdir(isolatedHome);
    const marker = path.join(root, "network-attempted");
    const preload = path.join(root, "isolate.mjs");
    await fs.writeFile(preload, `import os from 'node:os';import fs from 'node:fs';import http from 'node:http';import https from 'node:https';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';os.homedir=()=>${JSON.stringify(isolatedHome)};const deny=()=>{fs.writeFileSync(${JSON.stringify(marker)},'attempted');throw new Error('Unexpected network request');};globalThis.fetch=deny;http.request=http.get=https.request=https.get=net.connect=net.createConnection=deny;syncBuiltinESMExports();`);
    const args = ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(preload).href, fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "--language", "en", "--cwd", workspace, ...(trusted ? ["--trust-workspace"] : []), "recover", "identity", "json"];
    const result = await new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, args, { cwd: workspace, encoding: "utf8", timeout: 45_000, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout, stderr });
      });
    });
    assert.equal(result.code, trusted ? 0 : 1, result.stderr);
    if (trusted) {
      const preview = JSON.parse(result.stdout);
      assert.equal(preview.schemaVersion, 1);
      assert.equal(preview.ownershipVerified, false);
      assert.equal(preview.migrationSupported, false);
      assert.equal(preview.changesApplied, false);
      assert.doesNotMatch(result.stdout, /xiu-cli-identity|isolated user/);
    } else {
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /not trusted/);
    }
    assert.deepEqual(await fs.readdir(isolatedHome), [], "diagnosis must not initialize settings, trust or task storage");
    assert.deepEqual(await fs.readdir(workspace), []);
    await assert.rejects(fs.access(marker), (error: NodeJS.ErrnoException) => error.code === "ENOENT", "network calls are forbidden, including model/provider probes");
  });
}
