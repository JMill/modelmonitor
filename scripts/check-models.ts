#!/usr/bin/env tsx
import { fetchModels as fetchAnthropic } from "../src/providers/anthropic.ts";
import { fetchModels as fetchOpenAI } from "../src/providers/openai.ts";
import { fetchModels as fetchGoogle } from "../src/providers/google.ts";
import {
  buildManifest,
  diffManifests,
  holdUnclassifiedForRetry,
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
  type ProviderResult,
  type ProviderSnapshot,
} from "../src/types.ts";

const MANIFEST_URL = "https://jmill.github.io/modelmonitor/models.json";

// Each provider is optional: it runs only if its API key is configured.
// A missing key means "not enabled" and is skipped quietly; at least one
// provider must be configured or we alert (see below).
const PROVIDERS: {
  id: ProviderId;
  envKey: string;
  fetch: (apiKey: string) => Promise<ProviderResult>;
}[] = [
  { id: "anthropic", envKey: "ANTHROPIC_API_KEY", fetch: fetchAnthropic },
  { id: "openai", envKey: "OPENAI_API_KEY", fetch: fetchOpenAI },
  { id: "google", envKey: "GOOGLE_API_KEY", fetch: fetchGoogle },
];

async function safeFetch(
  provider: ProviderId,
  fn: () => Promise<ProviderResult>,
): Promise<{ result?: ProviderResult; error?: string }> {
  try {
    return { result: await fn() };
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
  const prev = await readManifest(MANIFEST_PATH);

  // Providers whose absence from `next` is expected, so the "no successor"
  // check below must not read it as "every family in this provider vanished".
  const unavailable = new Set<ProviderId>();

  // Unclassified IDs alerted on for the first time this run, kept so they can
  // be rolled back out of the manifest if the alert fails to deliver.
  const freshUnclassified = new Map<ProviderId, string[]>();

  let configuredCount = 0;
  await Promise.all(
    PROVIDERS.map(async (p) => {
      const apiKey = process.env[p.envKey];
      if (!apiKey) {
        console.log(`[${p.id}] ${p.envKey} not set; skipping (provider disabled)`);
        unavailable.add(p.id);
        return;
      }
      configuredCount++;
      const { result, error } = await safeFetch(p.id, () => p.fetch(apiKey));
      if (!result) {
        alerts.push({ kind: "provider_failed", provider: p.id, error: error! });
        unavailable.add(p.id);
        // Serve the last known good data rather than publishing a manifest
        // with the provider missing — consumers read this file directly, and
        // a transient 500 must not look like "Anthropic has no models".
        const stale = prev?.providers[p.id];
        if (stale) {
          console.warn(`[${p.id}] carrying forward previous snapshot`);
          providers[p.id] = stale;
        }
        return;
      }

      providers[p.id] = result.snapshot;
      if (result.unclassified.length) {
        result.snapshot.unclassified = result.unclassified;
        // Alert only on IDs we haven't already reported, so a permanently
        // unmatched line (an untracked model family) doesn't reopen an issue
        // every single morning.
        const known = new Set(prev?.providers[p.id]?.unclassified ?? []);
        const fresh = result.unclassified.filter((id) => !known.has(id));
        if (fresh.length) {
          alerts.push({
            kind: "unclassified_models",
            provider: p.id,
            models: fresh,
          });
          freshUnclassified.set(p.id, fresh);
        }
      }
    }),
  );

  if (configuredCount === 0) {
    alerts.push({
      kind: "no_providers_configured",
      error:
        "no provider API keys configured; set at least one of " +
        PROVIDERS.map((p) => p.envKey).join(", "),
    });
  }

  const next = buildManifest(providers);
  try {
    Manifest.parse(next);
  } catch (err) {
    alerts.push({
      kind: "schema_invalid",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const changes = diffManifests(prev, next);

  // Detect "no successor": a family that previously had a recommended is now
  // empty. Only meaningful for providers we actually heard back from — a
  // disabled or failed provider is reported by its own alert instead.
  if (prev) {
    for (const [provider, prevSnap] of Object.entries(prev.providers) as [
      ProviderId,
      ProviderSnapshot,
    ][]) {
      if (unavailable.has(provider)) continue;
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

  console.log(`Changes: ${changes.length}, Alerts: ${alerts.length}`);
  for (const c of changes) console.log(" change:", c);
  for (const a of alerts) console.log(" alert:", a);

  // Deliver before persisting: the manifest is also the dedup ledger for
  // unclassified alerts, so writing it first would mark an ID as reported even
  // when the report never left the building.
  let delivered = false;

  if (alerts.length) {
    const title = `modelmonitor: ${alerts.length} alert(s) on ${new Date().toISOString().slice(0, 10)}`;
    const body = formatIssueBody(alerts, changes, ctx);
    delivered = await createIssue(title, body, ctx).catch((err) => {
      console.error("createIssue failed:", err);
      return false;
    });
  }

  if (changes.length || alerts.length) {
    const posted = await postWebhook(
      {
        event: alerts.length ? "alert" : "manifest_updated",
        manifest_url: MANIFEST_URL,
        run_url: runUrl,
        changes,
        alerts,
      },
      ctx,
    ).catch((err) => {
      console.error("postWebhook failed:", err);
      return false;
    });
    delivered ||= posted;
  }

  // Either channel landing is enough — one durable record of the alert exists.
  if (freshUnclassified.size && !delivered) {
    for (const [provider, ids] of freshUnclassified) {
      console.warn(
        `[${provider}] alert not delivered; holding ${ids.length} unclassified ID(s) back to re-alert next run`,
      );
    }
    holdUnclassifiedForRetry(next, freshUnclassified);
  }

  await writeManifest(MANIFEST_PATH, next);
  console.log(`Wrote ${MANIFEST_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
