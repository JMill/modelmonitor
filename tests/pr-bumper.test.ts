import { describe, it, expect, beforeEach } from "vitest";
import {
  BUMP_ALERT_TITLE,
  bumpProblems,
  formatAllClearBody,
  formatBumpAlertBody,
  publishBumpAlert,
  resolveIssue,
  upsertIssue,
} from "../src/alerts.ts";
import { MIGRATION_GUIDE_URL } from "../src/migration-notes.ts";
import {
  branchName,
  bumpAll,
  fillTemplate,
  groupEntries,
  isCurrentPin,
  planFile,
  resolveTarget,
} from "../src/pr-bumper.ts";
import { Manifest, RegistryEntry } from "../src/types.ts";
import { FakeGitHub } from "./helpers/fake-github.ts";

const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  deprecated: false,
  ...extra,
});

const manifest = Manifest.parse({
  version: "1",
  generated_at: "2026-09-28T09:29:12.706Z",
  providers: {
    anthropic: {
      families: {
        opus: {
          recommended: "claude-opus-5-5",
          all: [model("claude-opus-5-5"), model("claude-opus-5"), model("claude-opus-4-8")],
        },
        sonnet: {
          recommended: "claude-sonnet-5",
          all: [
            model("claude-sonnet-5"),
            model("claude-sonnet-4-6"),
            model("claude-sonnet-4-5-20250929", { aliases: ["claude-sonnet-4-5"] }),
          ],
        },
        haiku: {
          recommended: "claude-haiku-4-5-20251001",
          recommended_alias: "claude-haiku-4-5",
          all: [model("claude-haiku-4-5-20251001", { aliases: ["claude-haiku-4-5"] })],
        },
      },
    },
    openai: {
      families: {
        "gpt-4.1": { recommended: "gpt-4.1", all: [model("gpt-4.1")] },
        "gpt-4": { recommended: "gpt-4-turbo", all: [model("gpt-4-turbo")] },
      },
    },
  },
});

// A v1 manifest from before aliases were published.
const v1Manifest = Manifest.parse({
  version: "1",
  generated_at: "2026-09-01T00:00:00Z",
  providers: {
    anthropic: {
      families: {
        haiku: {
          recommended: "claude-haiku-4-5-20251001",
          all: [model("claude-haiku-4-5-20251001")],
        },
      },
    },
  },
});

const REPO = "JMill/tee-site";
const keyAnchored = (family: string) => ({
  pattern: `(\\b${family}:\\s*["'])claude-${family}-[a-z0-9-]+(["'])`,
  replacement_template: "$1{recommended}$2",
});
const entry = (fields: Record<string, unknown>) =>
  RegistryEntry.parse({ repo: REPO, ...fields });

const constantsFile = [
  "// Single source of truth for Claude model ids.",
  "// claude-sonnet-4-6's cacheable minimum was 1,024 tokens.",
  "export const CLAUDE_MODELS = {",
  "  opus: 'claude-opus-4-8',",
  "  sonnet: 'claude-sonnet-4-6',",
  "  haiku: 'claude-haiku-4-5',",
  "} as const;",
  "",
].join("\n");

let gh: FakeGitHub;
let baseSha: string;
beforeEach(() => {
  gh = new FakeGitHub();
  baseSha = gh.addRepo(REPO, {
    "packages/models/src/models.ts": constantsFile,
    "apps/web/src/lib/models.ts": "export const SONNET = \"claude-sonnet-4-6\";\n",
    "scripts/run.ts": { content: "#!/usr/bin/env tsx\nconst MODEL = \"claude-sonnet-4-6\";\n", mode: "100755" },
    "README.md": "Uses claude-sonnet-4-6 today.\n",
  });
  gh.addRepo("JMill/modelmonitor", {});
});

