import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import iconv from "iconv-lite";
import { builtinTools, executeTool } from "../src/tools.js";

async function workspace(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function tool(name: string) {
  const found = builtinTools.find((candidate) => candidate.name === name);
  assert.ok(found, `${name} should be registered`);
  return found;
}

async function run(name: string, input: Record<string, unknown>, cwd: string): Promise<string> {
  return await executeTool(tool(name), input, { cwd, approve: async () => { throw new Error("read tools must not request approval"); } });
}

test("extract_html returns relative fields, attributes, Chinese text, and pagination", async () => {
  const cwd = await workspace("xiu-extract-html-");
  const html = "<!doctype html><table><tr class='item' data-id='001'><td class='name'>云岭茉莉</td><td class='price'>18 &amp; 元</td></tr><tr class='item' data-id='002'><td class='name'>小杯</td><td class='price'>20 元</td></tr></table>";
  await fs.writeFile(path.join(cwd, "case.html"), html, "utf8");
  const output = await run("extract_html", {
    path: "case.html",
    selector: "tr.item",
    offset: 1,
    limit: 1,
    fields: [
      { name: "id", extract: "attribute", attribute: "data-id" },
      { name: "name", selector: ".name", extract: "text" },
      { name: "price_html", selector: ".price", extract: "html" },
    ],
  }, cwd);
  const result = JSON.parse(output);
  assert.equal(result.matched_count, 2);
  assert.equal(result.returned_count, 1);
  assert.equal(result.next_offset, null);
  assert.deepEqual(result.rows, [{ id: "002", name: "小杯", price_html: "20 元" }]);
});

test("extract_html reports invalid selectors without echoing the document", async () => {
  const cwd = await workspace("xiu-extract-html-invalid-");
  await fs.writeFile(path.join(cwd, "case.html"), "<main>secret document body</main>", "utf8");
  const output = await run("extract_html", { path: "case.html", selector: "main[" }, cwd);
  assert.match(output, /^Tool error: Invalid CSS selector/);
  assert.doesNotMatch(output, /secret document body/);
});

test("extract_json supports escaped JSON Pointer tokens and array pagination", async () => {
  const cwd = await workspace("xiu-extract-json-");
  await fs.writeFile(path.join(cwd, "data.json"), JSON.stringify({ "a/b": { "~items": [{ id: 1 }, { id: 2 }, { id: 3 }] } }), "utf8");
  const output = await run("extract_json", { path: "data.json", pointer: "/a~1b/~0items", offset: 1, limit: 1 }, cwd);
  const result = JSON.parse(output);
  assert.equal(result.selected_type, "array");
  assert.equal(result.total_count, 3);
  assert.equal(result.next_offset, 2);
  assert.deepEqual(result.value, [{ id: 2 }]);
});

test("extract_json paginates object keys and explains missing pointers", async () => {
  const cwd = await workspace("xiu-extract-json-object-");
  await fs.writeFile(path.join(cwd, "data.json"), '{"first":1,"second":2,"third":3}', "utf8");
  const page = JSON.parse(await run("extract_json", { path: "data.json", offset: 1, limit: 1 }, cwd));
  assert.deepEqual(page.value, { second: 2 });
  assert.equal(page.next_offset, 2);
  const missing = await run("extract_json", { path: "data.json", pointer: "/missing" }, cwd);
  assert.match(missing, /^Tool error: JSON Pointer segment "missing" was not found/);
});

test("structured extractors detect UTF-16 BOM and GB18030 fallback", async () => {
  const cwd = await workspace("xiu-extract-encoding-");
  const utf16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), iconv.encode('{"message":"中文"}', "utf16le")]);
  await fs.writeFile(path.join(cwd, "utf16.json"), utf16);
  const json = JSON.parse(await run("extract_json", { path: "utf16.json", pointer: "/message" }, cwd));
  assert.equal(json.encoding, "utf16le-bom");
  assert.equal(json.value, "中文");

  await fs.writeFile(path.join(cwd, "gb.csv"), iconv.encode("id,name\n1,规格修正\n", "gb18030"));
  const csv = JSON.parse(await run("extract_csv", { path: "gb.csv" }, cwd));
  assert.equal(csv.encoding, "gb18030-fallback");
  assert.equal(csv.rows[0].name, "规格修正");
});

