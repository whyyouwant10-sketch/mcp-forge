import type { GeneratorOptions, NormalizedOperation, NormalizedSpec } from "./model.js";

const GENERATED_VERSION = "0.1.0";

export function renderProject(spec: NormalizedSpec, inputHash: string, packageManager: string, options: GeneratorOptions = {}): Record<string, string> {
  const metadata = JSON.stringify(spec.operations.map((operation) => operationMetadata(operation, spec.securitySchemes)), null, 2);
  const fixtures = JSON.stringify(spec.operations.map((operation) => fixtureRecord(operation, spec.serverUrl, spec.securitySchemes)), null, 2);
  const manifest = stableJson({ generatorVersion: GENERATED_VERSION, inputSha256: inputHash, openapi: spec.openapi, projectName: spec.projectName, options: { includeDeprecated: options.includeDeprecated ?? false, packageManager, serverUrl: spec.serverUrl, strict: options.strict ?? true }, operations: spec.operations.map((operation) => ({ method: operation.method, name: operation.name, operationId: operation.originalOperationId ?? null, path: operation.path })) });
  return {
    ".mcp-forge-manifest.json": `${manifest}\n`,
    "README.md": renderReadme(spec, packageManager),
    "package.json": `${JSON.stringify({ name: spec.projectName, private: true, type: "module", scripts: { build: "tsc -p tsconfig.json", start: "node dist/src/index.js", "fixture": "node dist/test/fixture-client.js" }, devDependencies: { "@types/node": "^22.10.2", typescript: "^5.7.2" }, engines: { node: ">=20" } }, null, 2)}\n`,
    "tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, esModuleInterop: true, skipLibCheck: true, outDir: "dist", rootDir: "." }, include: ["src/**/*.ts", "test/**/*.ts"] }, null, 2)}\n`,
    "src/index.ts": renderIndex(),
    "src/server.ts": renderServer(spec.projectName),
    "src/generated-tools.ts": renderTools(spec, metadata),
    "src/generated-types.ts": renderTypes(spec),
    "src/transport.ts": renderTransport(),
    "src/http/request.ts": renderRequest(),
    "src/http/real-transport.ts": renderRealTransport(),
    "test/fixture-client.ts": renderFixtureClient(),
    "test/fixtures.ts": `export const fixtures = ${fixtures} as const;\n`,
  };
}

function operationMetadata(operation: NormalizedOperation, securitySchemes: NormalizedSpec["securitySchemes"]) {
  return { name: operation.name, originalOperationId: operation.originalOperationId ?? null, method: operation.method.toUpperCase(), path: operation.path, description: operation.descriptionText, inputSchema: operation.inputSchema, outputSchema: operation.outputSchema ?? null, parameters: operation.parameters, requestBody: operation.requestBody ?? null, response: operation.response ?? null, security: operation.security, securitySchemes };
}

function sampleArguments(schema: any): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [group, groupSchema] of Object.entries(schema.properties ?? {})) {
    const value = sampleValue(groupSchema, true);
    if (value !== undefined) result[group] = value;
  }
  return result;
}
function sampleValue(schema: any, includeOptional = false): unknown {
  if (!schema || typeof schema !== "object") return undefined;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.type === "object" || schema.properties) {
    const value: Record<string, unknown> = {};
    for (const key of Object.keys(schema.properties ?? {}).sort()) if (includeOptional || (schema.required ?? []).includes(key)) value[key] = sampleValue(schema.properties?.[key], includeOptional) ?? "fixture";
    return value;
  }
  if (schema.type === "array") return [sampleValue(schema.items, includeOptional) ?? "fixture"];
  if (schema.type === "integer" || schema.type === "number") return 1;
  if (schema.type === "boolean") return true;
  return "fixture";
}
function fixtureRecord(operation: NormalizedOperation, baseUrl: string, securitySchemes: NormalizedSpec["securitySchemes"]) {
  const args = sampleArguments(operation.inputSchema) as any;
  const path = operation.path.replace(/\{([^}]+)\}/g, (_match, key) => encodeURIComponent(args.path?.[key]));
  const query = new URLSearchParams();
  for (const parameter of operation.parameters) if (parameter.in === "query" && args.query?.[parameter.name] !== undefined) query.set(parameter.name, serializeFixture(args.query[parameter.name]));
  const body = operation.requestBody ? operation.requestBody.mediaType === "application/json" ? JSON.stringify(args.body) : new URLSearchParams(args.body ?? {}).toString() : undefined;
  const requiresBearer = operation.security.some((alternative) => alternative.some((scheme) => securitySchemes[scheme]?.type === "http" && securitySchemes[scheme]?.scheme === "bearer"));
  return { tool: operation.name, arguments: args, expected: { method: operation.method.toUpperCase(), url: `${baseUrl.replace(/\/$/, "")}${path}${query.toString() ? `?${query}` : ""}`, body, requiresBearer } };
}
function serializeFixture(value: unknown): string { return typeof value === "string" ? value : typeof value === "boolean" ? (value ? "true" : "false") : JSON.stringify(value); }

