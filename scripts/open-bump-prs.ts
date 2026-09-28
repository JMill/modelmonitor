#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import { Octokit } from "@octokit/rest";
import yaml from "js-yaml";
import {
  BUMP_ALERT_TITLE,
  bumpProblems,
  formatBumpAlertBody,
  upsertIssue,
} from "../src/alerts.ts";
import { MANIFEST_PATH, readManifest } from "../src/manifest.ts";
import { bumpAll } from "../src/pr-bumper.ts";
import { Registry } from "../src/types.ts";

// Exit codes: a broken registry or a missing manifest exits 1 (nothing can
// run, and the refresh workflow files its failure issue). Problems with
// individual consumers exit 0: they are collected into one alert issue so a
// single bad entry never blocks every other consumer's bump.
async function main() {
  const raw = await readFile("registry.yml", "utf8");
  const registry = Registry.parse(yaml.load(raw));
  if (!registry.consumers.length) {
    console.log("registry.yml has no consumers; nothing to bump");
    return;
  }

  // `||`, not `??`: Actions passes an unset secret as an empty string.
  const token = process.env.BUMP_PR_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("missing BUMP_PR_TOKEN (or GITHUB_TOKEN); skipping bump PRs");
    return;
  }
  const manifest = await readManifest(MANIFEST_PATH);
  if (!manifest) {
    console.error(`no manifest at ${MANIFEST_PATH}; run check-models first`);
    process.exit(1);
  }

  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;

  const octokit = new Octokit({ auth: token });
  const results = await bumpAll(octokit, registry.consumers, manifest, runUrl);
  for (const r of results) {
    const { file_results, ...summary } = r;
    console.log(
      JSON.stringify({
        ...summary,
        files: file_results.map((f) => `${f.file}: ${f.status}`),
      }),
    );
  }

  const problems = bumpProblems(results);
  if (!problems.length) return;
  for (const p of problems) console.warn(p);

  // The alert goes to this repo, where the workflow's GITHUB_TOKEN can write
  // issues; the bump token only needs access to consumer repos.
  const alertToken = process.env.GITHUB_TOKEN || process.env.BUMP_PR_TOKEN;
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "JMill/modelmonitor").split("/");
  try {
    const outcome = await upsertIssue(
      new Octokit({ auth: alertToken }),
      owner,
      repo,
      BUMP_ALERT_TITLE,
      formatBumpAlertBody(problems, runUrl),
    );
    console.log(`bump alert issue: ${outcome}`);
  } catch (err) {
    console.error("could not file the bump alert issue:", err);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
