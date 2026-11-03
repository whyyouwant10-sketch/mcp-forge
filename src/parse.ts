import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { Diagnostic, JsonSchema, NormalizedOperation, NormalizedParameter, NormalizedSpec, SecurityScheme } from "./model.js";
import type { GeneratorOptions, HttpMethod } from "./model.js";

const methods: HttpMethod[] = ["get", "post", "put", "patch", "delete"];
const reservedNames = new Set(["initialize", "notifications_initialized", "list_tools", "call_tool"]);

export async function readSpecFile(file: string): Promise<{ value: unknown; bytes: Buffer }> {
  const bytes = await readFile(file);
  let value: unknown;
  try {
    value = file.endsWith(".yaml") || file.endsWith(".yml")
      ? YAML.parse(bytes.toString("utf8"))
      : JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`cannot parse input: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { value, bytes };
}

export function validateSpec(value: unknown, options: GeneratorOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(value)) return [{ message: "document must be an object" }];
  if (typeof value.openapi !== "string" || !/^3\.[01]\.[0-9]+$/.test(value.openapi)) {
    diagnostics.push({ pointer: "/openapi", message: "must be an OpenAPI 3.0.x or 3.1.x version" });
  }
  if (!isRecord(value.info) || typeof value.info.title !== "string" || !value.info.title.trim()) {
    diagnostics.push({ pointer: "/info/title", message: "must be a non-empty string" });
  }
  if (!isRecord(value.info) || typeof value.info.version !== "string" || !value.info.version.trim()) {
    diagnostics.push({ pointer: "/info/version", message: "must be a non-empty string" });
  }
  if (Array.isArray(value.servers)) {
    for (const [index, server] of value.servers.entries()) {
      if (!isRecord(server) || typeof server.url !== "string" || !/^https?:\/\//.test(server.url)) diagnostics.push({ pointer: `/servers/${index}/url`, message: "must be an http or https URL" });
    }
  }
  if (!isRecord(value.paths)) {
    diagnostics.push({ pointer: "/paths", message: "must be an object" });
    return diagnostics;
  }
  for (const [path, item] of Object.entries(value.paths)) {
    if (!path.startsWith("/")) diagnostics.push({ pointer: pointer(`/paths/${path}`), message: "path must begin with /" });
    if (!isRecord(item)) {
      diagnostics.push({ pointer: pointer(`/paths/${path}`), message: "path item must be an object" });
      continue;
    }
    if ("$ref" in item) diagnostics.push({ pointer: pointer(`/paths/${path}/$ref`), message: "path-item $ref is unsupported" });
    for (const [method, operation] of Object.entries(item)) {
      if (method === "parameters" || method === "summary" || method === "description" || method === "$ref") continue;
      const opPointer = `/paths/${escapePointer(path)}/${method}`;
      if (!methods.includes(method as HttpMethod)) {
        diagnostics.push({ pointer: pointer(opPointer), message: `unsupported HTTP method ${method}` });
        continue;
      }
      if (!isRecord(operation)) {
        diagnostics.push({ pointer: pointer(opPointer), message: "operation must be an object" });
        continue;
      }
      if (operation.deprecated === true && !options.includeDeprecated) continue;
      if (!isRecord(operation.responses)) {
        diagnostics.push({ pointer: pointer(`${opPointer}/responses`), message: "operation must define responses" });
      } else if (!Object.keys(operation.responses).some((status) => status === "default" || /^2\d\d$/.test(status))) {
        diagnostics.push({ pointer: pointer(`${opPointer}/responses`), message: "operation needs a 2xx or default response" });
      }
      checkRefs(operation, opPointer, diagnostics, value.openapi.startsWith("3.1"));
      if (isRecord(operation.requestBody) && isRecord(operation.requestBody.content)) {
        const contentTypes = Object.keys(operation.requestBody.content);
        if (contentTypes.some((type) => !["application/json", "application/x-www-form-urlencoded"].includes(type))) {
          diagnostics.push({ pointer: pointer(`${opPointer}/requestBody/content`), message: "only JSON and form-urlencoded request bodies are supported" });
        }
      }
    }
  }
  checkRefs(value, "", diagnostics, typeof value.openapi === "string" && value.openapi.startsWith("3.1"));
  if (isRecord(value.servers) && value.servers.length === 0) diagnostics.push({ pointer: "/servers", message: "servers must be an array" });
  return uniqueDiagnostics(diagnostics);
}

export function normalizeSpec(raw: Record<string, unknown>, options: GeneratorOptions = {}): NormalizedSpec {
  const version = String(raw.openapi);
  const info = raw.info as Record<string, unknown>;
  const title = String(info.title);
  const projectName = options.projectName ?? sanitizeProjectName(title);
  const serverUrl = options.serverUrl ?? (Array.isArray(raw.servers) && isRecord(raw.servers[0]) && typeof raw.servers[0].url === "string" ? raw.servers[0].url : "http://localhost");
  if (!/^https?:\/\//.test(serverUrl)) throw new Error("server URL must use http or https");
  const warnings: string[] = [];
  const securitySchemes: Record<string, SecurityScheme> = {};
  const components = isRecord(raw.components) ? raw.components : {};
  const rawSchemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
  for (const name of Object.keys(rawSchemes).sort()) {
    const scheme = rawSchemes[name];
    if (!isRecord(scheme)) continue;
    if (scheme.type === "apiKey" && (scheme.in === "header" || scheme.in === "query") && typeof scheme.name === "string") {
      securitySchemes[name] = { type: "apiKey", in: scheme.in, name: scheme.name };
    } else if (scheme.type === "http" && typeof scheme.scheme === "string" && ["bearer", "basic"].includes(scheme.scheme.toLowerCase())) {
      securitySchemes[name] = { type: "http", scheme: scheme.scheme.toLowerCase() };
    } else {
      securitySchemes[name] = { type: "unsupported" };
      if (options.strict !== false) throw new Error(`unsupported security scheme: ${name}`);
      warnings.push(`unsupported security scheme: ${name}`);
    }
  }
  const operations: NormalizedOperation[] = [];
  const paths = raw.paths as Record<string, unknown>;
  for (const path of Object.keys(paths).sort()) {
    const item = paths[path];
    if (!isRecord(item)) continue;
    for (const method of methods) {
      const rawOperation = item[method];
      if (!isRecord(rawOperation)) continue;
      if (rawOperation.deprecated === true && !options.includeDeprecated) continue;
      const response = selectResponse(rawOperation.responses, raw, `/paths/${escapePointer(path)}/${method}`, options.strict !== false);
      if (!response) {
        if (options.strict !== false) throw new Error(`no successful response at /paths/${escapePointer(path)}/${method}/responses`);
        warnings.push(`skipped operation without successful response: ${method.toUpperCase()} ${path}`);
        continue;
      }
      const parameters = collectParameters(item.parameters, rawOperation.parameters, raw, options.strict !== false);
      const requestBody = normalizeRequestBody(rawOperation.requestBody, raw, options.strict !== false);
      const originalOperationId = typeof rawOperation.operationId === "string" ? rawOperation.operationId : undefined;
      const baseName = normalizeToolName(originalOperationId ?? `${method}_${path}`, path, method, originalOperationId);
      const security = normalizeSecurity(rawOperation.security ?? raw.security);
      const inputSchema = buildInputSchema(parameters, requestBody);
      operations.push({
        name: baseName,
        originalOperationId,
        method,
        path,
        summary: typeof rawOperation.summary === "string" ? rawOperation.summary : undefined,
        description: typeof rawOperation.description === "string" ? rawOperation.description : undefined,
        tags: Array.isArray(rawOperation.tags) ? rawOperation.tags.filter((tag): tag is string => typeof tag === "string").sort() : [],
        parameters,
        requestBody,
        response,
        security,
        inputSchema,
        outputSchema: response.schema,
        descriptionText: makeDescription(method, path, rawOperation, parameters, response, security),
      });
    }
  }
  operations.sort((a, b) => a.name.localeCompare(b.name) || a.method.localeCompare(b.method) || a.path.localeCompare(b.path));
  const used = new Map<string, number>();
  for (const operation of operations) {
    const count = (used.get(operation.name) ?? 0) + 1;
    used.set(operation.name, count);
    if (count > 1) operation.name = `${operation.name}_${count}`;
  }
  const schemas = isRecord(components.schemas) ? cloneSorted(components.schemas) as Record<string, JsonSchema> : {};
  return { openapi: version, title, version: String(info.version), projectName, serverUrl, operations, schemas, securitySchemes, warnings };
}

function selectResponse(responses: unknown, root: Record<string, unknown>, operationPointer: string, strict: boolean) {
  if (!isRecord(responses)) return undefined;
  const keys = Object.keys(responses).filter((key) => key === "default" || /^2\d\d$/.test(key)).sort((a, b) => (a === "default" ? 999 : Number(a)) - (b === "default" ? 999 : Number(b)));
  const status = keys[0];
  if (!status) return undefined;
  const response = resolve(responses[status], root, [], strict);
  if (!isRecord(response)) return { status };
  const content = isRecord(response.content) ? response.content : {};
  const mediaType = ["application/json", "text/plain"].find((type) => type in content) as "application/json" | "text/plain" | undefined;
  if (Object.keys(content).length && !mediaType) {
    if (strict) throw new Error(`unsupported response media type at ${operationPointer}/responses/${status}/content`);
    return { status };
  }
  const media = mediaType && isRecord(content[mediaType]) ? content[mediaType] : undefined;
  return { status, mediaType, schema: media && media.schema ? resolveSchema(media.schema, root, strict) : undefined };
}

function collectParameters(...args: unknown[]): NormalizedParameter[] {
  const [pathParameters, operationParameters, root, strict] = args as [unknown, unknown, Record<string, unknown>, boolean];
  const result = new Map<string, NormalizedParameter>();
  for (const source of [pathParameters, operationParameters]) {
    if (!Array.isArray(source)) continue;
    for (const value of source) {
      const parameter = resolve(value, root, [], strict);
      if (!isRecord(parameter) || typeof parameter.name !== "string" || typeof parameter.in !== "string") continue;
      if (!["path", "query", "header", "cookie"].includes(parameter.in)) {
        if (strict) throw new Error(`unsupported parameter location: ${parameter.in}`);
        continue;
      }
      const schema = resolveSchema(parameter.schema ?? { type: "string" }, root, strict);
      result.set(`${parameter.in}:${parameter.name}`, { name: parameter.name, in: parameter.in as NormalizedParameter["in"], required: parameter.in === "path" || parameter.required === true, schema, description: typeof parameter.description === "string" ? parameter.description : undefined });
    }
  }
  return [...result.values()].sort((a, b) => a.in.localeCompare(b.in) || a.name.localeCompare(b.name));
}

function normalizeRequestBody(value: unknown, root: Record<string, unknown>, strict: boolean) {
  if (value === undefined) return undefined;
  const body = resolve(value, root, [], strict);
  if (!isRecord(body) || !isRecord(body.content)) return undefined;
  const mediaType = ["application/json", "application/x-www-form-urlencoded"].find((type) => type in body.content) as "application/json" | "application/x-www-form-urlencoded" | undefined;
  if (!mediaType) {
    if (strict) throw new Error("request body must use JSON or form-urlencoded content");
    return undefined;
  }
  const media = isRecord(body.content[mediaType]) ? body.content[mediaType] : {};
  return { required: body.required === true, mediaType, schema: resolveSchema(media.schema ?? {}, root, strict) };
}

function buildInputSchema(parameters: NormalizedParameter[], body: NormalizedOperation["requestBody"]): JsonSchema {
  const groups: Record<string, JsonSchema> = {};
  for (const location of ["path", "query", "header", "cookie"] as const) {
    const values = parameters.filter((parameter) => parameter.in === location);
    if (!values.length) continue;
    groups[location] = { type: "object", additionalProperties: false, properties: Object.fromEntries(values.map((parameter) => [parameter.name, parameter.schema])), required: values.filter((parameter) => parameter.required).map((parameter) => parameter.name).sort() };
  }
  if (body) groups.body = body.schema;
  return { type: "object", additionalProperties: false, properties: groups, required: [...parameters.filter((parameter) => parameter.required).map((parameter) => parameter.in), ...(body?.required ? ["body"] : [])].filter((value, index, values) => values.indexOf(value) === index).sort() };
}

function normalizeSecurity(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => Object.keys(item).sort()).sort((a, b) => a.join(",").localeCompare(b.join(",")));
}

function makeDescription(method: HttpMethod, path: string, operation: Record<string, unknown>, parameters: NormalizedParameter[], response: NonNullable<NormalizedOperation["response"]>, security: string[][]): string {
  const supplied = typeof operation.description === "string" ? operation.description : undefined;
  const summary = typeof operation.summary === "string" ? operation.summary : "Execute this operation";
  const input = parameters.filter((parameter) => parameter.required).map((parameter) => `${parameter.in}.${parameter.name}`).concat(isRecord(operation.requestBody) && operation.requestBody.required === true ? ["body"] : []);
  const media = response.mediaType ?? "no response body";
  let result = supplied ?? `${method.toUpperCase()} ${path}. ${summary}. Inputs: ${input.length ? input.join(", ") : "none"}. Returns: ${media}.`;
  if (security.length) result += " Authentication is required.";
  return truncate(cleanText(result), 1024);
}

function normalizeToolName(source: string, path: string, method: string, operationId?: string): string {
  const original = source;
  let name = source.replace(/\{([^}]+)\}/g, " by_$1 ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").trim().toLowerCase().replace(/ +/g, "_");
  if (!name) name = "tool";
  if (/^\d/.test(name)) name = `tool_${name}`;
  if (reservedNames.has(name) || name.startsWith("__")) throw new Error(`reserved tool name: ${name}`);
  if (name.length > 64) {
    const suffix = createHash("sha256").update(`${path}:${method}:${operationId ?? original}`).digest("hex").slice(0, 8);
    name = `${name.slice(0, 55).replace(/_+$/, "")}_${base32(suffix)}`.slice(0, 64);
  }
  return name;
}

function resolveSchema(value: unknown, root: Record<string, unknown>, strict: boolean): JsonSchema {
  const resolved = resolve(value, root, [], strict);
  return isRecord(resolved) ? cloneSorted(resolved) as JsonSchema : {};
}

function resolve(value: unknown, root: Record<string, unknown>, chain: string[], strict: boolean): unknown {
  if (!isRecord(value) || typeof value.$ref !== "string") return value;
  const ref = value.$ref;
  if (!ref.startsWith("#/")) throw new Error(`external reference is unsupported: ${ref}`);
  if (chain.includes(ref)) throw new Error(`reference cycle: ${[...chain, ref].join(" -> ")}`);
  const target = ref.slice(2).split("/").map(unescapePointer).reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, root);
  if (target === undefined) throw new Error(`unresolved reference: ${ref}`);
  const result = resolve(target, root, [...chain, ref], strict);
  if (Object.keys(value).length > 1) {
    if (!String(root.openapi).startsWith("3.1")) throw new Error(`reference siblings require OpenAPI 3.1: ${ref}`);
    if (isRecord(result)) return { ...result, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref")) };
  }
  return result;
}

function checkRefs(value: unknown, pointerValue: string, diagnostics: Diagnostic[], is31: boolean, chain: string[] = []): void {
  if (Array.isArray(value)) return value.forEach((item, index) => checkRefs(item, `${pointerValue}/${index}`, diagnostics, is31, chain));
  if (!isRecord(value)) return;
  if (typeof value.$ref === "string") {
    if (!value.$ref.startsWith("#/")) diagnostics.push({ pointer: pointer(pointerValue + "/$ref"), message: "external references are unsupported" });
    if (Object.keys(value).length > 1 && !is31) diagnostics.push({ pointer: pointer(pointerValue), message: "$ref sibling fields require OpenAPI 3.1" });
    if (chain.includes(value.$ref)) diagnostics.push({ pointer: pointer(pointerValue + "/$ref"), message: `reference cycle: ${[...chain, value.$ref].join(" -> ")}` });
    chain = [...chain, value.$ref];
  }
  for (const [key, child] of Object.entries(value)) checkRefs(child, `${pointerValue}/${escapePointer(key)}`, diagnostics, is31, chain);
}

function cloneSorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneSorted);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, cloneSorted(value[key])]));
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function pointer(value: string): string { return value || "/"; }
function escapePointer(value: string): string { return value.replace(/~/g, "~0").replace(/\//g, "~1"); }
function unescapePointer(value: string): string { return value.replace(/~1/g, "/").replace(/~0/g, "~"); }
function cleanText(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(); }
function truncate(value: string, maxBytes: number): string { while (Buffer.byteLength(value, "utf8") > maxBytes) value = value.slice(0, -1); return value; }
function sanitizeProjectName(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "mcp-server"; }
function base32(hex: string): string { const alphabet = "abcdefghijklmnopqrstuvwxyz234567"; let bits = ""; for (const digit of hex) bits += parseInt(digit, 16).toString(2).padStart(4, "0"); let result = ""; for (let i = 0; i + 5 <= bits.length; i += 5) result += alphabet[parseInt(bits.slice(i, i + 5), 2)]; return result.slice(0, 8); }
function uniqueDiagnostics(items: Diagnostic[]): Diagnostic[] { return [...new Map(items.map((item) => [`${item.pointer}:${item.message}`, item])).values()]; }
