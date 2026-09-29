#!/usr/bin/env tsx
// Validate registry.yml. See src/registry-check.ts for what is checked.
//
//   npm run registry:check
//   npm run registry:check -- --local JMill/tee-site=/abs/path/to/tee-site \
//                             --local JMill/portfolio-sites=/abs/path/to/portfolio-sites
//
// Exits 1 on any YAML, schema, regex or unknown-family error, and in --local
// mode when an entry's file is missing or its pattern matches nothing.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MANIFEST_PATH, readManifest } from "../src/manifest.ts";
import { checkRegistry } from "../src/registry-check.ts";

function parseArgs(argv: string[]): { registry: string; locals: Map<string, string> } {
  const locals = new Map<string, string>();
  let registry = "registry.yml";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.split(/=(.*)/s, 2);
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--local") {
      const spec = value();
      const m = spec.match(/^([^/=\s]+\/[^/=\s]+)=(.+)$/);
      if (!m) throw new Error(`--local expects owner/repo=/path/to/checkout, got "${spec}"`);
      locals.set(m[1].toLowerCase(), resolve(m[2]));
    } else if (flag === "--registry") {
      registry = value();
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return { registry, locals };
}

async function main() {
  const { registry, locals } = parseArgs(process.argv.slice(2));
  const report = await checkRegistry({
    rawYaml: await readFile(registry, "utf8"),
    manifest: await readManifest(MANIFEST_PATH),
    locals,
    readLocal: async (root, file) => {
      try {
        return await readFile(join(root, file), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
  });
  for (const l of report.lines) console.log(l);
  for (const w of report.warnings) console.warn(`warning: ${w}`);
  for (const e of report.errors) console.error(`error: ${e}`);
  console.log(
    `registry:check ${report.errors.length ? "failed" : "passed"}: ${report.errors.length} error(s), ${report.warnings.length} warning(s)`,
  );
  if (report.errors.length) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
