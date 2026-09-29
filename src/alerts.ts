import { createHash } from "node:crypto";
import { Octokit } from "@octokit/rest";
import type { GroupResult } from "./pr-bumper.ts";
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
const FINGERPRINT_RE = /<!-- modelmonitor-fingerprint: ([0-9a-f]+) -->/;

export function formatBumpAlertBody(lines: string[], runUrl?: string): string {
  return [
    "Automated alert from modelmonitor push mode. These registry entries need attention:",
    "",
    ...lines,
    "",
    runUrl ? `Run: ${runUrl}` : "",
    `<!-- modelmonitor-fingerprint: ${fingerprintOf(lines)} -->`,
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n");
}

export type UpsertOutcome = "created" | "commented" | "unchanged";

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
  const issues = await octokit.paginate(octokit.issues.listForRepo, {
    owner,
    repo,
    state: "open",
    labels: "modelmonitor",
    per_page: 100,
  });
  const existing = issues.find((i) => !i.pull_request && i.title === title);
  if (!existing) {
    await octokit.issues.create({ owner, repo, title, body, labels: ["modelmonitor"] });
    return "created";
  }
  const fingerprint = body.match(FINGERPRINT_RE)?.[1];
  if (fingerprint) {
    const comments = await octokit.paginate(octokit.issues.listComments, {
      owner,
      repo,
      issue_number: existing.number,
      per_page: 100,
    });
    // The most recent report is the newest comment (or the issue body) that
    // carries a fingerprint; human replies in between don't count.
    const reports = [existing.body, ...comments.map((c) => c.body)];
    const lastReport = reports.reverse().find((b) => b && FINGERPRINT_RE.test(b));
    if (lastReport?.match(FINGERPRINT_RE)?.[1] === fingerprint) return "unchanged";
  }
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: existing.number,
    body,
  });
  return "commented";
}
