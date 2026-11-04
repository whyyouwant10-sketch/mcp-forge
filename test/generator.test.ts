import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

test("generated real transport rejects private DNS results and IPv6 literals without network access", async () => {
  const output = await mkdtemp(join(tmpdir(), "mcp-forge-security-"));
  const previousOverride = process.env.MCP_FORGE_ALLOW_LOCAL_URLS;
  process.env.MCP_FORGE_ALLOW_LOCAL_URLS = "false";
  try {
    await generate(fixture, join(output, "server"));
    const { RealHttpTransport, isForbiddenAddress } = await import(`${pathToFileURL(join(output, "server/src/http/real-transport.ts")).href}?security-test=${Date.now()}`);
    const request = { method: "GET" as const, url: "http://dns.test/resource", headers: {} };
    for (const address of ["0.0.0.0", "127.0.0.1", "10.0.0.7", "169.254.1.7", "192.168.1.7", "172.16.1.7", "224.0.0.1", "::", "::1", "::ffff:127.0.0.1", "fc00::7", "fe80::7", "ff02::1"]) assert.equal(isForbiddenAddress(address), true, address);
    for (const address of ["93.184.216.34", "2001:db8::7"]) assert.equal(isForbiddenAddress(address), false, address);
    const forbiddenResults = [
      { address: "93.184.216.34", family: 4 as const },
      { address: "10.0.0.7", family: 4 as const },
      { address: "fd00::7", family: 6 as const },
      { address: "fe80::7", family: 6 as const },
      { address: "ff02::1", family: 6 as const },
    ];
    await assert.rejects(new RealHttpTransport({ lookup: async () => forbiddenResults }).send(request), /local and private URLs are disabled/);
    await assert.rejects(new RealHttpTransport({ lookup: async () => [{ address: "127.0.0.1", family: 4 as const }] }).send(request), /local and private URLs are disabled/);
    const literalTransport = new RealHttpTransport({ lookup: async () => { throw new Error("DNS lookup should not run for literals"); } });
    await assert.rejects(literalTransport.send({ ...request, url: "http://[::1]/resource" }), /local and private URLs are disabled/);
  } finally {
    if (previousOverride === undefined) delete process.env.MCP_FORGE_ALLOW_LOCAL_URLS;
    else process.env.MCP_FORGE_ALLOW_LOCAL_URLS = previousOverride;
    await rm(output, { recursive: true, force: true });
  }
});

test("generated real transport preserves redirect and size limits", async () => {
  const output = await mkdtemp(join(tmpdir(), "mcp-forge-limits-"));
  const server = createHttpServer((request, response) => {
    if (request.url === "/redirect") response.writeHead(302, { Location: "/target" }).end();
    else if (request.url === "/large") response.end("x".repeat(4 * 1024 * 1024 + 1));
    else response.end("ok");
  });
  const previousOverride = process.env.MCP_FORGE_ALLOW_LOCAL_URLS;
  process.env.MCP_FORGE_ALLOW_LOCAL_URLS = "true";
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await generate(fixture, join(output, "server"));
    const { RealHttpTransport } = await import(`${pathToFileURL(join(output, "server/src/http/real-transport.ts")).href}?limits-test=${Date.now()}`);
    const port = address.port;
    const lookup = async () => [{ address: "127.0.0.1", family: 4 as const }];
    const transport = new RealHttpTransport({ lookup });
    await assert.rejects(transport.send({ method: "GET", url: `http://dns.test:${port}/redirect`, headers: {} }), /redirects are disabled/);
    await assert.rejects(transport.send({ method: "GET", url: `http://dns.test:${port}/large`, headers: {} }), /response exceeds 4 MiB/);
    await assert.rejects(transport.send({ method: "POST", url: `http://dns.test:${port}/`, headers: {}, body: "x".repeat(1024 * 1024 + 1) }), /request body exceeds 1 MiB/);
  } finally {
    if (previousOverride === undefined) delete process.env.MCP_FORGE_ALLOW_LOCAL_URLS;
    else process.env.MCP_FORGE_ALLOW_LOCAL_URLS = previousOverride;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(output, { recursive: true, force: true });
  }
});
