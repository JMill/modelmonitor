import type { Octokit } from "@octokit/rest";
import { renderMigrationNotes } from "./migration-notes.ts";
import {
  compilePattern,
  splitFamily,
  type Manifest,
  type ProviderId,
  type RegistryEntry,
} from "./types.ts";

// Push mode. Registry entries are grouped by (repo, family, branch_prefix)
// and each group gets ONE pull request that carries every file's change, so
// two files pinning the same family never race for the same branch.
//
// Per group, per run:
//   1. Resolve the family's recommended ID (and verified alias) from the
//      manifest.
//   2. Read every file at the default branch's current commit, apply the
//      entry's pattern, and decide per match whether the pinned ID is already
//      current (equal to recommended, or one of its aliases).
//   3. Look up PRs for the target branch in any state: an open one is left
//      alone; a closed, unmerged one is the consumer declining this ID and is
//      respected as an opt-out.
//   4. Build the commit with the git data API (blobs -> tree -> commit)
//      parented on that same base commit, then point the branch at it
//      (creating it, or resetting a branch left behind without a PR).
//   5. Open the PR, request reviewers, and close older open bump PRs for the
//      same family as superseded.
// Any failure after the branch moves deletes the branch again, so a failed
// run leaves nothing behind for the next run to trip over.

export type BumpStatus =
  | "opened"
  | "skipped_already_current"
  | "skipped_no_match"
  | "skipped_existing_pr"
  | "skipped_declined"
  | "failed";

export interface PinChange {
  line: number;
  // The pinned / written model IDs when the template lets them be isolated
  // from the match; otherwise the full matched / replacement text.
  from: string;
  to: string;
}

export interface FilePlan {
  matches: number;
  // Distinct model IDs found in the matches, in order of first appearance.
  pinned: string[];
  changes: PinChange[];
  updated: string;
}

export interface FileResult {
  file: string;
  status: "changed" | "current" | "no_match" | "error";
  matches: number;
  pinned: string[];
  changes: PinChange[];
  error?: string;
}

export interface GroupResult {
  repo: string;
  family: string;
  branch_prefix: string;
  files: string[];
  status: BumpStatus;
  recommended?: string;
  branch?: string;
  url?: string;
  error?: string;
  file_results: FileResult[];
  // Pinned IDs the manifest no longer lists anywhere in the provider: the
  // consumer is calling a model that is likely retired.
  unserved: string[];
  // PRs closed because this run's PR replaces them.
  superseded: string[];
}

// ---------------------------------------------------------------------------
// Manifest lookups

export interface BumpTarget {
  key: string;
  provider: string;
  family: string;
  recommended: string;
  // Written for {recommended_alias}; falls back to `recommended`.
  alias: string;
  // Aliases of the recommended model as published. Undefined when the
  // manifest carries no alias data for it (a v1 manifest, or a failed lookup).
  aliases?: string[];
}

export function resolveTarget(
  manifest: Manifest,
  key: string,
): BumpTarget | undefined {
  const { provider, family } = splitFamily(key);
  const fam = manifest.providers[provider as ProviderId]?.families[family];
  if (!fam) return undefined;
  const model = fam.all.find((m) => m.id === fam.recommended);
  const aliases =
    model?.aliases ?? (fam.recommended_alias ? [fam.recommended_alias] : undefined);
  return {
    key,
    provider,
    family,
    recommended: fam.recommended,
    alias: fam.recommended_alias ?? fam.recommended,
    aliases,
  };
}

const DATED = (id: string, base: string) =>
  id.length === base.length + 9 &&
  id.startsWith(`${base}-`) &&
  /^\d{8}$/.test(id.slice(base.length + 1));

