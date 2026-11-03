import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { normalizeSpec, validateSpec } from "./parse.js";
import { renderProject } from "./render.js";
import type { GeneratorOptions } from "./model.js";

export async function generate(inputPath: string, outputPath: string, options: GeneratorOptions = {}): Promise<{ operations: number; files: number }> {
  const bytes = await readFile(inputPath);
  const parsed = await parseBytes(inputPath, bytes);
  const diagnostics = validateSpec(parsed, options);
  if (diagnostics.length) throw new Error(diagnostics.map((diagnostic) => `${diagnostic.pointer ?? "/"}: ${diagnostic.message}`).join("\n"));
  const spec = normalizeSpec(parsed as Record<string, unknown>, options);
  const inputHash = createHash("sha256").update(bytes).digest("hex");
  const files = renderProject(spec, inputHash, options.packageManager ?? "npm", options);
  const output = resolve(outputPath);
  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.${spec.projectName}.mcp-forge-${process.pid}-${Date.now()}`);
  await mkdir(temporary, { recursive: true });
  try {
    for (const [relative, content] of Object.entries(files)) {
      const target = join(temporary, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8");
    }
    let exists = false;
    try { await stat(output); exists = true; } catch { /* absent */ }
    if (exists) {
      if (!options.force) throw new Error(`output directory exists: ${output}; use --force only for a generated directory`);
      let manifest: string;
      try { manifest = await readFile(join(output, ".mcp-forge-manifest.json"), "utf8"); } catch { throw new Error("--force requires an existing .mcp-forge-manifest.json"); }
      if (!manifest.includes('"generatorVersion"')) throw new Error("--force requires an MCP Forge manifest");
      const backup = `${output}.mcp-forge-old-${process.pid}`;
      await rename(output, backup);
      try { await rename(temporary, output); } catch (error) { await rename(backup, output); throw error; }
      await rm(backup, { recursive: true, force: true });
    } else await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return { operations: spec.operations.length, files: Object.keys(files).length };
}

async function parseBytes(inputPath: string, bytes: Buffer): Promise<unknown> {
  try {
    if (inputPath.endsWith(".yaml") || inputPath.endsWith(".yml")) {
      const { parse } = await import("yaml");
      return parse(bytes.toString("utf8"));
    }
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) { throw new Error(`cannot parse input: ${error instanceof Error ? error.message : String(error)}`); }
}
