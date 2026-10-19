import assert from "node:assert/strict";
import test from "node:test";
import { expandResourceTemplate, isResourceTemplate, resourceTemplateVariables } from "../src/mcp-resource-template.js";

test("resource template variables are listed once, in order, and plain URIs have none", () => {
  assert.deepEqual(resourceTemplateVariables("file:///{path}"), ["path"]);
  assert.deepEqual(resourceTemplateVariables("db://{schema}/{table}{?schema,limit}"), ["schema", "table", "limit"]);
  assert.deepEqual(resourceTemplateVariables("https://example.com/plain"), []);
  assert.equal(isResourceTemplate("notes://{id}"), true);
  assert.equal(isResourceTemplate("notes://42"), false);
});

test("expansion follows RFC 6570 for the supported operators and encodes values", () => {
  const values = { var: "value", hello: "Hello World!", path: "/foo/bar", empty: "", x: "1024", y: "768" };
  assert.equal(expandResourceTemplate("{var}", values), "value");
  assert.equal(expandResourceTemplate("{hello}", values), "Hello%20World%21");
  assert.equal(expandResourceTemplate("{+path}/here", values), "/foo/bar/here");
  assert.equal(expandResourceTemplate("{+hello}", values), "Hello%20World!");
  assert.equal(expandResourceTemplate("X{#hello}", values), "X#Hello%20World!");
  assert.equal(expandResourceTemplate("X{.var}", values), "X.value");
  assert.equal(expandResourceTemplate("{/var,x}/here", values), "/value/1024/here");
  assert.equal(expandResourceTemplate("{;x,y}", values), ";x=1024;y=768");
  assert.equal(expandResourceTemplate("{;x,empty}", values), ";x=1024;empty");
  assert.equal(expandResourceTemplate("{?x,y}", values), "?x=1024&y=768");
  assert.equal(expandResourceTemplate("?fixed=yes{&x}", values), "?fixed=yes&x=1024");
  assert.equal(expandResourceTemplate("{x,y}", values), "1024,768");
  assert.equal(expandResourceTemplate("file:///{path}", { path: "a b/c" }), "file:///a%20b%2Fc");
  assert.equal(expandResourceTemplate("file:///{+path}", { path: "docs/a b.md" }), "file:///docs/a%20b.md");
  assert.equal(expandResourceTemplate("https://example.com/plain", {}), "https://example.com/plain");
});

test("expansion refuses unsupported syntax, missing variables and oversized values instead of guessing", () => {
  assert.throws(() => expandResourceTemplate("{list*}", { list: "a" }), /Unsupported URI template modifier/);
  assert.throws(() => expandResourceTemplate("{var:3}", { var: "abc" }), /Unsupported URI template modifier/);
  assert.throws(() => expandResourceTemplate("{=var}", { var: "a" }), /Unsupported URI template operator/);
  assert.throws(() => expandResourceTemplate("{}", {}), /Empty URI template expression/);
  assert.throws(() => expandResourceTemplate("{bad name}", { "bad name": "a" }), /Invalid URI template variable name/);
  assert.throws(() => expandResourceTemplate("a{b", {}), /Unbalanced braces/);
  assert.throws(() => expandResourceTemplate("{var}", {}), /variable "var" has no value/);
  assert.throws(() => expandResourceTemplate("{var}", { var: "x".repeat(5_000) }), /invalid value/);
  assert.throws(() => resourceTemplateVariables(`{${Array.from({ length: 33 }, (_, index) => `v${index}`).join(",")}}`), /more than 32 variables/);
});