function renderReadme(spec: NormalizedSpec, packageManager: string): string {
  const auth = Object.entries(spec.securitySchemes).filter(([, scheme]) => scheme.type !== "unsupported").map(([name, scheme]) => `- ${name}: ${scheme.type === "apiKey" ? "MCP_FORGE_API_KEY" : scheme.scheme === "bearer" ? "MCP_FORGE_BEARER_TOKEN" : "MCP_FORGE_BASIC_USERNAME / MCP_FORGE_BASIC_PASSWORD"}`).join("\n");
  const run = packageManager === "npm" ? "npm" : packageManager;
  return `# ${spec.projectName}\n\nGenerated MCP server for **${spec.title}**. It exposes ${spec.operations.length} OpenAPI operation(s) over MCP stdio.\n\n## Run\n\n\`${run} run build\`\n\nSet credentials when required, then run \`${run} start\` (or \`node dist/src/index.js\`).\n\n## Credentials\n\n${auth || "No security schemes were generated."}\n\nThe fixture client uses an in-memory transport and never makes a network request:\n\n\`${run} run fixture\`\n`;
}

function renderIndex(): string {
  return `import { RealHttpTransport } from "./http/real-transport.js";\nimport { createStdioServer } from "./server.js";\n\nconst auth = {\n  apiKey: process.env.MCP_FORGE_API_KEY,\n  bearerToken: process.env.MCP_FORGE_BEARER_TOKEN,\n  basicUsername: process.env.MCP_FORGE_BASIC_USERNAME,\n  basicPassword: process.env.MCP_FORGE_BASIC_PASSWORD,\n};\nconst server = createStdioServer({ transport: new RealHttpTransport(), auth });\nserver.start().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });\n`;
}

function renderServer(projectName: string): string {
  return `import { tools, callGeneratedTool, type AuthConfig } from "./generated-tools.js";\nimport type { HttpTransport } from "./transport.js";\n\nexport type ServerDependencies = { transport: HttpTransport; auth?: AuthConfig };\nexport type McpServer = { listTools(): Promise<unknown>; callTool(name: string, args: unknown): Promise<unknown>; start(): Promise<void> };\n\nexport function createServer(deps: ServerDependencies): Omit<McpServer, "start"> {\n  return {\n    async listTools() { return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }; },\n    async callTool(name, args) { return callGeneratedTool(name, args, deps); },\n  };\n}\n\nexport function createStdioServer(deps: ServerDependencies): McpServer {\n  const server = createServer(deps);\n  return { ...server, async start() {\n    process.stdin.setEncoding("utf8");\n    const stop = () => { process.stdin.pause(); process.exit(0); }; process.once("SIGINT", stop); process.once("SIGTERM", stop);\n    let buffer = "";\n    for await (const chunk of process.stdin) {\n      buffer += chunk;\n      const lines = buffer.split("\\n"); buffer = lines.pop() ?? "";\n      for (const line of lines) {\n        if (!line.trim()) continue;\n        let request: any;\n        try { request = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Invalid JSON" } }) + "\\n"); continue; }\n        if (request.method === "notifications/initialized") continue;\n        let result: unknown;\n        try {\n          if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: ${JSON.stringify(projectName)}, version: "0.1.0" } };\n          else if (request.method === "tools/list") result = await server.listTools();\n          else if (request.method === "tools/call") result = await server.callTool(request.params?.name, request.params?.arguments ?? {});\n          else throw new Error("method not found");\n          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");\n        } catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }) + "\\n"); }\n      }\n    }\n  } };\n}\n`;
}

