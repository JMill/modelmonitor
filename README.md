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

How `recommended` is chosen: within a family, the largest size tier wins (a
flagship outranks its `-mini`, `-lite` and `-nano` siblings), then the newest
`created_at` (Google publishes no timestamps, so its IDs are compared
numerically instead). It is **not** a deprecation-aware pick: no provider's
models endpoint reports deprecation, so `deprecated` is always `false`, and a
retired model simply stops being listed. Cache the value locally and fall back
to a hardcoded default if the fetch fails.

`recommended` reflects what modelmonitor's own API keys can list. A model
your organization can't call may still be recommended, and a family the
monitoring keys can't see (for example `anthropic.mythos`) is absent.

Some Anthropic models are listed only under a dated ID. When the Models API
confirms an undated alias for the recommended one, the family carries it as
`recommended_alias`; prefer it when pinning, so your pin reads the way the
docs spell it and doesn't churn:

```bash
curl -s https://jmill.github.io/modelmonitor/models.json \
  | jq -r '.providers.anthropic.families.haiku | .recommended_alias // .recommended'
# → claude-haiku-4-5
```

### Manifest shape

```jsonc
{
  "$schema": "https://jmill.github.io/modelmonitor/schema.json",
  "version": "1",
  "generated_at": "2026-09-28T09:00:00Z",
  "providers": {
    "anthropic": {
      "families": {
        "haiku": {
          "recommended": "claude-haiku-4-5-20251001",
          "recommended_alias": "claude-haiku-4-5",          // optional
          "all": [
            {
              "id": "claude-haiku-4-5-20251001",
              "display_name": "Claude Haiku 4.5",
              "created_at": "2025-10-15T00:00:00Z",
              "deprecated": false,                          // always false today
              "max_input_tokens": 200000,                   // optional, may be null
              "max_tokens": 64000,                          // optional, may be null
              "capabilities": { "thinking": { ... }, ... }, // optional raw tree, may be null
              "aliases": ["claude-haiku-4-5"]               // optional
            }
          ]
        }
      }
    },
    "openai": { "families": { "gpt-5": { ... }, "gpt-4o": { ... }, "o-series": { ... } } },
    "google": { "families": { "gemini-2.0-flash": { ... } } } // only when GOOGLE_API_KEY is set
  }
}
```

Every field marked optional was added after the first published manifest,
so a v1 manifest without them is still valid. `max_input_tokens`,
`max_tokens`, `capabilities` and `aliases` are Anthropic-only: the limits and
the capability tree come straight from the Models API (`capabilities` is
passed through unmodified; its leaves are `{ "supported": boolean }`), and an
alias is published only when `models.retrieve(alias)` resolves back to that
exact dated ID. `docs/schema.json` and the zod schema in `src/types.ts`
describe the same shape, and a test fails if they drift.

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

List a file in [`registry.yml`](./registry.yml) and modelmonitor opens a pull
request against your repo whenever that file pins an older model than the
family's `recommended` one.

### Pin each ID once, and anchor the pattern on it

Keep one constants file with one line per family, and give each registry
entry a pattern anchored on that line's key:

```ts
// src/models.ts
export const CLAUDE_MODELS = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
} as const;
```

```yaml
consumers:
  - repo: JMill/example
    file: src/models.ts
    family: anthropic.sonnet
    pattern: '(\bsonnet:\s*["''])claude-sonnet-[a-z0-9-]+(["''])'
    replacement_template: '$1{recommended}$2'
  - repo: JMill/example
    file: src/models.ts
    family: anthropic.haiku
    pattern: '(\bhaiku:\s*["''])claude-haiku-[a-z0-9-]+(["''])'
    replacement_template: '$1{recommended_alias}$2'
```

Other shapes work the same way: `(const MODEL = ")claude-sonnet-[a-z0-9-]+(")`
for a single constant, `(\bSONNET\s*=\s*["'])claude-sonnet-[a-z0-9-]+(["'])`
for a Python mirror (quotes doubled inside a single-quoted YAML string, as
below).

