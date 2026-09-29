#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import { Octokit } from "@octokit/rest";
import yaml from "js-yaml";
import { bumpProblems, publishBumpAlert } from "../src/alerts.ts";
import { MANIFEST_PATH, readManifest } from "../src/manifest.ts";
import { bumpAll } from "../src/pr-bumper.ts";
import { Registry } from "../src/types.ts";

// Exit codes: a broken registry or a missing manifest exits 1 (nothing can
// run, and the refresh workflow files its failure issue). Problems with
// individual consumers exit 0: they are collected into one alert issue so a
// single bad entry never blocks every other consumer's bump. If that issue
// can't be filed, the run exits 1 instead. A clean run closes the issue.
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
  for (const p of problems) console.warn(p);

  // The alert goes to this repo, where the workflow's GITHUB_TOKEN can write
  // issues; the bump token only needs access to consumer repos.
  const alertToken = process.env.GITHUB_TOKEN || process.env.BUMP_PR_TOKEN;
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "JMill/modelmonitor").split("/");
  const outcome = await publishBumpAlert(
    new Octokit({ auth: alertToken }),
    owner,
    repo,
    problems,
    runUrl,
  );
  console.log(`bump alert issue: ${outcome}`);
  if (outcome === "failed" && problems.length) {
    // The issue is the only place these problems are reported. Without it,
    // fail the run so it shows red (and the refresh workflow files its own
    // failure issue) rather than leaving them in a green run's log.
    console.log(
      `::error title=Bump alert not filed::${problems.length} push-mode problem(s) could not be filed as an issue; see the run log`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
