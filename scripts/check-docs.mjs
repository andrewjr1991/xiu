import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const workspace = process.cwd();
const manifest = JSON.parse(readFileSync(path.join(workspace, "package.json"), "utf8"));
const documents = [
  "README.md",
  "README.zh-CN.md",
  "QUICKSTART.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "ROADMAP.zh-CN.md",
  "SECURITY.zh-CN.md",
  "USAGE.zh-CN.md",
  "PUBLISHING.zh-CN.md",
];
const failures = [];

for (const document of documents) {
  const fullPath = path.join(workspace, document);
  if (!existsSync(fullPath)) {
    failures.push(`Missing required document: ${document}`);
    continue;
  }
  const content = readFileSync(fullPath, "utf8");
  for (const match of content.matchAll(/\]\((\.\/[^)#]+)(?:#[^)]+)?\)/g)) {
    const target = path.resolve(path.dirname(fullPath), match[1]);
    if (!existsSync(target)) failures.push(`${document} links to missing ${match[1]}`);
  }
}

const expectedDesign = `V${manifest.version}_DESIGN.zh-CN.md`;
const designFiles = readdirSync(workspace).filter((name) => /^V\d+\.\d+\.\d+_DESIGN\.zh-CN\.md$/.test(name));
if (designFiles.length !== 1 || designFiles[0] !== expectedDesign) {
  failures.push(`Expected only ${expectedDesign} at the repository root; found ${designFiles.join(", ") || "none"}`);
}

const roadmap = readFileSync(path.join(workspace, "ROADMAP.zh-CN.md"), "utf8");
if (!roadmap.includes(`| 当前开发版本 | \`${manifest.version}\``)) {
  failures.push(`ROADMAP current development version does not match package.json ${manifest.version}`);
}

const security = readFileSync(path.join(workspace, "SECURITY.zh-CN.md"), "utf8");
if (!security.includes("不伪造 Provider API 未返回的隐藏思维链")) {
  failures.push("SECURITY is missing the no-fabricated-hidden-chain-of-thought boundary");
}

for (const readme of ["README.md", "README.zh-CN.md"]) {
  const content = readFileSync(path.join(workspace, readme), "utf8");
  if (!content.includes("npm install -g @xiu-ai/cli")) failures.push(`${readme} is missing the global install command`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Documentation checks passed for ${manifest.name}@${manifest.version}.`);
}