An unanchored `claude-sonnet-[\w-]+` is a trap: it also rewrites comments
("claude-sonnet-4-6's 1,024-token cache minimum" silently becomes false),
docs, and test mocks such as `claude-opus-4-7-mock`. Never enroll a file that
lists many IDs on purpose (pricing tables, allowlists, capability maps): a
global replace would collapse every entry into the recommended ID.

**YAML quoting.** Inside a single-quoted YAML string a backslash is literal,
so `\b` and `\s` are written as is, but a single quote must be doubled:
`["'']` is the character class `["']`. A lone `'` ends the string early and
the whole registry fails to parse, which stops every consumer's bump that
day; `npm run registry:check` (run in CI) catches it. In a double-quoted YAML
string, double every backslash instead.

### Fields

| Field                  | Required | Meaning                                                                                            |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `repo`                 | yes      | `owner/repo`, writable by `BUMP_PR_TOKEN`                                                          |
| `file`                 | yes      | Path from the repo root, e.g. `src/models.ts`: no leading `/`, `.` or `..` segments, or empty ones |
| `family`               | yes      | `<provider>.<family>` as published, split on the first dot (`anthropic.sonnet`, `openai.gpt-4.1`)  |
| `pattern`              | yes      | JavaScript regex, matched globally; must not match the empty string                                |
| `flags`                | no       | Extra regex flags, any of `i`, `m`, `s`, `u`                                                       |
| `replacement_template` | yes      | Replacement for each match; must contain `{recommended}` or `{recommended_alias}`                  |
| `branch_prefix`        | no       | Branch namespace, default `chore/model-bump`                                                       |
| `reviewers`            | no       | GitHub usernames to request review from; never the `BUMP_PR_TOKEN` owner (see below)               |
| `title_template`       | no       | PR title; `{family}`, `{recommended}`, `{from}` and `{to}` are substituted                         |
| `commit_template`      | no       | Commit message, same placeholders. Use it for repo rules such as a `[deploy]` tag                  |

(`repo`, `file`, `family`) must be unique across the registry.

The account that owns `BUMP_PR_TOKEN` authors every bump PR, and GitHub
won't request a review from a PR's author: it rejects the whole request
with a 422, so nobody else would be asked either. modelmonitor drops the
author from `reviewers` before asking, but don't list that account; name
the teammates who should review instead, or leave `reviewers` out and rely
on the repo's CODEOWNERS or notifications.

### Placeholders and capture groups

- `{recommended}` is the family's `recommended` ID.
- `{recommended_alias}` is its verified undated alias (`claude-haiku-4-5`
  rather than `claude-haiku-4-5-20251001`), falling back to `{recommended}`
  when the recommended ID is undated. When it is dated and the manifest has
  no alias for it (the refresh's alias lookup failed, or the model has none
  yet), a bump that would write it is skipped for that run and reported in
  the alert issue, rather than pinning the dated snapshot for good.
- Every occurrence of each placeholder is substituted.
- The template is otherwise a `String.replace` replacement string: `$1`,
  `$<name>`, `$&` and `$$` expand against the match (write a literal `$` as
  `$$`). IDs are inserted after that expansion, so nothing in an ID is ever
  read as a `$` sequence, and `$1{recommended}` is safe for any ID.
- Write the template so its literal parts reproduce the text around the ID;
  capture groups do this for you. That is how modelmonitor isolates the
  pinned ID to compare it with the recommendation. A template that reframes
  the match (say, `'…'` becomes `"…"`) still recognises a current pin held
  in a capture group, but `registry:check --local` warns about it, since
  retired pins then go unflagged.
- In `title_template` / `commit_template`, `{from}` is the pinned ID(s)
  being replaced and `{to}` the ID(s) written, which differs from
  `{recommended}` when `{recommended_alias}` is used.

### When a pin counts as current

A pinned ID is current, and the file is left alone, when it equals
`recommended`, is one of the recommended model's published `aliases`, or,
for a manifest without alias data, is the undated form of a dated
`recommended` ID. So `claude-haiku-4-5` is never "bumped" to
`claude-haiku-4-5-20251001`, which is the same model.