test("extract_json reports malformed data without echoing its contents", async () => {
  const cwd = await workspace("xiu-extract-json-invalid-");
  await fs.writeFile(path.join(cwd, "broken.json"), '{"secret":"do-not-echo",}', "utf8");
  const output = await run("extract_json", { path: "broken.json" }, cwd);
  assert.match(output, /^Tool error: Invalid JSON in broken\.json:/);
  assert.doesNotMatch(output, /do-not-echo/);
});

test("extract_csv handles BOM, quoted commas and newlines, column selection, and filters", async () => {
  const cwd = await workspace("xiu-extract-csv-");
  const csv = '\uFEFFid,name,note,status\r\n001,"云岭,茉莉","第一行\n第二行",保留\r\n002,小杯,普通,删除\r\n003,常温,说明,保留\r\n';
  await fs.writeFile(path.join(cwd, "data.csv"), csv, "utf8");
  const output = await run("extract_csv", {
    path: "data.csv",
    columns: ["id", "name", "note"],
    where: { status: "保留" },
    offset: 0,
    limit: 1,
  }, cwd);
  const result = JSON.parse(output);
  assert.equal(result.row_count, 3);
  assert.equal(result.matched_count, 2);
  assert.equal(result.next_offset, 1);
  assert.deepEqual(result.rows, [{ id: "001", name: "云岭,茉莉", note: "第一行\n第二行" }]);
});

test("extract_csv supports headerless TSV and rejects unknown columns", async () => {
  const cwd = await workspace("xiu-extract-tsv-");
  await fs.writeFile(path.join(cwd, "data.tsv"), "001\t苹果\n002\t香蕉\n", "utf8");
  const result = JSON.parse(await run("extract_csv", { path: "data.tsv", header: false, columns: ["column_2"] }, cwd));
  assert.deepEqual(result.rows, [{ column_2: "苹果" }, { column_2: "香蕉" }]);
  const missing = await run("extract_csv", { path: "data.tsv", header: false, columns: ["missing"] }, cwd);
  assert.match(missing, /^Tool error: Unknown CSV column/);
});

test("extract_csv rejects pathological wide tables and invalid encodings", async () => {
  const cwd = await workspace("xiu-extract-csv-limits-");
  await fs.writeFile(path.join(cwd, "wide.csv"), Array.from({ length: 501 }, (_, index) => `c${index}`).join(",") + "\n", "utf8");
  assert.match(await run("extract_csv", { path: "wide.csv" }, cwd), /column count 501 exceeds the limit 500/);
  assert.match(await run("extract_csv", { path: "wide.csv", encoding: 42 }, cwd), /encoding must be a non-empty string/);
});

test("structured extractors remain read-only and block workspace escape", async () => {
  const cwd = await workspace("xiu-extract-boundary-");
  for (const name of ["extract_html", "extract_json", "extract_csv"]) assert.equal(tool(name).risk, "read");
  const output = await run("extract_json", { path: "../outside.json" }, cwd);
  assert.match(output, /^Tool error: Path escapes workspace/);
});

test("structured output stays valid and bounded for giant values", async () => {
  const cwd = await workspace("xiu-extract-bounded-");
  await fs.writeFile(path.join(cwd, "large.json"), JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ index, text: "X".repeat(20_000) }))), "utf8");
  const output = await run("extract_json", { path: "large.json", limit: 100, max_value_characters: 2_000 }, cwd);
  const result = JSON.parse(output);
  assert.ok(output.length <= 60_000);
  assert.equal(result.output_truncated, true);
  assert.ok(result.returned_count >= 1 && result.returned_count < 100);
  assert.equal(typeof result.next_offset, "number");
});
