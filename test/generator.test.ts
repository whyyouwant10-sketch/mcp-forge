import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { generate } from "../src/generate.js";
import { readSpecFile, validateSpec } from "../src/parse.js";

const fixture = join(process.cwd(), "test/fixtures/pets.yaml");

test("validates and normalizes the sample fixture", async () => {
  const { value } = await readSpecFile(fixture);
  assert.deepEqual(validateSpec(value), []);
});

test("reports malformed operations with JSON pointers", () => {
  const diagnostics = validateSpec({ openapi: "3.0.3", info: { title: "Bad", version: "1" }, paths: { "/pets": { get: { responses: { "400": { description: "bad" } } } } } });
  assert.ok(diagnostics.some((diagnostic) => diagnostic.pointer === "/paths/~1pets/get/responses"));
});

test("rejects external references before generation", () => {
  const document = { openapi: "3.0.3", info: { title: "Refs", version: "1" }, paths: { "/pets": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "https://example.test/schema.json" } } } } } } } } };
  assert.ok(validateSpec(document).some((diagnostic) => diagnostic.message.includes("external references")));
});

test("generates deterministic project files and injectable fixture runtime", async () => {
  const first = await mkdtemp(join(tmpdir(), "mcp-forge-"));
  const second = await mkdtemp(join(tmpdir(), "mcp-forge-"));
  try {
    await generate(fixture, join(first, "server"));
    await generate(fixture, join(second, "server"));
    const manifestA = await readFile(join(first, "server/.mcp-forge-manifest.json"), "utf8");
    const manifestB = await readFile(join(second, "server/.mcp-forge-manifest.json"), "utf8");
    assert.equal(manifestA, manifestB);
    const tools = await readFile(join(first, "server/src/generated-tools.ts"), "utf8");
    assert.match(tools, /get_pet/);
    assert.match(tools, /create_pet/);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});
