#!/usr/bin/env node
import { access, stat } from "node:fs/promises";
import { generate } from "./generate.js";
import { readSpecFile, validateSpec } from "./parse.js";
import type { GeneratorOptions } from "./model.js";

const VERSION = "0.1.0";

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--version")) { console.log(VERSION); return 0; }
  if (argv.length === 0 || argv.includes("--help")) { console.log(help()); return 0; }
  const command = argv[0];
  if (command !== "validate" && command !== "generate") { console.error(`error: unknown command ${command}`); return 2; }
  try {
    const parsed = parseArgs(argv.slice(1), command === "generate");
    if (!parsed.input) throw new CliError("--input is required");
    const inputStat = await stat(parsed.input).catch(() => undefined);
    if (!inputStat?.isFile()) throw new CliError("input must be a regular file");
    if (command === "validate") {
      const { value } = await readSpecFile(parsed.input);
      const diagnostics = validateSpec(value, parsed.options);
      if (diagnostics.length) { diagnostics.forEach((diagnostic) => console.error(`${diagnostic.pointer ?? "/"}: ${diagnostic.message}`)); return 1; }
      console.log(`valid OpenAPI ${String((value as any).openapi)} document`); return 0;
    }
    if (!parsed.output) throw new CliError("--output is required for generate");
    const result = await generate(parsed.input, parsed.output, { ...parsed.options, force: parsed.force });
    console.log(`generated ${result.operations} tool(s) in ${result.files} files: ${parsed.output}`); return 0;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof CliError ? 2 : 1;
  }
}

type Parsed = { input?: string; output?: string; force: boolean; options: GeneratorOptions & { force?: boolean } };
function parseArgs(args: string[], needsOutput: boolean): Parsed {
  const result: Parsed = { force: false, options: { strict: true } };
  const known = new Set(["--input", "-i", "--output", "-o", "--name", "--server-url", "--package-manager", "--include-deprecated", "--force", "--strict"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!known.has(arg)) throw new CliError(`unknown option or positional argument: ${arg}`);
    if (arg === "--include-deprecated") { result.options.includeDeprecated = true; continue; }
    if (arg === "--force") { result.force = true; continue; }
    if (arg === "--strict") { const value = args[index + 1]; if (value === "true" || value === "false") { index += 1; result.options.strict = value === "true"; } else result.options.strict = true; continue; }
    const value = args[++index]; if (!value || value.startsWith("-")) throw new CliError(`${arg} requires a value`);
    if (arg === "--input" || arg === "-i") result.input = value;
    else if (arg === "--output" || arg === "-o") result.output = value;
    else if (arg === "--name") result.options.projectName = value;
    else if (arg === "--server-url") result.options.serverUrl = value;
    else if (arg === "--package-manager") { if (!["npm", "pnpm", "yarn"].includes(value)) throw new CliError("--package-manager must be npm, pnpm, or yarn"); result.options.packageManager = value as GeneratorOptions["packageManager"]; }
  }
  if (needsOutput && !result.output) throw new CliError("--output is required for generate");
  return result;
}
class CliError extends Error {}
function help(): string { return `mcp-forge ${VERSION}\n\nUsage:\n  mcp-forge validate --input <spec.json|yaml>\n  mcp-forge generate --input <spec.json|yaml> --output <directory> [options]\n  mcp-forge --version\n\nOptions: --name <name> --server-url <url> --package-manager <npm|pnpm|yarn> --include-deprecated --strict <true|false> --force`; }

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