function renderTools(spec: NormalizedSpec, metadata: string): string {
  const safeTitle = JSON.stringify(spec.projectName);
  return `import type { HttpRequest, HttpResponse, HttpTransport } from "./transport.js";\n\nexport type AuthConfig = { apiKey?: string; bearerToken?: string; basicUsername?: string; basicPassword?: string };\ntype Tool = { name: string; description: string; inputSchema: any; metadata: any };\nexport const tools: Tool[] = ${metadata}.map((metadata: any) => ({ name: metadata.name, description: metadata.description, inputSchema: metadata.inputSchema, metadata }));\n\nexport async function callGeneratedTool(name: string, args: unknown, deps: { transport: HttpTransport; auth?: AuthConfig }): Promise<any> {\n  const tool = tools.find((candidate) => candidate.name === name);\n  if (!tool) throw new Error("unknown tool: " + name);\n  validate(tool.inputSchema, args, "input");\n  const metadata = tool.metadata;\n  const input = args as Record<string, any>;\n  const base = ${JSON.stringify(spec.serverUrl)}.replace(/\\/$/, "");\n  let path = metadata.path.replace(/\\{([^}]+)\\}/g, (_match: string, key: string) => encodeURIComponent(input.path[key]));\n  const query = new URLSearchParams();\n  for (const parameter of metadata.parameters) {\n    const value = input[parameter.in]?.[parameter.name];\n    if (value === undefined) continue;\n    if (parameter.in === "query") query.set(parameter.name, serialize(value));\n  }\n  const url = base + path + (query.toString() ? "?" + query.toString() : "");\n  const headers: Record<string, string> = {};\n  let body: string | undefined;\n  if (metadata.requestBody) {\n    if (metadata.requestBody.mediaType === "application/json") { headers["Content-Type"] = "application/json"; body = JSON.stringify(input.body); }\n    else { headers["Content-Type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(input.body ?? {}).toString(); }\n  }\n  const cookieValues = metadata.parameters.filter((parameter: any) => parameter.in === "cookie").map((parameter: any) => [parameter.name, input.cookie?.[parameter.name]]).filter((entry: any[]) => entry[1] !== undefined);\n  if (cookieValues.length) headers.Cookie = cookieValues.map(([key, value]: [string, any]) => key + "=" + encodeURIComponent(serialize(value))).join("; ");\n  for (const alternative of metadata.security ?? []) {\n    let applied = true;\n    for (const schemeName of alternative) {\n      const scheme = (metadata.securitySchemes ?? {})[schemeName];\n      if (scheme?.type === "apiKey" && deps.auth?.apiKey) { if (scheme.in === "query") query.set(scheme.name, deps.auth.apiKey); else headers[scheme.name] = deps.auth.apiKey; }\n      else if (scheme?.type === "http" && scheme.scheme === "bearer" && deps.auth?.bearerToken) headers.Authorization = "Bearer " + deps.auth.bearerToken;\n      else if (scheme?.type === "http" && scheme.scheme === "basic" && deps.auth?.basicUsername !== undefined && deps.auth?.basicPassword !== undefined) headers.Authorization = "Basic " + Buffer.from(deps.auth.basicUsername + ":" + deps.auth.basicPassword).toString("base64");\n      else applied = false;\n    }\n    if (applied) break;\n    if (alternative === (metadata.security ?? [])[metadata.security.length - 1]) throw new Error("missing credentials");\n  }\n  const response = await deps.transport.send({ method: metadata.method, url: base + path + (query.toString() ? "?" + query.toString() : ""), headers, body });\n  if (response.status < 200 || response.status >= 300) throw new Error("HTTP request failed with status " + response.status);\n  if (!response.body) return { content: [{ type: "text", text: "" }] };\n  let value: unknown = response.body;\n  if (metadata.response?.mediaType === "application/json") { try { value = JSON.parse(response.body); } catch { throw new Error("response was not valid JSON"); } }\n  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], structuredContent: value };\n}\n\nfunction serialize(value: unknown): string { return typeof value === "string" ? value : typeof value === "boolean" ? (value ? "true" : "false") : JSON.stringify(value); }\nfunction validate(schema: any, value: any, location: string): void {\n  if (!schema || typeof schema !== "object") return;\n  if (value === null) { if (schema.nullable) return; throw new Error(location + " must not be null"); }\n  if (schema.type === "object" || schema.properties) {\n    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(location + " must be an object");\n    for (const key of Object.keys(value)) if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error(location + " contains a forbidden key");\n    for (const key of schema.required ?? []) if (!(key in value)) throw new Error(location + "." + key + " is required");\n    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in (schema.properties ?? {}))) throw new Error(location + "." + key + " is unknown");\n    for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in value) validate(child, value[key], location + "." + key);\n    return;\n  }\n  if (schema.type === "array") { if (!Array.isArray(value)) throw new Error(location + " must be an array"); for (const [index, item] of value.entries()) validate(schema.items, item, location + "[" + index + "]"); return; }\n  if (schema.type === "string" && typeof value !== "string") throw new Error(location + " must be a string");\n  if ((schema.type === "integer" || schema.type === "number") && (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value)))) throw new Error(location + " must be a number");\n  if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(location + " must be a boolean");\n  if (schema.enum && !schema.enum.some((candidate: unknown) => JSON.stringify(candidate) === JSON.stringify(value))) throw new Error(location + " must be an allowed value");\n}\n`;
}

