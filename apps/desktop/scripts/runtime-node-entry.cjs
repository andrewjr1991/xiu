const fs = require("node:fs");
const path = require("node:path");
const repo = path.resolve(__dirname, "../../..");
const userData = fs.mkdtempSync(path.join(repo, ".desktop-build-temp", "node-smoke-user-"));
require("electron").app.setPath("userData", userData);
fs.writeFileSync(path.join(repo, ".desktop-build-temp", "runtime-node-result.json"), JSON.stringify({ stage: "entry" }));
try {
  require(path.join(repo, ".desktop-build-temp", "runtime-node-harness.cjs"));
  fs.writeFileSync(path.join(repo, ".desktop-build-temp", "runtime-node-result.json"), JSON.stringify({ stage: "loaded", ready: require("electron").app.isReady() }));
} catch (error) {
  fs.writeFileSync(path.join(repo, ".desktop-build-temp", "runtime-node-result.json"), JSON.stringify({ stage: "load-failed", error: error.stack }));
  require("electron").app.exit(1);
}
