# Working in modelmonitor

This service publishes model recommendations and opens model-pin PRs in enrolled
consumer repos. [README.md](README.md) is the behavior contract; read the section
for your task before changing it. This guide is shared by Codex and Claude.

## Task map

| Task | Start here | Validation |
| --- | --- | --- |
| Add or adjust a provider/family | `src/providers/`, `src/rank.ts`; README "Pull mode" | `tests/providers.test.ts`, `tests/rank.test.ts` |
| Change published manifest fields | `src/types.ts`, `src/manifest.ts`, `docs/schema.json` | `tests/schema.test.ts`, `tests/manifest.test.ts`; keep both schemas compatible |
| Enroll a consumer or repair a pattern | `registry.yml`; README "Push mode" and "Checking the registry" | `npm run registry:check`; use its `--local owner/repo=/path` option to verify matches |
| Change bump PR behavior | `src/pr-bumper.ts`, `src/migration-notes.ts`; README "Existing, declined and superseded PRs" | `tests/pr-bumper.test.ts`, `tests/migration-notes.test.ts`, `tests/helpers/fake-github.ts` |
| Diagnose refresh, alerts or publication | `scripts/check-models.ts`, `src/alerts.ts`, `.github/workflows/refresh.yml`, `.github/workflows/pages.yml` | Inspect the failing run and provider result; preserve the previous-snapshot behavior |
| Change CI or local setup | `package.json`, `.nvmrc`, `.github/workflows/ci.yml` | Commands below |

## Verification

From the repository root, use the Node version in `.nvmrc`:

```sh
nvm use
npm ci
npm run typecheck
npm test
npm run registry:check
git diff --check
```

The test suite uses fixtures and a fake GitHub client. `npm run check` is a live
refresh: it calls configured providers, writes `docs/models.json`, and can send
alerts with configured credentials. `npm run bump-prs` writes to consumer repos
and alert issues. Use the offline checks above for routine validation; run live
operations only within the user's requested scope.

## Invariants and handoff

- Preserve published family keys and the JSON/Zod schema agreement.
- A model pin bump is a string change, not proof of API compatibility. Preserve
  the migration checklist and consumer-side review requirements.
- Anchor registry patterns to the intended constant and enroll every mirror
  checked by the consumer's parity tests. The README explains quoting and grouping.
- Treat `docs/models.json` as generated provider data; use fixtures to test model
  changes instead of inventing live recommendations.
- In the PR, report checks actually run and any consumer/runtime implications.
  Review comments, inline threads, review jobs and required checks must be settled
  on the final head before merging.