describe("planFile", () => {
  const target = resolveTarget(manifest, "anthropic.sonnet")!;

  it("rewrites only the key-anchored pin, never comments or other families", () => {
    const plan = planFile(constantsFile, entry({ file: "x", family: "anthropic.sonnet", ...keyAnchored("sonnet") }), target);
    expect(plan.matches).toBe(1);
    expect(plan.pinned).toEqual(["claude-sonnet-4-6"]);
    expect(plan.changes).toEqual([{ line: 5, from: "claude-sonnet-4-6", to: "claude-sonnet-5" }]);
    expect(plan.updated).toBe(constantsFile.replace("sonnet: 'claude-sonnet-4-6'", "sonnet: 'claude-sonnet-5'"));
    expect(plan.updated).toContain("claude-sonnet-4-6's cacheable minimum");
  });

  it("substitutes every placeholder occurrence, not just the first", () => {
    expect(
      fillTemplate("{recommended}|{recommended}|{recommended_alias}|{recommended_alias}", {
        recommended: "claude-haiku-4-5-20251001",
        alias: "claude-haiku-4-5",
      }),
    ).toBe("claude-haiku-4-5-20251001|claude-haiku-4-5-20251001|claude-haiku-4-5|claude-haiku-4-5");

    const content = 'const MODEL = "claude-sonnet-4-6"; // pinned: claude-sonnet-4-6\n';
    const plan = planFile(
      content,
      entry({
        file: "x",
        family: "anthropic.sonnet",
        pattern: 'const MODEL = "claude-sonnet-[a-z0-9-]+"; // pinned: claude-sonnet-[a-z0-9-]+',
        replacement_template: 'const MODEL = "{recommended}"; // pinned: {recommended}',
      }),
      target,
    );
    expect(plan.updated).toBe('const MODEL = "claude-sonnet-5"; // pinned: claude-sonnet-5\n');
    expect(plan.changes).toEqual([{ line: 1, from: "claude-sonnet-4-6", to: "claude-sonnet-5" }]);
  });

  it("supports named capture groups and never interprets $ inside the ID", () => {
    const plan = planFile(
      'model: "claude-sonnet-4-6"',
      entry({
        file: "x",
        family: "anthropic.sonnet",
        pattern: '(?<pre>model:\\s*")claude-sonnet-[a-z0-9-]+(?<post>")',
        replacement_template: "$<pre>{recommended}$<post>",
      }),
      { recommended: "claude-sonnet-$1", alias: "claude-sonnet-$1", aliases: undefined },
    );
    expect(plan.updated).toBe('model: "claude-sonnet-$1"');
  });

  it("keeps alias equivalence when the template reframes the match", () => {
    const haiku = resolveTarget(manifest, "anthropic.haiku")!;
    // The template swaps the quote style, so its literal parts don't frame
    // the match; the capture group still isolates the pinned ID.
    const reframing = entry({
      file: "x",
      family: "anthropic.haiku",
      pattern: "'(claude-haiku-[0-9-]+)'",
      replacement_template: '"{recommended}"',
    });
    const current = "m = 'claude-haiku-4-5'\n";
    expect(planFile(current, reframing, haiku)).toMatchObject({ matches: 1, changes: [], updated: current });
    const stale = "m = 'claude-haiku-3-5'\n";
    expect(planFile(stale, reframing, haiku).updated).toBe('m = "claude-haiku-4-5-20251001"\n');
  });

  it("treats an alias of the recommended model as current", () => {
    const haiku = resolveTarget(manifest, "anthropic.haiku")!;
    const plan = planFile(constantsFile, entry({ file: "x", family: "anthropic.haiku", ...keyAnchored("haiku") }), haiku);
    expect(plan.matches).toBe(1);
    expect(plan.changes).toEqual([]);
    expect(plan.updated).toBe(constantsFile);
  });
});

describe("isCurrentPin", () => {
  it("accepts the recommended ID and its published aliases", () => {
    const haiku = resolveTarget(manifest, "anthropic.haiku")!;
    expect(isCurrentPin("claude-haiku-4-5-20251001", haiku)).toBe(true);
    expect(isCurrentPin("claude-haiku-4-5", haiku)).toBe(true);
    expect(isCurrentPin("claude-haiku-3-5", haiku)).toBe(false);
  });

  it("falls back to the undated form of a dated ID only when no aliases are published", () => {
    const v1 = resolveTarget(v1Manifest, "anthropic.haiku")!;
    expect(v1.aliases).toBeUndefined();
    expect(isCurrentPin("claude-haiku-4-5", v1)).toBe(true);
    expect(isCurrentPin("claude-haiku-4", v1)).toBe(false);
    // With alias data, the heuristic is off: only listed aliases count.
    expect(
      isCurrentPin("claude-haiku-4-5", { recommended: "claude-haiku-4-5-20251001", aliases: [] }),
    ).toBe(false);
  });
});

describe("resolveTarget", () => {
  it("resolves dotted family keys on the first dot", () => {
    expect(resolveTarget(manifest, "openai.gpt-4.1")?.recommended).toBe("gpt-4.1");
  });

  it("falls back to recommended for {recommended_alias} when there is no alias", () => {
    expect(resolveTarget(manifest, "anthropic.sonnet")?.alias).toBe("claude-sonnet-5");
    expect(resolveTarget(manifest, "anthropic.haiku")?.alias).toBe("claude-haiku-4-5");
  });
});

describe("groupEntries", () => {
  it("groups by repo (case-insensitively), family and branch prefix", () => {
    const groups = groupEntries([
      entry({ file: "a.ts", family: "anthropic.sonnet", ...keyAnchored("sonnet") }),
      entry({ file: "b.ts", family: "anthropic.sonnet", ...keyAnchored("sonnet"), repo: "jmill/TEE-SITE" }),
      entry({ file: "a.ts", family: "anthropic.opus", ...keyAnchored("opus") }),
      entry({ file: "c.ts", family: "anthropic.sonnet", ...keyAnchored("sonnet"), branch_prefix: "deps/models" }),
    ]);
    expect(groups.map((g) => [g.family, g.branch_prefix, g.entries.map((e) => e.file)])).toEqual([
      ["anthropic.sonnet", "chore/model-bump", ["a.ts", "b.ts"]],
      ["anthropic.opus", "chore/model-bump", ["a.ts"]],
      ["anthropic.sonnet", "deps/models", ["c.ts"]],
    ]);
  });
});

