# modelmonitor

Single source of truth for "what's the current Claude / OpenAI / Gemini model?".
A daily GitHub Actions cron queries each provider's `/models` endpoint and
publishes a normalized manifest. Consumer apps can either fetch it (pull) or
subscribe to automatic bump PRs against their repo (push).

- Manifest URL: <https://jmill.github.io/modelmonitor/models.json>
- JSON Schema: <https://jmill.github.io/modelmonitor/schema.json>

## Pull mode

Fetch the manifest at build time or boot time and read the recommended ID for
the family you want.

```bash
curl -s https://jmill.github.io/modelmonitor/models.json \
  | jq -r '.providers.anthropic.families.sonnet.recommended'
# → claude-sonnet-5
```

```ts
const r = await fetch("https://jmill.github.io/modelmonitor/models.json");
const manifest = await r.json();
const sonnet = manifest.providers.anthropic.families.sonnet.recommended;
```

The manifest's `recommended` is "latest non-deprecated model in the family,
sorted by `created_at` desc." Cache it locally; fall back to a hardcoded
default if the fetch fails.

### Manifest shape

```jsonc
{
  "$schema": "https://jmill.github.io/modelmonitor/schema.json",
  "version": "1",
  "generated_at": "2026-04-30T09:00:00Z",
  "providers": {
    "anthropic": {
      "families": {
        "sonnet": {
          "recommended": "claude-sonnet-5",
          "all": [{ "id": "claude-sonnet-5", "created_at": "...", "deprecated": false }]
        }
      }
    },
    "openai": { "families": { "gpt-5": { ... }, "gpt-4o": { ... }, "o-series": { ... } } },
    "google": { "families": { "gemini-2.0-flash": { ... } } }
  }
}
```

Family keys are stable once published:

| Provider    | Keys                                                                       |
| ----------- | -------------------------------------------------------------------------- |
| `anthropic` | Derived from the model ID — `opus`, `sonnet`, `haiku`, `fable`, `mythos`, … |
| `openai`    | `gpt-5`, `gpt-4o`, `gpt-4.1`, `gpt-4`, `gpt-3.5`, `o-series`, `chatgpt`     |
| `google`    | `gemini-<version>(-{flash,pro,nano,ultra})?`                                |

Anthropic keys are read off the ID (`claude-<family>-<version>`), so a newly
released family shows up on the next refresh without a code change. OpenAI
keys are deliberately curated instead: `gpt-5` collects `gpt-5`, `gpt-5.1`,
`gpt-5.5`… under one key so a pinned `openai.gpt-5` doesn't fragment on a
point release.

### When a model matches nothing

Any model a provider returns that no family rule matches is listed under that
provider's `unclassified` array and raises an alert on the run that first sees
it. That array is a diagnostic — consumers should read `families` and ignore
it — but it means a naming change can never quietly drop a model from the
manifest the way it could before.

Alerting is **at-least-once**. That array doubles as the ledger of what has
already been reported, so an ID is only recorded once its alert has actually
been delivered (issue filed or webhook accepted). If delivery fails, the ID is
held back and re-alerted on the next run rather than being marked as seen — a
single dropped notification can't permanently silence the signal. The flip side
is that a repeatedly-undelivered ID stays out of `unclassified` until an alert
lands.

## Push mode

Add your repo to [`registry.yml`](./registry.yml) and modelmonitor will open a
`chore: bump <family> to <id>` PR against it whenever the recommended ID for
that family changes.

```yaml
consumers:
  - repo: JMill/portfolio-sites
    file: scripts/generate-content.ts
    pattern: 'model:\s*"claude-sonnet-[\w\-]+"'
    replacement_template: 'model: "{recommended}"'
    family: anthropic.sonnet
    branch_prefix: chore/model-bump
    reviewers: [JMill]
```

PRs are idempotent — if a PR already exists for the same `<branch_prefix>/<family>-<id>`,
no duplicate is opened.

## Alerts

When a previously-recommended model disappears with no successor, a model
matches no family rule, or any provider's API call fails, modelmonitor:

1. Opens a GitHub issue in this repo (label `modelmonitor`).
2. POSTs to `ALERT_WEBHOOK_URL` (if configured) with this payload:

```json
{
  "event": "alert" | "manifest_updated",
  "manifest_url": "https://jmill.github.io/modelmonitor/models.json",
  "run_url": "...",
  "changes": [...],
  "alerts": [...]
}
```

### Behaviour when a provider is down

A provider whose API call fails keeps its **previous snapshot** in the
published manifest, alongside a `provider_failed` alert. A transient outage
therefore never republishes the manifest with that provider's models missing —
consumers fetching `models.json` mid-incident get stale data rather than an
empty `families` object. A provider with no API key configured is treated as
intentionally disabled and is simply absent.

## Configuration

Set these in repo Settings → Secrets and variables → Actions:

| Secret              | Required | Purpose                                                                       |
| ------------------- | -------- | ----------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | yes      | Read-only `models.list()` call                                                |
| `OPENAI_API_KEY`    | yes      | Read-only `models.list()` call                                                |
| `GOOGLE_API_KEY`    | yes      | Read-only `GET /v1beta/models`                                                |
| `BUMP_PR_TOKEN`     | yes\*    | Fine-grained PAT with `Contents: write` + `Pull requests: write` on consumers |
| `ALERT_WEBHOOK_URL` | no       | Webhook URL receives alert + change events                                    |

\* Required only if `registry.yml` has consumers.

## Local development

```bash
nvm use
npm ci
npm run typecheck
npm test

# Dry run against the live APIs (writes docs/models.json locally)
ANTHROPIC_API_KEY=… OPENAI_API_KEY=… GOOGLE_API_KEY=… npm run check
```

## Layout

```
src/
  types.ts             # zod schemas + types
  manifest.ts          # buildManifest / diffManifests / atomic write
  alerts.ts            # createIssue + postWebhook
  pr-bumper.ts         # idempotent bump PR per registry entry
  providers/
    anthropic.ts
    openai.ts
    google.ts
scripts/
  check-models.ts      # cron entry: refresh manifest + alert
  open-bump-prs.ts     # cron entry: open bump PRs from registry
docs/
  models.json          # served at https://jmill.github.io/modelmonitor/models.json
  schema.json
  index.html
.github/workflows/
  refresh.yml          # daily 09:00 UTC
  pages.yml            # deploy /docs to Pages on change
  ci.yml               # typecheck + vitest on PRs
```

## License

MIT