// A pinned ID is current when it names the recommended model: the ID itself,
// one of its verified aliases, or (only when the manifest has no alias data)
// the undated form of a dated recommended ID. Without this, a consumer on
// claude-haiku-4-5 would be "bumped" to claude-haiku-4-5-20251001 (the same
// model) on every run.
export function isCurrentPin(
  pinned: string,
  target: Pick<BumpTarget, "recommended" | "aliases">,
): boolean {
  if (pinned === target.recommended) return true;
  if (target.aliases) return target.aliases.includes(pinned);
  return DATED(target.recommended, pinned);
}

// Whether the manifest lists `pinned` in any family of the provider, directly
// or as an alias (same equivalence as isCurrentPin).
export function isServed(
  manifest: Manifest,
  provider: string,
  pinned: string,
): boolean {
  const snapshot = manifest.providers[provider as ProviderId];
  if (!snapshot) return true; // provider not published: can't judge
  return Object.values(snapshot.families).some((fam) =>
    fam.all.some(
      (m) =>
        m.id === pinned ||
        (m.aliases ? m.aliases.includes(pinned) : DATED(m.id, pinned)),
    ),
  );
}

// ---------------------------------------------------------------------------
// Pure file planning (shared with scripts/validate-registry.ts)

// Substitute every occurrence of each placeholder. split/join rather than
// String.replace so neither a second placeholder nor a `$` in the value is
// treated specially.
export function fillTemplate(
  template: string,
  values: { recommended: string; alias: string },
): string {
  return template
    .split("{recommended_alias}")
    .join(values.alias)
    .split("{recommended}")
    .join(values.recommended);
}

// Stand in for the IDs while the template is expanded against a match. The
// pattern's own $1 / $<name> / $& are expanded natively; the IDs are
// substituted afterwards, so nothing in an ID is ever read as a $-sequence.
// Private-use code points, so they never occur in real files.
const SLOT_RECOMMENDED = "\u{F8FF0}";
const SLOT_ALIAS = "\u{F8FF1}";
const SLOTS_RE = new RegExp(`${SLOT_RECOMMENDED}|${SLOT_ALIAS}`, "u");

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Expand `replacement` for the single match at [index, index+length) with
// native String.replace semantics ($1, $<name>, $&, $$ ...), by re-running
// the pattern sticky at that offset against the whole content so anchors and
// lookbehinds see the same context the global scan did.
function expandAt(
  content: string,
  sticky: RegExp,
  index: number,
  length: number,
  replacement: string,
): string {
  sticky.lastIndex = index;
  const out = content.replace(sticky, replacement);
  return out.slice(index, out.length - (content.length - index - length));
}

// The model IDs inside `text`, given the template expanded with slots where
// the IDs go. Null when the template's literal parts don't frame the text
// (for example a template that rewrites the quote style).
function extractIds(text: string, shape: string): string[] | null {
  const parts = shape.split(SLOTS_RE);
  if (parts.length < 2) return null;
  const re = new RegExp(`^${parts.map(escapeRegExp).join("([\\s\\S]+?)")}$`);
  const m = text.match(re);
  return m ? [...new Set(m.slice(1))] : null;
}

type Plannable = Pick<RegistryEntry, "pattern" | "flags" | "replacement_template">;

export function planFile(
  content: string,
  entry: Plannable,
  target: Pick<BumpTarget, "recommended" | "alias" | "aliases">,
): FilePlan {
  const global = compilePattern(entry.pattern, entry.flags);
  const sticky = new RegExp(entry.pattern, `${entry.flags}y`);
  const slotTemplate = fillTemplate(entry.replacement_template, {
    recommended: SLOT_RECOMMENDED,
    alias: SLOT_ALIAS,
  });

  const pinned: string[] = [];
  const changes: PinChange[] = [];
  let matches = 0;
  let updated = "";
  let cursor = 0;
  for (const m of content.matchAll(global)) {
    const text = m[0];
    const index = m.index ?? 0;
    if (!text.length) continue;
    matches++;
    const shape = expandAt(content, sticky, index, text.length, slotTemplate);
    const next = shape
      .split(SLOT_ALIAS)
      .join(target.alias)
      .split(SLOT_RECOMMENDED)
      .join(target.recommended);
    const ids = extractIds(text, shape);
    for (const id of ids ?? []) if (!pinned.includes(id)) pinned.push(id);
    const current = ids
      ? ids.every((id) => isCurrentPin(id, target))
      : next === text;
    updated += content.slice(cursor, index) + (current ? text : next);
    cursor = index + text.length;
    if (!current) {
      changes.push({
        line: content.slice(0, index).split("\n").length,
        from: ids?.join(", ") ?? text,
        to: extractIds(next, shape)?.join(", ") ?? next,
      });
    }
  }
  updated += content.slice(cursor);
  return { matches, pinned, changes, updated };
}