function renderTypes(spec: NormalizedSpec): string {
  const schemas = JSON.stringify(spec.schemas, null, 2);
  const aliases = Object.entries(spec.schemas).sort(([a], [b]) => a.localeCompare(b)).map(([name, schema]) => `export type ${typeName(name)} = ${schemaToType(schema)};`).join("\n");
  const operationTypes = spec.operations.map((operation) => {
    const name = typeName(operation.name);
    return `export type ${name}Input = ${schemaToType(operation.inputSchema)};\nexport type ${name}Output = ${schemaToType(operation.outputSchema ?? {} )};`;
  }).join("\n");
  return `export const schemas = ${schemas} as const;\nexport type GeneratedSchemas = typeof schemas;\n${aliases}\n${operationTypes}\n`;
}
function schemaToType(schema: any): string {
  if (!schema || typeof schema !== "object") return "unknown";
  if (schema.$ref) return typeName(String(schema.$ref).split("/").pop() ?? "Unknown");
  if (schema.allOf) return schema.allOf.map(schemaToType).join(" & ") || "unknown";
  if (schema.oneOf || schema.anyOf) return (schema.oneOf ?? schema.anyOf).map(schemaToType).join(" | ") || "unknown";
  const type = Array.isArray(schema.type) ? schema.type.find((value: string) => value !== "null") : schema.type;
  let result = type === "string" ? "string" : type === "integer" || type === "number" ? "number" : type === "boolean" ? "boolean" : type === "null" ? "null" : type === "array" ? `${schemaToType(schema.items)}[]` : type === "object" || schema.properties ? `{ ${Object.entries(schema.properties ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${safeProperty(key)}${(schema.required ?? []).includes(key) ? "" : "?"}: ${schemaToType(value)};`).join(" ")}${schema.additionalProperties === false ? "" : " [key: string]: unknown"} }` : "unknown";
  if (schema.nullable || (Array.isArray(schema.type) && schema.type.includes("null"))) result += " | null";
  return result;
}
function typeName(value: string): string { const name = value.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).map((part) => part ? part[0].toUpperCase() + part.slice(1) : "").join("") || "Generated"; return /^\d/.test(name) ? `Generated${name}` : name; }
function safeProperty(value: string): string { return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value); }
function renderTransport(): string { return `export type HttpRequest = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; headers: Record<string, string>; body?: string };\nexport type HttpResponse = { status: number; headers: Record<string, string>; body?: string };\nexport interface HttpTransport { send(request: HttpRequest): Promise<HttpResponse>; }\n`; }
function renderRequest(): string { return `import type { HttpRequest } from "../transport.js";\nexport function request(method: HttpRequest["method"], url: string, headers: Record<string, string>, body?: string): HttpRequest { return { method, url, headers, body }; }\n`; }
function renderRealTransport(): string {
  return `import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { HttpRequest, HttpResponse, HttpTransport } from "../transport.js";

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type AddressLookup = (hostname: string) => Promise<ResolvedAddress[]>;
export type RealHttpTransportOptions = { lookup?: AddressLookup };

