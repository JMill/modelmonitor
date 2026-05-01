#!/usr/bin/env tsx
import { fetchModels as fetchAnthropic } from "../src/providers/anthropic.ts";
import { fetchModels as fetchOpenAI } from "../src/providers/openai.ts";
import { fetchModels as fetchGoogle } from "../src/providers/google.ts";
import {
  buildManifest,
  diffManifests,
  MANIFEST_PATH,
  readManifest,
  writeManifest,
} from "../src/manifest.ts";
import {
  createIssue,
  formatIssueBody,
  postWebhook,
  type AlertContext,
} from "../src/alerts.ts";
import {
  Manifest,
  type AlertEntry,
  type ProviderId,
  type ProviderSnapshot,
} from "../src/types.ts";

const MANIFEST_URL = "https://jmill.github.io/modelmonitor/models.json";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

async function safeFetch(
  provider: ProviderId,
  fn: () => Promise<ProviderSnapshot>,
): Promise<{ snapshot?: ProviderSnapshot; error?: string }> {
  try {
    return { snapshot: await fn() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${provider}] fetch failed: ${msg}`);
    return { error: msg };
  }
}

async function main() {
  const repoOwner = process.env.GITHUB_REPOSITORY?.split("/")[0] ?? "JMill";
  const repoName =
    process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "modelmonitor";
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;

  const ctx: AlertContext = {
    repoOwner,
    repoName,
    runUrl,
    manifestUrl: MANIFEST_URL,
    webhookUrl: process.env.ALERT_WEBHOOK_URL,
    githubToken: process.env.GITHUB_TOKEN,
  };

  const alerts: AlertEntry[] = [];
  const providers: Manifest["providers"] = {};

  const [anthropic, openai, google] = await Promise.all([
    safeFetch("anthropic", () => fetchAnthropic(need("ANTHROPIC_API_KEY"))),
    safeFetch("openai", () => fetchOpenAI(need("OPENAI_API_KEY"))),
    safeFetch("google", () => fetchGoogle(need("GOOGLE_API_KEY"))),
  ]);
  if (anthropic.snapshot) providers.anthropic = anthropic.snapshot;
  else alerts.push({ kind: "provider_failed", provider: "anthropic", error: anthropic.error! });
  if (openai.snapshot) providers.openai = openai.snapshot;
  else alerts.push({ kind: "provider_failed", provider: "openai", error: openai.error! });
  if (google.snapshot) providers.google = google.snapshot;
  else alerts.push({ kind: "provider_failed", provider: "google", error: google.error! });

  const next = buildManifest(providers);
  try {
    Manifest.parse(next);
  } catch (err) {
    alerts.push({
      kind: "schema_invalid",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const prev = await readManifest(MANIFEST_PATH);
  const changes = diffManifests(prev, next);

  // Detect "no successor": a family that previously had a recommended is now empty.
  if (prev) {
    for (const [provider, prevSnap] of Object.entries(prev.providers) as [
      ProviderId,
      ProviderSnapshot,
    ][]) {
      const nextSnap = next.providers[provider];
      for (const [family, prevFam] of Object.entries(prevSnap.families)) {
        const nextFam = nextSnap?.families[family];
        if (!nextFam || nextFam.all.length === 0) {
          alerts.push({
            kind: "no_successor",
            provider,
            family,
            lost: prevFam.recommended,
          });
        }
      }
    }
  }

  await writeManifest(MANIFEST_PATH, next);

  console.log(`Wrote ${MANIFEST_PATH}`);
  console.log(`Changes: ${changes.length}, Alerts: ${alerts.length}`);
  for (const c of changes) console.log(" change:", c);
  for (const a of alerts) console.log(" alert:", a);

  if (alerts.length) {
    const title = `modelmonitor: ${alerts.length} alert(s) on ${new Date().toISOString().slice(0, 10)}`;
    const body = formatIssueBody(alerts, changes, ctx);
    await createIssue(title, body, ctx).catch((err) =>
      console.error("createIssue failed:", err),
    );
  }

  if (changes.length || alerts.length) {
    await postWebhook(
      {
        event: alerts.length ? "alert" : "manifest_updated",
        manifest_url: MANIFEST_URL,
        run_url: runUrl,
        changes,
        alerts,
      },
      ctx,
    ).catch((err) => console.error("postWebhook failed:", err));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