// ---------------------------------------------------------------------------
// Grouping, naming and PR text

export interface BumpGroup {
  repo: string;
  family: string;
  branch_prefix: string;
  entries: RegistryEntry[];
}

export function groupEntries(entries: RegistryEntry[]): BumpGroup[] {
  const groups = new Map<string, BumpGroup>();
  for (const e of entries) {
    const key = `${e.repo.toLowerCase()}\u0000${e.family}\u0000${e.branch_prefix}`;
    let g = groups.get(key);
    if (!g) {
      g = { repo: e.repo, family: e.family, branch_prefix: e.branch_prefix, entries: [] };
      groups.set(key, g);
    }
    g.entries.push(e);
  }
  return [...groups.values()];
}

const refSafe = (s: string) =>
  s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".");

// `<branch_prefix>/<provider.family>/<recommended>`. The family is its own
// path segment so older bump branches for this family (and only this family)
// can be found by prefix when a newer recommendation supersedes them.
export function branchName(prefix: string, family: string, recommended: string): string {
  return `${prefix}/${refSafe(family)}/${refSafe(recommended)}`;
}

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  google: "Google",
};

function familyLabel(target: BumpTarget): string {
  const fam =
    target.provider === "anthropic"
      ? target.family.charAt(0).toUpperCase() + target.family.slice(1)
      : target.family;
  return `${PROVIDER_LABEL[target.provider] ?? target.provider} ${fam}`;
}

function applyTextTemplate(
  template: string,
  vars: { family: string; recommended: string; from: string; to: string },
): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
  return out;
}

const cell = (s: string) => {
  const flat = s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  return flat.includes("`") ? `\`\` ${flat} \`\`` : `\`${flat}\``;
};

export const MARKER_PREFIX = "<!-- modelmonitor:bump";

interface PrText {
  title: string;
  commitMessage: string;
  body: string;
}