const defaultLookup: AddressLookup = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => ({ address: result.address, family: result.family === 6 ? 6 : 4 }));
};

export class RealHttpTransport implements HttpTransport {
  private readonly lookup: AddressLookup;

  constructor(options: RealHttpTransportOptions = {}) {
    this.lookup = options.lookup ?? defaultLookup;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const target = new URL(request.url);
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("only http and https URLs are allowed");
    const allowLocalUrls = process.env.MCP_FORGE_ALLOW_LOCAL_URLS === "true";
    const hostname = normalizeHostname(target.hostname);
    if (!allowLocalUrls && isLocalHostAlias(hostname)) throw new Error("local and private URLs are disabled");
    const addresses = await resolveAddresses(hostname, this.lookup);
    if (!allowLocalUrls && addresses.some(({ address }) => isForbiddenAddress(address))) throw new Error("local and private URLs are disabled");
    if (request.body && Buffer.byteLength(request.body) > 1024 * 1024) throw new Error("request body exceeds 1 MiB");
    const timeout = Math.min(60000, Math.max(100, Number(process.env.MCP_FORGE_TIMEOUT_MS ?? 10000) || 10000));
    return requestPinned(target, request, addresses[0], timeout);
  }
}

async function resolveAddresses(hostname: string, lookup: AddressLookup): Promise<ResolvedAddress[]> {
  const literal = parseAddress(hostname);
  if (literal) return [literal];
  const results = await lookup(hostname);
  const addresses = results.map(({ address }) => parseAddress(address));
  if (!addresses.length || addresses.some((address) => !address)) throw new Error("hostname resolved to an invalid address");
  return addresses as ResolvedAddress[];
}

function requestPinned(target: URL, request: HttpRequest, address: ResolvedAddress, timeout: number): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let activeRequest: any;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const finishError = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeRequest?.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const finish = (response: HttpResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    };
    const headers = { ...request.headers };
    if (!Object.keys(headers).some((name) => name.toLowerCase() === "host")) headers.Host = target.host;
    const options: any = {
      protocol: target.protocol,
      hostname: address.address,
      family: address.family,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: request.method,
      path: target.pathname + target.search,
      headers,
      signal: controller.signal,
    };
    if (target.protocol === "https:" && isIP(normalizeHostname(target.hostname)) === 0) options.servername = normalizeHostname(target.hostname);
    const requestFunction: any = target.protocol === "https:" ? httpsRequest : httpRequest;
    activeRequest = requestFunction(options, (response: any) => {
      const redirectStatus = [301, 302, 303, 307, 308].includes(response.statusCode ?? 0);
      if (redirectStatus && response.headers.location !== undefined) {
        response.resume();
        finishError(new Error("redirects are disabled"));
        return;
      }
      const chunks: string[] = [];
      let size = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > 4 * 1024 * 1024) {
          response.destroy();
          finishError(new Error("response exceeds 4 MiB"));
        } else chunks.push(chunk);
      });
      response.on("end", () => {
        const responseHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders[name] = Array.isArray(value) ? value.join(", ") : String(value);
        finish({ status: response.statusCode ?? 0, headers: responseHeaders, body: chunks.join("") });
      });
      response.on("error", finishError);
    });
    activeRequest.on("error", finishError);
    activeRequest.end(request.body);
  });
}

