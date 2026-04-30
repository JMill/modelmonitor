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
# → claude-sonnet-4-6
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
          "recommended": "claude-sonnet-4-6",
          "all": [{ "id": "claude-sonnet-4-6", "created_at": "...", "deprecated": false }]
        }
      }
    },
    "openai": { "families": { "gpt-5": { ... }, "gpt-4o": { ... }, "o-series": { ... } } },
    "google": { "families": { "gemini-2.0-flash": { ... } } }
  }
}
```

Family keys are stable: `anthropic.{opus,sonnet,haiku}`,
`openai.{gpt-5,gpt-4o,gpt-4.1,gpt-4,gpt-3.5,o-series,chatgpt}`,
`google.gemini-<version>(-{flash,pro,nano,ultra})?`.

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

When a previously-recommended model disappears with no successor, or any
provider's API call fails, modelmonitor:

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