export function buildPrText(args: {
  repo: string;
  baseSha: string;
  target: BumpTarget;
  changed: FileResult[];
  unserved: string[];
  titleTemplate?: string;
  commitTemplate?: string;
  runUrl?: string;
}): PrText {
  const { repo, baseSha, target, changed, unserved, runUrl } = args;
  const all = changed.flatMap((f) => f.changes);
  const from = [...new Set(all.map((c) => c.from))].join(", ");
  const to = [...new Set(all.map((c) => c.to))].join(", ");
  const vars = { family: target.key, recommended: target.recommended, from, to };

  const title = args.titleTemplate
    ? applyTextTemplate(args.titleTemplate, vars)
    : `Upgrade ${familyLabel(target)} calls to ${to}, the recommended model`;

  const fileList = changed
    .map((f) => `- \`${f.file}\` (${f.changes.length} line${f.changes.length === 1 ? "" : "s"})`)
    .join("\n");
  const commitMessage = args.commitTemplate
    ? applyTextTemplate(args.commitTemplate, vars)
    : [
        title,
        "",
        `Moves ${target.key} pins from ${from} to ${to}, the model modelmonitor`,
        "recommends for this family today.",
        "",
        fileList,
      ].join("\n");

  const rows = changed.flatMap((f) =>
    f.changes.map(
      (c) =>
        `| [\`${f.file}\`](https://github.com/${repo}/blob/${baseSha}/${f.file}#L${c.line}) | ${c.line} | ${cell(c.from)} | ${cell(c.to)} |`,
    ),
  );

  const sections: string[] = [
    `${MARKER_PREFIX} family=${target.key} recommended=${target.recommended} -->`,
    `Moves \`${target.key}\` pins to \`${to}\`, the model [modelmonitor](https://github.com/JMill/modelmonitor) currently recommends for this family.`,
    "",
    "| File | Line | From | To |",
    "| --- | --- | --- | --- |",
    ...rows,
  ];
  if (unserved.length) {
    sections.push(
      "",
      `> [!WARNING]`,
      `> ${unserved.map((id) => `\`${id}\``).join(", ")} ${unserved.length === 1 ? "is" : "are"} no longer listed by the provider's models endpoint. Calls pinned to ${unserved.length === 1 ? "it" : "them"} may already be failing; merge this PR (or pin another model) soon.`,
    );
  }
  const notes = renderMigrationNotes(target.provider, [...new Set(changed.flatMap((f) => f.pinned))], target.recommended);
  if (notes) sections.push("", notes);
  sections.push(
    "",
    "---",
    `Opened by modelmonitor. Closing this PR without merging opts this repo out of \`${target.recommended}\` for \`${target.key}\`: it will not be reopened. A newer recommendation opens a fresh PR and closes this one as superseded.`,
  );
  if (runUrl) sections.push(`Run: ${runUrl}`);
  return { title, commitMessage, body: sections.join("\n") };
}

// ---------------------------------------------------------------------------
// GitHub I/O

type BlobMode = "100644" | "100755";
const isBlobMode = (m: unknown): m is BlobMode => m === "100644" || m === "100755";

interface TreeEntry {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string;
}

const statusOf = (err: unknown) => (err as { status?: number } | null)?.status;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Read `path` as of the tree `rootTree`, walking one directory level at a
// time (cached per group). Unlike the contents API this works for files over
// 1 MB and returns the file mode, which the new tree entry must preserve.
async function readAtTree(
  octokit: Octokit,
  owner: string,
  repo: string,
  rootTree: string,
  path: string,
  cache: Map<string, TreeEntry[]>,
): Promise<{ content: string; mode: BlobMode } | { error: string }> {
  const segments = path.split("/").filter(Boolean);
  let treeSha = rootTree;
  for (const [i, name] of segments.entries()) {
    let entries = cache.get(treeSha);
    if (!entries) {
      entries = (await octokit.git.getTree({ owner, repo, tree_sha: treeSha })).data.tree;
      cache.set(treeSha, entries);
    }
    const entry = entries.find((e) => e.path === name);
    if (!entry?.sha) return { error: `${path} not found on the default branch` };
    if (i < segments.length - 1) {
      if (entry.type !== "tree") return { error: `${path} not found on the default branch` };
      treeSha = entry.sha;
      continue;
    }
    if (entry.type !== "blob" || !isBlobMode(entry.mode)) {
      return { error: `${path} is not a regular file` };
    }
    const blob = await octokit.git.getBlob({ owner, repo, file_sha: entry.sha });
    const encoding = blob.data.encoding === "base64" ? "base64" : "utf8";
    return {
      content: Buffer.from(blob.data.content, encoding).toString("utf8"),
      mode: entry.mode,
    };
  }
  return { error: `${path} not found on the default branch` };
}