export function isForbiddenAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const ipv4 = parseIPv4(normalized);
  if (ipv4) return isForbiddenIPv4(ipv4);
  const ipv6 = parseIPv6(normalized);
  if (!ipv6) return false;
  if (ipv6.every((part) => part === 0) || (ipv6[0] === 0 && ipv6.slice(1, 7).every((part) => part === 0) && ipv6[7] === 1)) return true;
  const embedded = ipv6.slice(0, 5).every((part) => part === 0) && (ipv6[5] === 0xffff || ipv6[5] === 0);
  if (embedded) return isForbiddenIPv4([(ipv6[6] >> 8) & 255, ipv6[6] & 255, (ipv6[7] >> 8) & 255, ipv6[7] & 255]);
  return (ipv6[0] & 0xfe00) === 0xfc00 || (ipv6[0] & 0xffc0) === 0xfe80 || (ipv6[0] & 0xff00) === 0xff00;
}

function isForbiddenIPv4(parts: number[]): boolean {
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] >= 224 && parts[0] <= 239);
}

function parseAddress(address: string): ResolvedAddress | undefined {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  return family === 4 || family === 6 ? { address: normalized, family } : undefined;
}

function parseIPv4(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : undefined;
}

function parseIPv6(address: string): number[] | undefined {
  if (isIP(address) !== 6) return undefined;
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const parseParts = (value: string): number[] | undefined => {
    if (!value) return [];
    const parts: number[] = [];
    for (const part of value.split(":")) {
      if (part.includes(".")) {
        const ipv4 = parseIPv4(part);
        if (!ipv4) return undefined;
        parts.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) parts.push(parseInt(part, 16));
      else return undefined;
    }
    return parts;
  };
  const left = parseParts(halves[0]);
  const right = parseParts(halves.length === 2 ? halves[1] : "");
  if (!left || !right) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  if (left.length + right.length >= 8) return undefined;
  return [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right];
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\\[|\\]$/g, "").replace(/\\.$/, "");
}

function isLocalHostAlias(hostname: string): boolean {
  return hostname === "localhost" || hostname === "localhost.localdomain";
}
`;
}
function renderFixtureClient(): string { return `import { createServer } from "../src/server.js";\nimport type { HttpRequest, HttpResponse, HttpTransport } from "../src/transport.js";\nimport { fixtures } from "./fixtures.js";\nclass FixtureTransport implements HttpTransport { requests: HttpRequest[] = []; async send(request: HttpRequest): Promise<HttpResponse> { this.requests.push(request); return { status: 200, headers: {}, body: JSON.stringify({ fixture: true }) }; } }\nconst transport = new FixtureTransport();\nconst client = createServer({ transport, auth: { bearerToken: "fixture-token", apiKey: "fixture-key", basicUsername: "fixture", basicPassword: "password" } });\nfor (const fixture of fixtures) { const before = transport.requests.length; await client.callTool(fixture.tool, fixture.arguments); const request = transport.requests[before]; if (!request || request.method !== fixture.expected.method || request.url !== fixture.expected.url || request.body !== (fixture.expected as any).body || ((fixture.expected as any).requiresBearer && request.headers.Authorization !== "Bearer fixture-token")) throw new Error("fixture mismatch for " + fixture.tool); }\nif (transport.requests.length !== fixtures.length) throw new Error("fixture transport did not receive every request");\nconst beforeInvalid = transport.requests.length; try { await client.callTool(fixtures[0].tool, {}); throw new Error("invalid input was accepted"); } catch (error) { if (String(error).includes("invalid input was accepted")) throw error; } if (transport.requests.length !== beforeInvalid) throw new Error("invalid input reached transport");\nconst mismatch = createServer({ transport: { async send(_request: HttpRequest): Promise<HttpResponse> { throw new Error("fixture mismatch"); } } }); try { await mismatch.callTool(fixtures[0].tool, fixtures[0].arguments); throw new Error("fixture mismatch was accepted"); } catch (error) { if (String(error).includes("fixture mismatch was accepted")) throw error; }\nconsole.log("fixture client passed");\n`; }
function stableJson(value: unknown): string { return JSON.stringify(sortObject(value), null, 2); }
function sortObject(value: any): any { if (Array.isArray(value)) return value.map(sortObject); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])])); }
