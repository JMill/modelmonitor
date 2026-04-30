#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import { Octokit } from "@octokit/rest";
import yaml from "js-yaml";
import { MANIFEST_PATH, readManifest } from "../src/manifest.ts";
import { bumpEntry } from "../src/pr-bumper.ts";
import { Registry } from "../src/types.ts";

async function main() {
  const token = process.env.BUMP_PR_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("missing BUMP_PR_TOKEN (or GITHUB_TOKEN); skipping bump PRs");
    return;
  }
  const manifest = await readManifest(MANIFEST_PATH);
  if (!manifest) {
    console.error(`no manifest at ${MANIFEST_PATH}; run check-models first`);
    process.exit(1);
  }
  const raw = await readFile("registry.yml", "utf8");
  const registry = Registry.parse(yaml.load(raw));

  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;

  const octokit = new Octokit({ auth: token });
  for (const entry of registry.consumers) {
    try {
      const result = await bumpEntry(octokit, entry, manifest, runUrl);
      console.log(JSON.stringify(result));
    } catch (err) {
      console.error(`[${entry.repo}] failed:`, err);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