async function closeSuperseded(
  octokit: Octokit,
  owner: string,
  repo: string,
  group: BumpGroup,
  branch: string,
  replacement: { number: number; url: string },
  target: BumpTarget,
): Promise<string[]> {
  const prefix = `${group.branch_prefix}/${refSafe(group.family)}/`;
  const open = await octokit.paginate(octokit.pulls.list, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });
  const closed: string[] = [];
  for (const pr of open) {
    const sameRepo =
      pr.head.repo?.full_name?.toLowerCase() === `${owner}/${repo}`.toLowerCase();
    if (!sameRepo || pr.head.ref === branch || !pr.head.ref.startsWith(prefix)) continue;
    try {
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: pr.number,
        body: `Superseded by #${replacement.number} (${replacement.url}): \`${target.key}\` now recommends \`${target.recommended}\`. Closing this one in its favour.`,
      });
      await octokit.pulls.update({ owner, repo, pull_number: pr.number, state: "closed" });
      closed.push(pr.html_url);
    } catch (err) {
      console.warn(`[${group.repo}] could not close superseded PR #${pr.number}: ${messageOf(err)}`);
    }
  }
  return closed;
}

export async function bumpGroup(
  octokit: Octokit,
  group: BumpGroup,
  manifest: Manifest,
  runUrl: string | undefined,
): Promise<GroupResult> {
  const result: GroupResult = {
    repo: group.repo,
    family: group.family,
    branch_prefix: group.branch_prefix,
    files: group.entries.map((e) => e.file),
    status: "failed",
    file_results: [],
    unserved: [],
    superseded: [],
  };
  const target = resolveTarget(manifest, group.family);
  if (!target) {
    result.error = `family ${group.family} is not in the manifest`;
    return result;
  }
  result.recommended = target.recommended;
  const [owner, repo] = group.repo.split("/");
  const branch = branchName(group.branch_prefix, group.family, target.recommended);
  result.branch = branch;

  // One consistent snapshot: every file is read from the same base commit the
  // bump commit is parented on, so a concurrent push can't be overwritten.
  const baseBranch = (await octokit.repos.get({ owner, repo })).data.default_branch;
  const baseSha = (await octokit.git.getRef({ owner, repo, ref: `heads/${baseBranch}` }))
    .data.object.sha;
  const baseTree = (await octokit.git.getCommit({ owner, repo, commit_sha: baseSha }))
    .data.tree.sha;

  const cache = new Map<string, TreeEntry[]>();
  const updates: { path: string; mode: BlobMode; content: string }[] = [];
  for (const entry of group.entries) {
    const read = await readAtTree(octokit, owner, repo, baseTree, entry.file, cache);
    if ("error" in read) {
      result.file_results.push({
        file: entry.file,
        status: "error",
        matches: 0,
        pinned: [],
        changes: [],
        error: read.error,
      });
      continue;
    }
    const plan = planFile(read.content, entry, target);
    const status =
      plan.matches === 0 ? "no_match" : plan.changes.length ? "changed" : "current";
    result.file_results.push({
      file: entry.file,
      status,
      matches: plan.matches,
      pinned: plan.pinned,
      changes: plan.changes,
    });
    for (const id of plan.pinned) {
      if (!isCurrentPin(id, target) && !isServed(manifest, target.provider, id)) {
        if (!result.unserved.includes(id)) result.unserved.push(id);
      }
    }
    if (status === "changed") {
      updates.push({ path: entry.file, mode: read.mode, content: plan.updated });
    }
  }

  const changed = result.file_results.filter((f) => f.status === "changed");
  if (!changed.length) {
    const statuses = result.file_results.map((f) => f.status);
    if (statuses.every((s) => s === "no_match")) {
      result.status = "skipped_no_match";
    } else if (statuses.includes("error")) {
      result.error = result.file_results
        .filter((f) => f.error)
        .map((f) => f.error)
        .join("; ");
    } else {
      result.status = "skipped_already_current";
    }
    return result;
  }

  const prs = (
    await octokit.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: "all" })
  ).data;
  const open = prs.find((p) => p.state === "open");
  if (open) {
    result.status = "skipped_existing_pr";
    result.url = open.html_url;
    // Re-run the sweep so an older PR that a failed sweep left open still
    // gets closed in favour of this one.
    result.superseded = await closeSuperseded(
      octokit,
      owner,
      repo,
      group,
      branch,
      { number: open.number, url: open.html_url },
      target,
    ).catch((err) => {
      console.warn(`[${group.repo}] superseded-PR sweep failed: ${messageOf(err)}`);
      return [];
    });
    return result;
  }
  const declined = prs.find((p) => p.state === "closed" && !p.merged_at);
  if (declined) {
    result.status = "skipped_declined";
    result.url = declined.html_url;
    return result;
  }

  const first = group.entries[0];
  const text = buildPrText({
    repo: group.repo,
    baseSha,
    target,
    changed,
    unserved: result.unserved,
    titleTemplate: first.title_template,
    commitTemplate: first.commit_template,
    runUrl,
  });

  // Objects first: blobs, tree and commit are unreachable until a ref points
  // at them, so a failure here leaves nothing behind.
  const tree = [];
  for (const u of updates) {
    const blob = await octokit.git.createBlob({
      owner,
      repo,
      content: Buffer.from(u.content, "utf8").toString("base64"),
      encoding: "base64",
    });
    tree.push({ path: u.path, mode: u.mode, type: "blob" as const, sha: blob.data.sha });
  }
  const newTree = await octokit.git.createTree({ owner, repo, base_tree: baseTree, tree });
  const commit = await octokit.git.createCommit({
    owner,
    repo,
    message: text.commitMessage,
    tree: newTree.data.sha,
    parents: [baseSha],
  });

  let branchExists = true;
  try {
    await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
  } catch (err) {
    if (statusOf(err) !== 404) throw err;
    branchExists = false;
  }

  try {
    if (branchExists) {
      // Left behind without an open or declined PR (a failed run, a merged
      // PR whose branch wasn't deleted): safe to reset.
      await octokit.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: commit.data.sha,
        force: true,
      });
    } else {
      await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: commit.data.sha,
      });
    }
    const pr = await octokit.pulls.create({
      owner,
      repo,
      head: branch,
      base: baseBranch,
      title: text.title,
      body: text.body,
    });
    result.status = "opened";
    result.url = pr.data.html_url;

    const reviewers = [...new Set(group.entries.flatMap((e) => e.reviewers))];
    if (reviewers.length) {
      await octokit.pulls
        .requestReviewers({ owner, repo, pull_number: pr.data.number, reviewers })
        .catch((err) => {
          console.warn(`[${group.repo}] requestReviewers failed: ${messageOf(err)}`);
        });
    }

    result.superseded = await closeSuperseded(
      octokit,
      owner,
      repo,
      group,
      branch,
      { number: pr.data.number, url: pr.data.html_url },
      target,
    ).catch((err) => {
      console.warn(`[${group.repo}] superseded-PR sweep failed: ${messageOf(err)}`);
      return [];
    });
    return result;
  } catch (err) {
    if (result.status !== "opened") {
      await octokit.git
        .deleteRef({ owner, repo, ref: `heads/${branch}` })
        .catch((cleanupErr) => {
          console.warn(
            `[${group.repo}] could not delete ${branch} after a failed bump: ${messageOf(cleanupErr)}`,
          );
        });
    }
    throw err;
  }
}

// Run every group. A group that throws is reported as failed and the rest
// still run: one consumer's problem never blocks another's bump.
export async function bumpAll(
  octokit: Octokit,
  entries: RegistryEntry[],
  manifest: Manifest,
  runUrl: string | undefined,
): Promise<GroupResult[]> {
  const results: GroupResult[] = [];
  for (const group of groupEntries(entries)) {
    try {
      results.push(await bumpGroup(octokit, group, manifest, runUrl));
    } catch (err) {
      results.push({
        repo: group.repo,
        family: group.family,
        branch_prefix: group.branch_prefix,
        files: group.entries.map((e) => e.file),
        status: "failed",
        error: messageOf(err),
        file_results: [],
        unserved: [],
        superseded: [],
      });
    }
  }
  return results;
}