describe("bumpAll against a GitHub fake", () => {
  const sonnetEntries = [
    entry({
      file: "packages/models/src/models.ts",
      family: "anthropic.sonnet",
      ...keyAnchored("sonnet"),
      reviewers: ["JMill"],
    }),
    entry({
      file: "scripts/run.ts",
      family: "anthropic.sonnet",
      pattern: '(const MODEL = ")claude-sonnet-[a-z0-9-]+(")',
      replacement_template: "$1{recommended}$2",
      reviewers: ["octocat"],
    }),
  ];
  const branch = "chore/model-bump/anthropic.sonnet/claude-sonnet-5";

  it("opens ONE PR carrying every file in the group, built on the base commit", async () => {
    const [result] = await bumpAll(gh.asOctokit(), sonnetEntries, manifest, "https://ci/run/1");
    expect(result.status).toBe("opened");
    expect(result.branch).toBe(branch);
    expect(gh.pulls(REPO)).toHaveLength(1);

    const commit = gh.commitOf(REPO, branch);
    expect(commit.parents).toEqual([baseSha]);
    expect(gh.readFile(REPO, branch, "packages/models/src/models.ts")).toContain(
      "sonnet: 'claude-sonnet-5'",
    );
    expect(gh.readFile(REPO, branch, "packages/models/src/models.ts")).toContain(
      "opus: 'claude-opus-4-8'",
    );
    expect(gh.readFile(REPO, branch, "scripts/run.ts")).toBe(
      '#!/usr/bin/env tsx\nconst MODEL = "claude-sonnet-5";\n',
    );
    // Untouched files and the executable bit carry over.
    expect(gh.readFile(REPO, branch, "README.md")).toBe("Uses claude-sonnet-4-6 today.\n");
    expect(gh.fileMode(REPO, branch, "scripts/run.ts")).toBe("100755");
    // The default branch itself is never written.
    expect(gh.commitOf(REPO, "main").sha).toBe(baseSha);

    const pr = gh.pulls(REPO)[0];
    expect(pr.title).toBe("Upgrade Claude Sonnet calls to claude-sonnet-5, the recommended model");
    expect(pr.title).not.toMatch(/^chore:/);
    expect(pr.body).toContain("packages/models/src/models.ts");
    expect(pr.body).toContain(`/blob/${baseSha}/packages/models/src/models.ts#L5`);
    expect(pr.body).toContain("| 5 | `claude-sonnet-4-6` | `claude-sonnet-5` |");
    expect(pr.body).toContain(`/blob/${baseSha}/scripts/run.ts#L2`);
    expect(pr.body).toContain("### Before merging");
    expect(pr.body).toContain("`temperature`, `top_p` and `top_k`");
    expect(pr.body).toContain(MIGRATION_GUIDE_URL);
    expect(pr.body).toContain("Run: https://ci/run/1");
    // JMill owns the bump token and so authors the PR; GitHub would reject
    // the whole request if the author were asked, so only octocat is.
    expect(pr.user.login).toBe("JMill");
    expect(pr.reviewers).toEqual(["octocat"]);
    expect(commit.message.split("\n")[0]).toBe(pr.title);
  });

  it("uses the first entry's title and commit templates for the whole group", async () => {
    const [first, second] = sonnetEntries;
    await bumpAll(
      gh.asOctokit(),
      [
        { ...first, title_template: "Move {family} from {from} to {recommended} [deploy]", commit_template: "Ship {to} for faster drafts [deploy]" },
        { ...second, title_template: "ignored" },
      ],
      manifest,
      undefined,
    );
    expect(gh.pulls(REPO)[0].title).toBe(
      "Move anthropic.sonnet from claude-sonnet-4-6 to claude-sonnet-5 [deploy]",
    );
    expect(gh.commitOf(REPO, branch).message).toBe("Ship claude-sonnet-5 for faster drafts [deploy]");
  });

  it("skips a pin that is an alias of the recommended model", async () => {
    const [result] = await bumpAll(
      gh.asOctokit(),
      [entry({ file: "packages/models/src/models.ts", family: "anthropic.haiku", ...keyAnchored("haiku") })],
      manifest,
      undefined,
    );
    expect(result.status).toBe("skipped_already_current");
    expect(result.file_results[0]).toMatchObject({ status: "current", pinned: ["claude-haiku-4-5"] });
    expect(gh.pulls(REPO)).toEqual([]);
    expect(gh.calls).not.toContain("git.createCommit");
  });

  it("closes older bump PRs even when the default branch is already current", async () => {
    // A manual upgrade landed first: merging the old bump would move backwards.
    const stale = gh.addPull(REPO, { ref: "chore/model-bump/anthropic.haiku/claude-haiku-3-5-20241022" });
    const otherFamily = gh.addPull(REPO, { ref: "chore/model-bump/anthropic.opus/claude-opus-5" });
    const [result] = await bumpAll(
      gh.asOctokit(),
      [entry({ file: "packages/models/src/models.ts", family: "anthropic.haiku", ...keyAnchored("haiku") })],
      manifest,
      undefined,
    );
    expect(result.status).toBe("skipped_already_current");
    expect(result.superseded).toEqual([stale.html_url]);
    expect(stale.state).toBe("closed");
    expect(stale.comments?.[0]).toContain("the default branch already uses it");
    expect(stale.body).toContain("<!-- modelmonitor:superseded -->");
    expect(otherFamily.state).toBe("open");
    expect(gh.calls).not.toContain("git.createCommit");
  });

  it("writes the undated alias for {recommended_alias}", async () => {
    const newer = Manifest.parse({
      ...manifest,
      providers: {
        anthropic: {
          families: {
            haiku: {
              recommended: "claude-haiku-5-20270101",
              recommended_alias: "claude-haiku-5",
              all: [model("claude-haiku-5-20270101", { aliases: ["claude-haiku-5"] })],
            },
          },
        },
      },
    });
    const [result] = await bumpAll(
      gh.asOctokit(),
      [
        entry({
          file: "packages/models/src/models.ts",
          family: "anthropic.haiku",
          pattern: keyAnchored("haiku").pattern,
          replacement_template: "$1{recommended_alias}$2",
        }),
      ],
      newer,
      undefined,
    );
    expect(result.status).toBe("opened");
    expect(
      gh.readFile(REPO, "chore/model-bump/anthropic.haiku/claude-haiku-5-20270101", "packages/models/src/models.ts"),
    ).toContain("haiku: 'claude-haiku-5',");
    expect(gh.pulls(REPO)[0].title).toContain("to claude-haiku-5,");
  });

  it("skips an alias bump for the run when the manifest has no alias for a dated ID", async () => {
    // The refresh's alias lookup failed on the day a new Haiku became
    // recommended: only the dated ID is published.
    const noAlias = Manifest.parse({
      ...manifest,
      providers: {
        anthropic: {
          families: {
            haiku: {
              recommended: "claude-haiku-5-20270101",
              all: [model("claude-haiku-5-20270101"), model("claude-haiku-4-5-20251001")],
            },
          },
        },
      },
    });
    gh.addRepo("JMill/py", {
      "src/models.ts": "export const M = {\n  haiku: 'claude-haiku-4-5',\n};\n",
      "claude_models.py": 'HAIKU = "claude-haiku-4-5"\n',
    });
    const entries = [
      entry({
        repo: "JMill/py",
        file: "src/models.ts",
        family: "anthropic.haiku",
        pattern: keyAnchored("haiku").pattern,
        replacement_template: "$1{recommended_alias}$2",
      }),
      entry({
        repo: "JMill/py",
        file: "claude_models.py",
        family: "anthropic.haiku",
        pattern: '^(HAIKU = ")claude-haiku-[a-z0-9-]+(")',
        flags: "m",
        replacement_template: "$1{recommended}$2",
      }),
    ];
    const results = await bumpAll(gh.asOctokit(), entries, noAlias, undefined);
    expect(results[0].status).toBe("skipped_no_alias");
    expect(results[0].error).toContain("claude-haiku-5-20270101 has no verified undated alias");
    expect(results[0].error).toContain("src/models.ts writes {recommended_alias}");
    // The whole group waits, including the file that writes {recommended}.
    expect(gh.calls).not.toContain("git.createCommit");
    expect(gh.pulls("JMill/py")).toEqual([]);
    expect(bumpProblems(results)).toEqual([expect.stringContaining("bump skipped")]);

    // Once the alias is published, the bump writes it.
    const withAlias = Manifest.parse({
      ...noAlias,
      providers: {
        anthropic: {
          families: {
            haiku: {
              recommended: "claude-haiku-5-20270101",
              recommended_alias: "claude-haiku-5",
              all: [model("claude-haiku-5-20270101", { aliases: ["claude-haiku-5"] })],
            },
          },
        },
      },
    });
    const [later] = await bumpAll(gh.asOctokit(), entries, withAlias, undefined);
    expect(later.status).toBe("opened");
    expect(gh.readFile("JMill/py", later.branch!, "src/models.ts")).toContain("'claude-haiku-5'");
  });

  it("does not hold back a pin that is already current when alias data is missing", async () => {
    const [result] = await bumpAll(
      gh.asOctokit(),
      [
        entry({
          file: "packages/models/src/models.ts",
          family: "anthropic.haiku",
          pattern: keyAnchored("haiku").pattern,
          replacement_template: "$1{recommended_alias}$2",
        }),
      ],
      v1Manifest,
      undefined,
    );
    expect(result.status).toBe("skipped_already_current");
    expect(bumpProblems([result])).toEqual([]);
  });

  it("respects a closed, unmerged PR for the same branch as an opt-out", async () => {
    const declined = gh.addPull(REPO, { ref: branch, state: "closed" });
    // An older bump PR still open for an ID that is no longer recommended.
    const stale = gh.addPull(REPO, { ref: "chore/model-bump/anthropic.sonnet/claude-sonnet-4-6" });
    const [result] = await bumpAll(gh.asOctokit(), sonnetEntries, manifest, undefined);
    expect(result.status).toBe("skipped_declined");
    expect(result.url).toBe(declined.html_url);
    expect(gh.pulls(REPO)).toHaveLength(2);
    expect(gh.calls).not.toContain("git.createRef");
    expect(gh.calls).not.toContain("git.updateRef");
    // The sweep still runs on the declined path.
    expect(result.superseded).toEqual([stale.html_url]);
    expect(stale.state).toBe("closed");
    expect(stale.comments?.[0]).toContain(`which this repo declined in #${declined.number}`);
  });

  it("reopens a bump when the recommendation flips back (A -> B -> A)", async () => {
    const sonnet = (recommended: string) =>
      Manifest.parse({
        ...manifest,
        providers: {
          anthropic: {
            families: {
              sonnet: {
                recommended,
                all: [model("claude-sonnet-5-1"), model("claude-sonnet-5"), model("claude-sonnet-4-6")],
              },
            },
          },
        },
      });
    const branchFor = (id: string) => `chore/model-bump/anthropic.sonnet/${id}`;

    const [a] = await bumpAll(gh.asOctokit(), sonnetEntries, sonnet("claude-sonnet-5"), undefined);
    expect(a.status).toBe("opened");
    const prA = gh.pulls(REPO).find((p) => p.head.ref === branchFor("claude-sonnet-5"))!;

    const [b] = await bumpAll(gh.asOctokit(), sonnetEntries, sonnet("claude-sonnet-5-1"), undefined);
    expect(b.status).toBe("opened");
    expect(b.superseded).toEqual([prA.html_url]);
    expect(prA.state).toBe("closed");
    const prB = gh.pulls(REPO).find((p) => p.head.ref === branchFor("claude-sonnet-5-1"))!;

    // B is withdrawn: A is recommended again. modelmonitor closed PR-A, not a
    // person, so that close is no opt-out.
    const [again] = await bumpAll(gh.asOctokit(), sonnetEntries, sonnet("claude-sonnet-5"), undefined);
    expect(again.status).toBe("opened");
    expect(again.url).not.toBe(prA.html_url);
    expect(again.superseded).toEqual([prB.html_url]);
    expect(prB.state).toBe("closed");
    expect(gh.readFile(REPO, branchFor("claude-sonnet-5"), "scripts/run.ts")).toContain(
      '"claude-sonnet-5"',
    );
    const open = gh.pulls(REPO).filter((p) => p.state === "open");
    expect(open.map((p) => p.head.ref)).toEqual([branchFor("claude-sonnet-5")]);
  });

  it("leaves an existing open PR alone, still closing older ones it supersedes", async () => {
    const stale = gh.addPull(REPO, { ref: "chore/model-bump/anthropic.sonnet/claude-sonnet-4-6" });
    const open = gh.addPull(REPO, { ref: branch });
    const [result] = await bumpAll(gh.asOctokit(), sonnetEntries, manifest, undefined);
    expect(result).toMatchObject({ status: "skipped_existing_pr", url: open.html_url });
    expect(gh.calls).not.toContain("pulls.create");
    expect(gh.calls).not.toContain("git.createCommit");
    expect(open.state).toBe("open");
    expect(stale.state).toBe("closed");
    expect(result.superseded).toEqual([stale.html_url]);
  });

  it("resets a branch left behind without a PR instead of failing on it", async () => {
    gh.addPull(REPO, { ref: branch, state: "closed", merged: true });
    const [result] = await bumpAll(gh.asOctokit(), sonnetEntries, manifest, undefined);
    expect(result.status).toBe("opened");
    expect(gh.calls).toContain("git.updateRef");
    expect(gh.calls).not.toContain("git.createRef");
    expect(gh.commitOf(REPO, branch).parents).toEqual([baseSha]);
  });

  it("closes older open bump PRs for the same family as superseded", async () => {
    const stale = gh.addPull(REPO, { ref: "chore/model-bump/anthropic.sonnet/claude-sonnet-4-6" });
    const otherFamily = gh.addPull(REPO, { ref: "chore/model-bump/anthropic.opus/claude-opus-5" });
    const otherPrefix = gh.addPull(REPO, { ref: "deps/models/anthropic.sonnet/claude-sonnet-4-6" });
    const human = gh.addPull(REPO, { ref: "feature/sonnet-prompts" });
    // A fork's PR whose branch name looks like an old bump branch.
    const fork = gh.addPull(REPO, {
      ref: "chore/model-bump/anthropic.sonnet/claude-sonnet-4-6",
      headRepo: "someone/tee-site",
    });

    const [result] = await bumpAll(gh.asOctokit(), sonnetEntries, manifest, undefined);
    expect(result.status).toBe("opened");
    expect(result.superseded).toEqual([stale.html_url]);
    expect(stale.state).toBe("closed");
    expect(stale.comments?.[0]).toContain(`Superseded by #`);
    expect(stale.comments?.[0]).toContain(result.url);
    for (const pr of [otherFamily, otherPrefix, human, fork]) expect(pr.state).toBe("open");
  });

  it("sweeps only its own branches when another group's prefix nests under it", async () => {
    // Group 1: prefix `deps`, family anthropic.sonnet. Another entry uses the
    // prefix `deps/anthropic.sonnet` for anthropic.opus, so its branches sit
    // one level below group 1's.
    const nested = gh.addPull(REPO, {
      ref: "deps/anthropic.sonnet/anthropic.opus/claude-opus-5",
    });
    const stale = gh.addPull(REPO, { ref: "deps/anthropic.sonnet/claude-sonnet-4-6" });
    const [result] = await bumpAll(
      gh.asOctokit(),
      sonnetEntries.map((e) => ({ ...e, branch_prefix: "deps" })),
      manifest,
      undefined,
    );
    expect(result.status).toBe("opened");
    expect(result.superseded).toEqual([stale.html_url]);
    expect(nested.state).toBe("open");
  });

  it("ignores a fork's PR that happens to use the bump branch's name", async () => {
    const fork = gh.addPull(REPO, { ref: branch, headRepo: "someone/tee-site" });
    const [result] = await bumpAll(gh.asOctokit(), sonnetEntries, manifest, undefined);
    expect(result.status).toBe("opened");
    expect(result.url).not.toBe(fork.html_url);
    expect(fork.state).toBe("open");
  });

  it("uses the repo's current name after a rename, so an open PR is still found", async () => {
    const stale = gh.addPull(REPO, { ref: "chore/model-bump/anthropic.sonnet/claude-sonnet-4-6" });
    const open = gh.addPull(REPO, { ref: branch });
    const humanWork = gh.commitOf(REPO, branch).sha;
    gh.renameRepo(REPO, "wfsgrp/tee-site");

    // registry.yml still says JMill/tee-site.
    const results = await bumpAll(gh.asOctokit(), sonnetEntries, manifest, undefined);
    expect(results[0]).toMatchObject({
      status: "skipped_existing_pr",
      url: open.html_url,
      resolved_repo: "wfsgrp/tee-site",
    });
    // The open PR's branch is untouched and nothing was created or deleted.
    expect(gh.commitOf("wfsgrp/tee-site", branch).sha).toBe(humanWork);
    for (const call of ["git.updateRef", "git.createRef", "git.deleteRef", "pulls.create"]) {
      expect(gh.calls).not.toContain(call);
    }
    expect(open.state).toBe("open");
    expect(stale.state).toBe("closed");
    expect(bumpProblems(results)).toEqual([
      expect.stringContaining("GitHub now names this repo `wfsgrp/tee-site`"),
    ]);
  });

  it("still honours a declined PR after a rename", async () => {
    const declined = gh.addPull(REPO, { ref: branch, state: "closed" });
    gh.renameRepo(REPO, "wfsgrp/tee-site");
    const [result] = await bumpAll(gh.asOctokit(), sonnetEntries, manifest, undefined);
    expect(result).toMatchObject({ status: "skipped_declined", url: declined.html_url });
    expect(gh.calls).not.toContain("git.updateRef");
  });

  it("opens the PR in the renamed repo, writing only to its current name", async () => {
    gh.renameRepo(REPO, "wfsgrp/tee-site");
    const [result] = await bumpAll(gh.asOctokit(), sonnetEntries, manifest, undefined);
    expect(result.status).toBe("opened");
    expect(result.url).toContain("github.com/wfsgrp/tee-site/pull/");
    expect(gh.readFile("wfsgrp/tee-site", branch, "scripts/run.ts")).toContain("claude-sonnet-5");
  });

  it("never resets a branch whose open PR the head-filtered lookup misses", async () => {
    const open = gh.addPull(REPO, { ref: branch });
    const humanWork = gh.commitOf(REPO, branch).sha;
    gh.headFilterMisses = true;
    const [result] = await bumpAll(gh.asOctokit(), sonnetEntries, manifest, undefined);
    expect(result).toMatchObject({ status: "skipped_existing_pr", url: open.html_url });
    expect(gh.commitOf(REPO, branch).sha).toBe(humanWork);
    expect(gh.calls).not.toContain("git.updateRef");
  });

  it("restores, never deletes, a pre-existing branch when opening the PR fails", async () => {
    gh.addPull(REPO, { ref: branch, state: "closed", merged: true });
    const leftover = gh.commitOf(REPO, branch).sha;
    gh.failNextPullCreate = Object.assign(new Error("Validation Failed"), { status: 422 });
    const [result] = await bumpAll(gh.asOctokit(), sonnetEntries, manifest, undefined);
    expect(result.status).toBe("failed");
    expect(gh.calls).not.toContain("git.deleteRef");
    expect(gh.branches(REPO)).toContain(branch);
    expect(gh.commitOf(REPO, branch).sha).toBe(leftover);
  });

  it("reports a PR opened mid-run as existing and puts its branch back", async () => {
    gh.addPull(REPO, { ref: branch, state: "closed", merged: true });
    const leftover = gh.commitOf(REPO, branch).sha;
    let racer: ReturnType<FakeGitHub["addPull"]> | undefined;
    // Someone opens a PR on the leftover branch between our lookup and create.
    gh.beforePullCreate = () => {
      racer = gh.addPull(REPO, { ref: branch, createBranch: false });
    };
    const [result] = await bumpAll(gh.asOctokit(), sonnetEntries, manifest, undefined);
    expect(result).toMatchObject({ status: "skipped_existing_pr", url: racer!.html_url });
    expect(result.error).toBeUndefined();
    expect(gh.calls).not.toContain("git.deleteRef");
    // The reset is undone, so the new PR shows the branch as it was.
    expect(gh.commitOf(REPO, branch).sha).toBe(leftover);
    expect(racer!.state).toBe("open");
  });

  it("never deletes a branch GitHub says already has a PR, even one this run created", async () => {
    let racer: ReturnType<FakeGitHub["addPull"]> | undefined;
    gh.beforePullCreate = () => {
      racer = gh.addPull(REPO, { ref: branch, createBranch: false });
    };
    const [result] = await bumpAll(gh.asOctokit(), sonnetEntries, manifest, undefined);
    expect(result).toMatchObject({ status: "skipped_existing_pr", url: racer!.html_url });
    expect(gh.calls).not.toContain("git.deleteRef");
    expect(gh.branches(REPO)).toContain(branch);
  });

  it("deletes the branch when opening the PR fails, leaving no orphan", async () => {
    gh.failNextPullCreate = Object.assign(new Error("Validation Failed"), { status: 422 });
    const [result] = await bumpAll(gh.asOctokit(), sonnetEntries, manifest, undefined);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Validation Failed");
    expect(gh.branches(REPO)).toEqual(["main"]);
    expect(gh.calls).toContain("git.deleteRef");

    // And the next run succeeds cleanly.
    const [retry] = await bumpAll(gh.asOctokit(), sonnetEntries, manifest, undefined);
    expect(retry.status).toBe("opened");
  });

  it("warns in the PR when the pinned model is no longer served", async () => {
    gh = new FakeGitHub();
    gh.addRepo(REPO, { "m.ts": "export const M = { sonnet: 'claude-sonnet-4-20250514' };\n" });
    const [result] = await bumpAll(
      gh.asOctokit(),
      [entry({ file: "m.ts", family: "anthropic.sonnet", ...keyAnchored("sonnet") })],
      manifest,
      undefined,
    );
    expect(result.status).toBe("opened");
    expect(result.unserved).toEqual(["claude-sonnet-4-20250514"]);
    expect(gh.pulls(REPO)[0].body).toContain("no longer listed");
  });

  it("does not flag a still-served undated alias as unserved", async () => {
    gh = new FakeGitHub();
    gh.addRepo(REPO, { "m.ts": "export const M = { sonnet: 'claude-sonnet-4-5' };\n" });
    const [result] = await bumpAll(
      gh.asOctokit(),
      [entry({ file: "m.ts", family: "anthropic.sonnet", ...keyAnchored("sonnet") })],
      manifest,
      undefined,
    );
    expect(result.status).toBe("opened");
    expect(result.unserved).toEqual([]);
  });

  it("keeps dotted OpenAI families apart", async () => {
    gh = new FakeGitHub();
    gh.addRepo(REPO, { "m.ts": 'const MODEL = "gpt-4.1-mini";\n' });
    const [result] = await bumpAll(
      gh.asOctokit(),
      [
        entry({
          file: "m.ts",
          family: "openai.gpt-4.1",
          pattern: '(const MODEL = ")gpt-4\\.1[a-z0-9.-]*(")',
          replacement_template: "$1{recommended}$2",
        }),
      ],
      manifest,
      undefined,
    );
    expect(result.status).toBe("opened");
    expect(result.branch).toBe(branchName("chore/model-bump", "openai.gpt-4.1", "gpt-4.1"));
    expect(gh.readFile(REPO, result.branch!, "m.ts")).toBe('const MODEL = "gpt-4.1";\n');
    // No Claude checklist on other providers' bumps.
    expect(gh.pulls(REPO)[0].body).not.toContain("Before merging");
  });
});

