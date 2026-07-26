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
