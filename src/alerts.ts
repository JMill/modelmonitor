import { createHash } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { reposNeedingBumpToken, type GroupResult } from "./pr-bumper.ts";
import type { AlertEntry, DiffEntry } from "./types.ts";

export interface AlertContext {
  repoOwner: string;
  repoName: string;
  runUrl?: string;
  manifestUrl: string;
  webhookUrl?: string;
  githubToken?: string;
}

export function formatIssueBody(
  alerts: AlertEntry[],
  changes: DiffEntry[],
  ctx: AlertContext,
): string {
  const lines: string[] = [];
  lines.push("Automated alert from modelmonitor.", "");
  if (ctx.runUrl) lines.push(`Run: ${ctx.runUrl}`);
  lines.push(`Manifest: ${ctx.manifestUrl}`, "");
  if (alerts.length) {
    lines.push("## Alerts");
    for (const a of alerts) {
      if (a.kind === "provider_failed") {
        lines.push(`- provider \`${a.provider}\` failed: ${a.error}`);
      } else if (a.kind === "no_successor") {
        lines.push(
          `- \`${a.provider}.${a.family}\`: previously-recommended \`${a.lost}\` is gone with no successor`,
        );
      } else if (a.kind === "unclassified_models") {
        lines.push(
          `- \`${a.provider}\`: ${a.models.length} model(s) matched no family rule and are missing from the manifest — ` +
            a.models.map((m) => `\`${m}\``).join(", "),
        );
      } else if (a.kind === "no_providers_configured") {
        lines.push(`- no providers configured: ${a.error}`);
      } else {
        lines.push(`- schema invalid: ${a.error}`);
      }
    }
    lines.push("");
  }
  if (changes.length) {
    lines.push("## Changes");
    for (const c of changes) {
      if (c.kind === "recommended_changed") {
        lines.push(
          `- \`${c.provider}.${c.family}\` recommended: \`${c.from}\` → \`${c.to}\``,
        );
      } else {
        lines.push(`- ${c.kind}: \`${c.provider}.${c.family}\` ${c.model}`);
      }
    }
  }
  return lines.join("\n");
}

// Returns true only when the issue was actually filed. Callers use this to
// decide whether it is safe to record that an alert has been announced — an
// unconfigured token is "not delivered", not "nothing to do".
export async function createIssue(
  title: string,
  body: string,
  ctx: AlertContext,
): Promise<boolean> {
  if (!ctx.githubToken) {
    console.warn("createIssue: no GITHUB_TOKEN; skipping");
    return false;
  }
  const octokit = new Octokit({ auth: ctx.githubToken });
  await octokit.issues.create({
    owner: ctx.repoOwner,
    repo: ctx.repoName,
    title,
    body,
    labels: ["modelmonitor"],
  });
  return true;
}