describe("bump alerts", () => {
  const problemEntries = () => [
    // Pattern matches nothing: the consumer refactored its pin away.
    entry({ file: "apps/web/src/lib/models.ts", family: "anthropic.opus", ...keyAnchored("opus") }),
    // Family the monitoring key can't list.
    entry({ file: "packages/models/src/models.ts", family: "anthropic.mythos", ...keyAnchored("mythos") }),
    // File that doesn't exist.
    entry({ file: "packages/gone.ts", family: "anthropic.sonnet", ...keyAnchored("sonnet") }),
  ];

  it("aggregates failed and no-match results into one issue per run", async () => {
    const results = await bumpAll(gh.asOctokit(), problemEntries(), manifest, undefined);
    expect(results.map((r) => r.status)).toEqual(["skipped_no_match", "failed", "failed"]);

    const problems = bumpProblems(results);
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toContain("pattern matched nothing");
    expect(problems.join("\n")).toContain("anthropic.mythos is not in the manifest");
    expect(problems.join("\n")).toContain("packages/gone.ts not found");

    // GitHub's issue list includes pull requests. A PR that happens to share
    // the title and label is not the alert issue.
    const lookalike = gh.addPull("JMill/modelmonitor", {
      ref: "alert-copy",
      createBranch: false,
      title: BUMP_ALERT_TITLE,
      labels: ["modelmonitor"],
    });

    const octokit = gh.asOctokit();
    const body = formatBumpAlertBody(problems, "https://ci/run/2");
    expect(await upsertIssue(octokit, "JMill", "modelmonitor", BUMP_ALERT_TITLE, body)).toBe("created");
    const issues = gh.issues("JMill/modelmonitor");
    expect(issues).toHaveLength(1);
    expect(issues[0].labels).toEqual(["modelmonitor"]);
    expect(lookalike.comments).toBeUndefined();

    // Same problems tomorrow: no duplicate issue, no repeat comment.
    const again = formatBumpAlertBody(problems, "https://ci/run/3");
    expect(await upsertIssue(octokit, "JMill", "modelmonitor", BUMP_ALERT_TITLE, again)).toBe("unchanged");

    // A human reply in between doesn't make the same report look new.
    issues[0].comments.push("Looking into the mythos entry.");
    expect(await upsertIssue(octokit, "JMill", "modelmonitor", BUMP_ALERT_TITLE, again)).toBe("unchanged");

    // A new problem: comment on the open issue rather than opening another.
    const more = formatBumpAlertBody([...problems, "- `JMill/x` `anthropic.opus`: bump failed: 403"], undefined);
    expect(await upsertIssue(octokit, "JMill", "modelmonitor", BUMP_ALERT_TITLE, more)).toBe("commented");
    expect(gh.issues("JMill/modelmonitor")).toHaveLength(1);
    expect(issues[0].comments).toHaveLength(2);
    expect(issues[0].comments[1]).toContain("bump failed: 403");

    // ...and the same new set again is compared with THAT comment, the latest
    // report, not the issue body: no repeat.
    expect(await upsertIssue(octokit, "JMill", "modelmonitor", BUMP_ALERT_TITLE, more)).toBe("unchanged");
    expect(issues[0].comments).toHaveLength(2);
  });

  it("closes the alert with an all clear, so a recurrence alerts again", async () => {
    const octokit = gh.asOctokit();
    const problems = ["- `JMill/x` `anthropic.opus`: bump failed: 403"];
    expect(await publishBumpAlert(octokit, "JMill", "modelmonitor", problems, "https://ci/run/1")).toBe("created");
    const [first] = gh.issues("JMill/modelmonitor");

    // Fixed: the next clean run posts the all clear and closes the issue.
    expect(await publishBumpAlert(octokit, "JMill", "modelmonitor", [], "https://ci/run/2")).toBe("resolved");
    expect(first.state).toBe("closed");
    expect(first.comments).toEqual([expect.stringContaining("All clear")]);
    expect(first.comments[0]).toContain("Run: https://ci/run/2");
    // Nothing open: later clean runs do nothing.
    expect(await publishBumpAlert(octokit, "JMill", "modelmonitor", [], undefined)).toBe("none");

    // The same problem comes back: a fresh issue, not silence.
    expect(await publishBumpAlert(octokit, "JMill", "modelmonitor", problems, undefined)).toBe("created");
    expect(gh.issues("JMill/modelmonitor").filter((i) => i.state === "open")).toHaveLength(1);
  });

  it("treats a report after an all clear as new even if the close failed", async () => {
    const octokit = gh.asOctokit();
    const body = formatBumpAlertBody(["- `JMill/x` `anthropic.opus`: bump failed: 403"], undefined);
    await upsertIssue(octokit, "JMill", "modelmonitor", BUMP_ALERT_TITLE, body);
    const [issue] = gh.issues("JMill/modelmonitor");
    // A previous run posted the all clear but could not close the issue.
    issue.comments.push(formatAllClearBody(undefined));
    expect(await upsertIssue(octokit, "JMill", "modelmonitor", BUMP_ALERT_TITLE, body)).toBe("commented");
    // And a clean run doesn't post a second all clear before closing.
    issue.comments.push(formatAllClearBody(undefined));
    expect(await resolveIssue(octokit, "JMill", "modelmonitor", BUMP_ALERT_TITLE)).toBe("resolved");
    expect(issue.comments.filter((c) => c.includes("All clear"))).toHaveLength(2);
    expect(issue.state).toBe("closed");
  });

  it("reports a failed alert so the run can fail instead of passing silently", async () => {
    gh.failIssueWrites = true;
    const outcome = await publishBumpAlert(
      gh.asOctokit(),
      "JMill",
      "modelmonitor",
      ["- `JMill/x` `anthropic.opus`: bump failed: 403"],
      undefined,
    );
    expect(outcome).toBe("failed");
  });

  it("reports nothing when every group is healthy", async () => {
    const results = await bumpAll(
      gh.asOctokit(),
      [entry({ file: "packages/models/src/models.ts", family: "anthropic.haiku", ...keyAnchored("haiku") })],
      manifest,
      undefined,
    );
    expect(bumpProblems(results)).toEqual([]);
  });

  it("holds the whole group, opening no partial PR, when one of its files matches nothing", async () => {
    const results = await bumpAll(
      gh.asOctokit(),
      [
        entry({ file: "packages/models/src/models.ts", family: "anthropic.sonnet", ...keyAnchored("sonnet") }),
        entry({ file: "README.md", family: "anthropic.sonnet", ...keyAnchored("sonnet") }),
      ],
      manifest,
      undefined,
    );
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toContain("README.md matched nothing");
    // No PR and no branch: a partial bump would fail the consumer's drift test.
    expect(gh.pulls(REPO)).toHaveLength(0);
    expect(gh.branches(REPO)).not.toContain("chore/model-bump/anthropic.sonnet/claude-sonnet-5");
    expect(bumpProblems(results)).toEqual([
      expect.stringContaining("bump failed: no PR opened: this group's files change together"),
      expect.stringContaining("`README.md`: pattern matched nothing"),
    ]);
  });

  it("holds the whole group when one of its files cannot be read", async () => {
    const results = await bumpAll(
      gh.asOctokit(),
      [
        entry({ file: "packages/models/src/models.ts", family: "anthropic.sonnet", ...keyAnchored("sonnet") }),
        entry({ file: "packages/gone.ts", family: "anthropic.sonnet", ...keyAnchored("sonnet") }),
      ],
      manifest,
      undefined,
    );
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toContain("packages/gone.ts could not be read");
    expect(gh.pulls(REPO)).toHaveLength(0);
  });
});