### One PR per repo and family

Entries that share (`repo`, `family`, `branch_prefix`) are bumped together:
one PR carries every file's change. It is built as a single commit with the
git data API on the default branch's current head, the same commit the files
were read from, so a concurrent push is never overwritten. The branch is
`<branch_prefix>/<provider.family>/<recommended>`, for example
`chore/model-bump/anthropic.sonnet/claude-sonnet-5`.

Different families get separate PRs, even in the same file. They touch
neighbouring lines, so when two are open at once, merging one can leave the
other needing a rebase.

The default title leads with the upgrade ("Upgrade Claude Sonnet calls to
claude-sonnet-5, the recommended model"). Where the entries in one PR set
different `title_template` or `commit_template` values, the first entry's
wins (`registry:check` warns). The PR body lists every file and line changed
with links, warns when a pinned ID is no longer listed by the provider, and
for Claude families adds a pre-merge checklist of the request-shape rules
the new model enforces (sampling parameters, adaptive thinking and effort,
`max_tokens` headroom, reading text by block type, `refusal` and
`max_tokens` stop reasons, forced `tool_choice`), linking the migration
guide. A bump is a string swap; the checklist is what keeps it from shipping
a 400.

### Existing, declined and superseded PRs

- **Open PR for the branch**: left alone, never force-pushed. Push fixes to
  it freely.
- **Closed without merging** by a person: treated as the repo opting out of
  that ID for that family. It is not reopened; the next recommended ID opens
  a new PR. Older bump PRs for the family that are still open are closed,
  since they pin an ID that is no longer recommended either.
- **Branch left without a PR** (a failed run, a merged PR whose branch
  wasn't deleted): reset to a fresh commit and reused.
- **Newer recommendation while an older bump PR is open**: the new PR opens
  and the older one is closed with a comment linking it. modelmonitor marks
  a PR it closes this way (`<!-- modelmonitor:superseded -->` at the end of
  its body), so if the recommendation later returns to that ID, a fresh PR
  opens instead of the close being read as an opt-out.
- **A failure mid-run** undoes only what that run did: a branch it created
  is deleted, a branch it reset goes back to its previous commit. A branch
  that existed before the run is never deleted.
- **Renamed or transferred repo**: bumps use the name GitHub reports today,
  and the alert issue asks for `registry.yml` to be updated.
- **A file in the group matches nothing or can't be read**: no PR opens for
  the whole group. Its files change together (consumers hold mirrors equal
  with drift tests), so a partial bump would only fail their CI. The alert
  issue names the file to fix, and the next run bumps the group once it
  matches again.

### Push-mode alerts

Groups that failed (including a family missing from the manifest), files
whose pattern matched nothing, files that couldn't be read, alias bumps held
back for want of an alias, repos GitHub now knows by another name, and
declined PRs whose pinned model is no longer listed are collected into one
issue per run in this repo, titled `modelmonitor: bump PRs need attention`.
While that issue is open, later runs comment on it instead of opening
duplicates, and stay quiet when the set of problems hasn't changed. The
first run with no problems posts an all clear and closes the issue, so a
problem that comes back later alerts again.

Per-entry problems don't fail the run, as long as the alert issue is filed.
The run fails (with an Actions error annotation) if the issue can't be
filed, and also on a registry that doesn't parse or a missing manifest.

### Checking the registry

```bash
npm run registry:check
# also read each entry's file from local checkouts:
npm run registry:check -- --local JMill/example=/abs/path/to/example
```

The plain check parses the YAML, runs the schema (compiled patterns,
placeholders, unique entries) and fails on any family missing from
`docs/models.json`. With `--local owner/repo=/path` (repeatable) it also
reports, per entry, the match count (zero fails the check), the pinned
IDs, and whether a bump would change the file today, using the bumper's own
rules.

### Enrolled consumers

Each repo keeps one canonical model-ID file, plus mirrors where a runtime
boundary forces a copy. Every file its drift or parity test holds equal is
enrolled under one `branch_prefix`, so a family's PR bumps all of that
repo's copies at once and the test stays green: at most one PR per repo and
family.

| Repo                    | File                                               | Families            |
| ----------------------- | -------------------------------------------------- | ------------------- |
| `JMill/tee-site`        | `packages/shared-types/src/models.ts` (canonical)  | opus, sonnet, haiku |
| `JMill/tee-site`        | `apps/book-engine/src/claude-models.ts`            | opus, sonnet        |
| `JMill/tee-site`        | `apps/sigline/src/lib/claude-models.ts`            | sonnet              |
| `JMill/tee-site`        | `apps/conduit/src/lib/claude-models.ts`            | sonnet              |
| `JMill/tee-site`        | `apps/id/src/lib/claude-models.ts`                 | haiku               |
| `JMill/tee-site`        | `scripts/claude_models.py`                         | sonnet              |
| `JMill/tee-site`        | `Flare/config.json` (`generation.model`)           | sonnet              |
| `JMill/UAPNOW`          | `agents/shared/src/models.ts` (canonical)          | opus, sonnet, haiku |
| `JMill/UAPNOW`          | `agents/ingest/src/uapnow_ingest/claude_models.py` | haiku               |
| `JMill/portfolio-sites` | `scripts/_shared/models.ts` (canonical)            | sonnet              |

Haiku entries write the undated alias (`claude-haiku-4-5`). tee-site's
commit subjects end in `[deploy]`, since it builds Vercel previews only for
commits that ask. The tests that hold copies equal are tee-site's
`scripts/__tests__/claude-models-mirrors.test.ts` and UAPNOW's
`agents/shared/tests/claude-models-python-parity.test.ts`; portfolio-sites'
`tests/unit/claude-models.test.ts` checks the shape of its one line.

## Alerts

When a previously-recommended model disappears with no successor, a model
matches no family rule, or any provider's API call fails, the refresh run:

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
| `ANTHROPIC_API_KEY` | no\*     | Read-only `models.list()` and `models.retrieve()` calls                       |
| `OPENAI_API_KEY`    | no\*     | Read-only `models.list()` call                                                |
| `GOOGLE_API_KEY`    | no\*     | Read-only `GET /v1beta/models`                                                |
| `BUMP_PR_TOKEN`     | no\*\*   | Fine-grained PAT with `Contents: write` + `Pull requests: write` on consumers |
| `ALERT_WEBHOOK_URL` | no       | Webhook URL receives alert + change events                                    |

\* Each provider runs only when its key is set; a provider without a key is
left out of the manifest. At least one must be set, or the run raises a
`no_providers_configured` alert.

\*\* Needed only when `registry.yml` has consumers. Push-mode alert issues are
filed in this repo with the workflow's own `GITHUB_TOKEN`.

## Local development

```bash
nvm use
npm ci
npm run typecheck
npm test
npm run registry:check

# Dry run against the live APIs (writes docs/models.json locally; any
# subset of the keys works)
ANTHROPIC_API_KEY=… OPENAI_API_KEY=… GOOGLE_API_KEY=… npm run check
```

## Layout

```
src/
  types.ts             # zod schemas + types
  manifest.ts          # buildManifest / diffManifests / atomic write
  alerts.ts            # createIssue + postWebhook + push-mode alert issue
  pr-bumper.ts         # one bump PR per (repo, family, branch_prefix)
  migration-notes.ts   # static pre-merge checklist for Claude bumps
  registry-check.ts    # registry:check logic
  providers/
    anthropic.ts
    openai.ts
    google.ts
scripts/
  check-models.ts      # cron entry: refresh manifest + alert
  open-bump-prs.ts     # cron entry: open bump PRs from registry
  validate-registry.ts # npm run registry:check
docs/
  models.json          # served at https://jmill.github.io/modelmonitor/models.json
  schema.json
  index.html
.github/workflows/
  refresh.yml          # daily 09:00 UTC
  pages.yml            # deploy /docs to Pages on change
  ci.yml               # typecheck + vitest + registry:check on PRs
```

## License

MIT