// Returns true only when the webhook accepted the payload. An unconfigured
// URL is false for the same reason as above.
export async function postWebhook(
  payload: unknown,
  ctx: AlertContext,
): Promise<boolean> {
  if (!ctx.webhookUrl) return false;
  const res = await fetch(ctx.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(
      `webhook POST failed: ${res.status} ${res.statusText}`,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Push-mode alerts

export const BUMP_ALERT_TITLE = "modelmonitor: bump PRs need attention";

// One markdown line per problem worth a human's attention: a group that
// failed, a file whose pattern matched nothing (the consumer refactored and
// its pin is no longer tracked), a file that could not be read, a registry
// entry naming a repo GitHub has since renamed, a bump held back because the
// alias it writes is unavailable, and a declined bump whose pinned model the
// provider no longer lists. Routine outcomes (opened, current, existing PR,
// declined) are not problems.
// The one problem line for a run that has no BUMP_PR_TOKEN but consumers in
// other repositories: without it every bump fails with GitHub's bare 404.
export function missingBumpTokenProblem(repos: string[], thisRepo: string | undefined): string {
  const list = repos.map((r) => `\`${r}\``).join(", ");
  const own = thisRepo ? `\`${thisRepo}\`` : "the repository running the workflow";
  return `- \`BUMP_PR_TOKEN\` is not set, and the workflow's own token can only reach ${own}, so no bump PR can open for ${list}. Create a fine-grained token with Contents and Pull requests read and write access to ${repos.length === 1 ? "that repository" : "those repositories"} and save it as this repository's \`BUMP_PR_TOKEN\` secret.`;
}

// The problem lines for a push-mode run. `missingBumpToken` is true for a run
// in GitHub Actions without BUMP_PR_TOKEN, where the workflow's own
// GITHUB_TOKEN can write only to `thisRepo`: every consumer elsewhere either
// 404s (private) or can be read but never bumped (public), so the missing
// secret is reported once for all of them, and a group that happens to be
// current can't close the alert while it is still missing. Only the failures
// the token causes (a 404, a refused write) fold into that line; a pattern
// that matches nothing, an unreadable file or a rename in one of those repos
// is still reported, so adding the secret doesn't uncover a second problem a
// run later.
export function pushModeProblems(
  results: GroupResult[],
  thisRepo: string | undefined,
  missingBumpToken: boolean,
): string[] {
  if (!missingBumpToken) return bumpProblems(results);
  const needing = reposNeedingBumpToken(results, thisRepo);
  if (!needing.length) return bumpProblems(results);
  const blocked = new Set(needing.map((r) => r.toLowerCase()));
  const tokenFailure = (r: GroupResult) =>
    Boolean(r.unreachable || r.denied) &&
    blocked.has((r.unreachable ? r.repo : (r.resolved_repo ?? r.repo)).toLowerCase());
  // Drop just the token's error from those results; a rename they carry is
  // still reported.
  return [
    missingBumpTokenProblem(needing, thisRepo),
    ...bumpProblems(results.map((r) => (tokenFailure(r) ? { ...r, error: undefined } : r))),
  ];
}

export function bumpProblems(results: GroupResult[]): string[] {
  const lines: string[] = [];
  for (const r of results) {
    const where = `\`${r.repo}\` \`${r.family}\``;
    if (r.status === "failed" && r.error) {
      lines.push(`- ${where}: bump failed: ${r.error}`);
    }
    if (r.status === "skipped_no_alias") {
      lines.push(
        `- ${where}: bump skipped: ${r.error}. It retries on the next refresh; if the model has no alias, switch the template to {recommended}.`,
      );
    }
    for (const f of r.file_results) {
      if (f.status === "no_match") {
        lines.push(
          `- ${where} \`${f.file}\`: pattern matched nothing, so this pin is no longer tracked. Fix the registry entry or the file.`,
        );
      } else if (f.status === "error" && !(r.status === "failed" && r.error)) {
        lines.push(`- ${where} \`${f.file}\`: ${f.error}`);
      }
    }
    if (r.resolved_repo) {
      lines.push(
        `- ${where}: GitHub now names this repo \`${r.resolved_repo}\` (renamed or transferred). Bumps still run against it; update registry.yml.`,
      );
    }
    if (r.status === "skipped_declined" && r.unserved.length) {
      lines.push(
        `- ${where}: the bump PR was declined (${r.url}), but ${r.unserved.map((id) => `\`${id}\``).join(", ")} is no longer listed by the provider.`,
      );
    }
  }
  return [...new Set(lines)];
}

const fingerprintOf = (lines: string[]) =>
  createHash("sha256").update([...lines].sort().join("\n")).digest("hex").slice(0, 16);
// The all-clear note carries a sentinel instead of a hash, so the next
// report after it always counts as new, even when it lists the very
// problems that were reported before the all clear.
const ALL_CLEAR = "all-clear";
const FINGERPRINT_RE = /<!-- modelmonitor-fingerprint: ([0-9a-f]+|all-clear) -->/;
const fingerprintLine = (fp: string) => `<!-- modelmonitor-fingerprint: ${fp} -->`;

export function formatBumpAlertBody(lines: string[], runUrl?: string): string {
  return [
    "Automated alert from modelmonitor push mode. These registry entries need attention:",
    "",
    ...lines,
    "",
    runUrl ? `Run: ${runUrl}` : "",
    fingerprintLine(fingerprintOf(lines)),
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n");
}

export function formatAllClearBody(runUrl?: string): string {
  return [
    "All clear: every push-mode registry entry bumped cleanly or is already current. Closing this issue; the next problem opens a fresh one.",
    "",
    ...(runUrl ? [`Run: ${runUrl}`] : []),
    fingerprintLine(ALL_CLEAR),
  ].join("\n");
}

export type UpsertOutcome = "created" | "commented" | "unchanged";

interface AlertIssue {
  number: number;
  body?: string | null;
}

// The open issue filed under `title`. GitHub's issue list includes pull
// requests, which never count.
async function findOpenIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  title: string,
): Promise<AlertIssue | undefined> {
  const issues = await octokit.paginate(octokit.issues.listForRepo, {
    owner,
    repo,
    state: "open",
    labels: "modelmonitor",
    per_page: 100,
  });
  return issues.find((i) => !i.pull_request && i.title === title);
}

// The fingerprint of the most recent report on the issue: the newest comment
// (or the issue body) that carries one. Human replies in between don't count.
async function lastFingerprint(
  octokit: Octokit,
  owner: string,
  repo: string,
  issue: AlertIssue,
): Promise<string | undefined> {
  const comments = await octokit.paginate(octokit.issues.listComments, {
    owner,
    repo,
    issue_number: issue.number,
    per_page: 100,
  });
  const reports = [issue.body, ...comments.map((c) => c.body)];
  const lastReport = reports.reverse().find((b) => b && FINGERPRINT_RE.test(b));
  return lastReport?.match(FINGERPRINT_RE)?.[1];
}

// File `body` under `title`, at most one open issue per title: when one is
// already open, comment on it instead of opening a duplicate, and stay quiet
// when the latest report there has the same problem fingerprint (a
// persistent problem is reported once, not every morning).
export async function upsertIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  title: string,
  body: string,
): Promise<UpsertOutcome> {
  const existing = await findOpenIssue(octokit, owner, repo, title);
  if (!existing) {
    await octokit.issues.create({ owner, repo, title, body, labels: ["modelmonitor"] });
    return "created";
  }
  const fingerprint = body.match(FINGERPRINT_RE)?.[1];
  if (fingerprint && (await lastFingerprint(octokit, owner, repo, existing)) === fingerprint) {
    return "unchanged";
  }
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: existing.number,
    body,
  });
  return "commented";
}

// A run with no problems while the alert issue is open: post the all clear
// (unless a previous run already did and only the close failed) and close
// the issue, so the next problem, even one reported before, alerts again.
export async function resolveIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  title: string,
  runUrl?: string,
): Promise<"resolved" | "none"> {
  const existing = await findOpenIssue(octokit, owner, repo, title);
  if (!existing) return "none";
  if ((await lastFingerprint(octokit, owner, repo, existing)) !== ALL_CLEAR) {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: existing.number,
      body: formatAllClearBody(runUrl),
    });
  }
  await octokit.issues.update({
    owner,
    repo,
    issue_number: existing.number,
    state: "closed",
    state_reason: "completed",
  });
  return "resolved";
}

export type AlertOutcome = UpsertOutcome | "resolved" | "none" | "failed";

// Report this run's push-mode problems (or their absence) on the alert
// issue. Never throws: "failed" means the issue could not be updated, and
// the caller decides whether that should fail the run.
export async function publishBumpAlert(
  octokit: Octokit,
  owner: string,
  repo: string,
  problems: string[],
  runUrl?: string,
): Promise<AlertOutcome> {
  try {
    return problems.length
      ? await upsertIssue(octokit, owner, repo, BUMP_ALERT_TITLE, formatBumpAlertBody(problems, runUrl))
      : await resolveIssue(octokit, owner, repo, BUMP_ALERT_TITLE, runUrl);
  } catch (err) {
    console.error(
      `could not ${problems.length ? "file" : "close"} the bump alert issue:`,
      err instanceof Error ? err.message : err,
    );
    return "failed";
  }
}
