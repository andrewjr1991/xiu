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

// Every guide page ships in the npm package and is linked from the USAGE index; their relative links must resolve too.
const guideDirectory = path.join(workspace, "docs", "guide");
if (existsSync(guideDirectory)) {
  const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : entry.name.endsWith(".md") ? [path.relative(workspace, full).split(path.sep).join("/")] : [];
  });
  documents.push(...walk(guideDirectory));
}

for (const document of documents) {
  const fullPath = path.join(workspace, document);
  if (!existsSync(fullPath)) {
    failures.push(`Missing required document: ${document}`);
    continue;
  }
  const content = readFileSync(fullPath, "utf8");
  for (const match of content.matchAll(/\]\(((?:\.\.?\/)[^)#]+)(?:#[^)]+)?\)/g)) {
    const target = path.resolve(path.dirname(fullPath), match[1]);
    if (!existsSync(target)) failures.push(`${document} links to missing ${match[1]}`);
  }
}

const expectedDesign = `V${manifest.version}_DESIGN.zh-CN.md`;
const designFiles = readdirSync(workspace).filter((name) => /^V\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?_DESIGN\.zh-CN\.md$/.test(name));
if (designFiles.length !== 1 || designFiles[0] !== expectedDesign) {
  failures.push(`Expected only ${expectedDesign} at the repository root; found ${designFiles.join(", ") || "none"}`);
}

const roadmap = readFileSync(path.join(workspace, "ROADMAP.zh-CN.md"), "utf8");
if (!roadmap.includes(`| 当前开发版本 | \`${manifest.version}\``)) {
  failures.push(`ROADMAP current development version does not match package.json ${manifest.version}`);
}
// The roadmap keeps exactly one current state and one next step; dated history goes to docs/history/.
for (const heading of ["## 当前状态", "## 当前优先级", "## 下一步"]) {
  const count = roadmap.split("\n").filter((line) => line.trim() === heading).length;
  if (count !== 1) failures.push(`ROADMAP must contain exactly one "${heading}" section; found ${count}`);
}

const security = readFileSync(path.join(workspace, "SECURITY.zh-CN.md"), "utf8");
if (!security.includes("不伪造 Provider API 未返回的隐藏思维链")) {
  failures.push("SECURITY is missing the no-fabricated-hidden-chain-of-thought boundary");
}

const readmeHeadings = {};
const readmeLinks = {};
for (const readme of ["README.md", "README.zh-CN.md"]) {
  const content = readFileSync(path.join(workspace, readme), "utf8");
  if (!content.includes("npm install -g @xiu-ai/cli")) failures.push(`${readme} is missing the global install command`);
  readmeHeadings[readme] = content.split("\n").filter((line) => line.startsWith("## ")).length;
  // The two READMEs are translations of one document: same sections, same set of linked documents (archives differ per language).
  readmeLinks[readme] = [...content.matchAll(/\]\((\.\/[^)#]+)(?:#[^)]+)?\)/g)].map((match) => match[1])
    .filter((target) => !target.startsWith("./docs/history/") && !/^\.\/README(?:\.zh-CN)?\.md$/.test(target)).sort();
}
if (readmeHeadings["README.md"] !== readmeHeadings["README.zh-CN.md"]) {
  failures.push(`README.md has ${readmeHeadings["README.md"]} sections but README.zh-CN.md has ${readmeHeadings["README.zh-CN.md"]}`);
}
if (JSON.stringify([...new Set(readmeLinks["README.md"])]) !== JSON.stringify([...new Set(readmeLinks["README.zh-CN.md"])])) {
  failures.push(`README.md and README.zh-CN.md link different documents: ${readmeLinks["README.md"].join(", ")} vs ${readmeLinks["README.zh-CN.md"].join(", ")}`);
}

// Maintainer-only documents stay in the repository; the npm package carries the user-facing layers only.
const packaged = new Set(manifest.files ?? []);
for (const maintainerOnly of ["PUBLISHING.zh-CN.md", "ROADMAP.zh-CN.md", expectedDesign, "docs/development-progress.md"]) {
  if (packaged.has(maintainerOnly)) failures.push(`package.json files must not ship ${maintainerOnly}`);
}
for (const required of ["README.md", "USAGE.zh-CN.md", "SECURITY.zh-CN.md", "docs/guide"]) {
  if (!packaged.has(required)) failures.push(`package.json files must ship ${required}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Documentation checks passed for ${manifest.name}@${manifest.version}.`);
}
