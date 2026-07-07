import { Octokit } from "@octokit/rest";
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

export async function createIssue(
  title: string,
  body: string,
  ctx: AlertContext,
): Promise<void> {
  if (!ctx.githubToken) {
    console.warn("createIssue: no GITHUB_TOKEN; skipping");
    return;
  }
  const octokit = new Octokit({ auth: ctx.githubToken });
  await octokit.issues.create({
    owner: ctx.repoOwner,
    repo: ctx.repoName,
    title,
    body,
    labels: ["modelmonitor"],
  });
}

export async function postWebhook(
  payload: unknown,
  ctx: AlertContext,
): Promise<void> {
  if (!ctx.webhookUrl) return;
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
}
