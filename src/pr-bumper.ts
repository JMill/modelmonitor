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
//      alone (its branch is never reset); a closed, unmerged one is the
//      consumer declining this ID and is respected as an opt-out, unless
//      modelmonitor itself closed it as superseded.
//   4. Build the commit with the git data API (blobs -> tree -> commit)
//      parented on that same base commit, then point the branch at it
//      (creating it, or resetting a branch left behind without a PR).
//   5. Open the PR, request reviewers, and close older open bump PRs for the
//      same family as superseded.
// Every call after step 1 uses the repo's canonical owner and name from
// repos.get, not the registry's spelling: reads of a renamed or transferred
// repo follow a redirect, but the `owner:branch` head filter and
// head.repo.full_name only ever match the current name.
// A failure after the branch moves undoes only what this run did: a branch
// it created is deleted, a branch it reset goes back to its previous commit.
// A pre-existing branch is never deleted.

export type BumpStatus =
  | "opened"
  | "skipped_already_current"
  | "skipped_no_match"
  | "skipped_existing_pr"
  | "skipped_declined"
  // An entry writes {recommended_alias}, but the dated recommended ID has no
  // alias in the manifest today; see aliasUnavailable().
  | "skipped_no_alias"
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
  // Set when GitHub resolves `repo` to a different owner/name (the repo was
  // renamed or transferred): the registry entry should be updated.
  resolved_repo?: string;
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

// Whether `entry` would write a dated snapshot where it asked for the alias:
// it uses {recommended_alias}, the recommended ID is dated, and the manifest
// carries no alias for it (the refresh's alias lookup failed, or the model
// has no alias yet). Writing the dated ID then would stick: once merged, it
// equals `recommended`, so later runs call it current and never move it to
// the alias. Such a bump is skipped for the run instead.
export function aliasUnavailable(
  entry: Pick<RegistryEntry, "replacement_template">,
  target: Pick<BumpTarget, "recommended" | "alias">,
): boolean {
  return (
    entry.replacement_template.includes("{recommended_alias}") &&
    target.alias === target.recommended &&
    /-\d{8}$/.test(target.recommended)
  );
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
    // When the template doesn't reproduce the text around the ID (it changes
    // the quote style, say), the ID can't be isolated. Fall back to the
    // capture groups: a group holding the recommended ID or one of its
    // aliases means the match already pins the current model, so an alias
    // pin isn't rewritten to the dated ID it names.
    const current = ids
      ? ids.every((id) => isCurrentPin(id, target))
      : next === text || m.slice(1).some((g) => g !== undefined && isCurrentPin(g, target));
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

// Appended to the body of a bump PR modelmonitor closes as superseded, so a
// later run can tell that close apart from a person declining the bump. If
// the recommendation later returns to that PR's ID, a fresh PR opens.
export const SUPERSEDED_MARKER = "<!-- modelmonitor:superseded -->";

const closedAsSuperseded = (pr: { body?: string | null }) =>
  (pr.body ?? "").includes(SUPERSEDED_MARKER);

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

// The canonical coordinates of a consumer repo, from repos.get.
interface RepoRef {
  owner: string;
  repo: string;
  fullName: string;
}

interface ListedPr {
  number: number;
  state: string;
  merged_at: string | null;
  html_url: string;
  body?: string | null;
  head: { ref: string; repo: { full_name?: string } | null };
}

// A PR whose head branch lives in the consumer repo itself, not a fork that
// happens to use the same branch name.
const headIsIn = (pr: ListedPr, where: RepoRef) =>
  pr.head.repo?.full_name?.toLowerCase() === where.fullName.toLowerCase();

// An older bump branch of this group: `<prefix>/<family>/<one segment>`.
// Exactly one trailing segment, so a group whose branch_prefix happens to
// be `<prefix>/<family>` (and so nests under this one) is never swept.
function isOlderBumpBranch(ref: string, group: BumpGroup, branch: string): boolean {
  const prefix = `${group.branch_prefix}/${refSafe(group.family)}/`;
  if (ref === branch || !ref.startsWith(prefix)) return false;
  const rest = ref.slice(prefix.length);
  return rest.length > 0 && !rest.includes("/");
}

// Close this group's other open bump PRs: they pin an ID that is no longer
// the recommendation. `current` is the PR for today's branch: the one just
// opened or already open ("replaced"), or the one the repo closed unmerged
// ("declined"). Each closed PR gets SUPERSEDED_MARKER in its body.
async function closeSuperseded(
  octokit: Octokit,
  where: RepoRef,
  open: ListedPr[],
  group: BumpGroup,
  branch: string,
  // null: the default branch already pins the recommendation, so there is
  // no newer PR to point at, but older bump PRs are still obsolete.
  current: { number: number; url: string; declined?: boolean } | null,
  target: BumpTarget,
): Promise<string[]> {
  const { owner, repo } = where;
  const closed: string[] = [];
  for (const pr of open) {
    if (!headIsIn(pr, where) || !isOlderBumpBranch(pr.head.ref, group, branch)) continue;
    const why = !current
      ? `\`${target.key}\` now recommends \`${target.recommended}\`, and the default branch already uses it. Closing this bump because merging it would move the repo to a model that is no longer the recommendation.`
      : current.declined
        ? `\`${target.key}\` now recommends \`${target.recommended}\`, which this repo declined in #${current.number} (${current.url}). Closing this bump because its model is no longer the recommendation.`
        : `Superseded by #${current.number} (${current.url}): \`${target.key}\` now recommends \`${target.recommended}\`. Closing this one in its favour.`;
    try {
      await octokit.issues.createComment({ owner, repo, issue_number: pr.number, body: why });
      await octokit.pulls.update({
        owner,
        repo,
        pull_number: pr.number,
        state: "closed",
        body: `${pr.body ?? ""}\n\n${SUPERSEDED_MARKER}`,
      });
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
  const branch = branchName(group.branch_prefix, group.family, target.recommended);
  result.branch = branch;

  // Canonical coordinates first: every later call, the head filter and the
  // same-repo check use GitHub's current owner/name, never the registry's.
  const [regOwner, regRepo] = group.repo.split("/");
  const info = (await octokit.repos.get({ owner: regOwner, repo: regRepo })).data;
  const where: RepoRef = { owner: info.owner.login, repo: info.name, fullName: info.full_name };
  const { owner, repo } = where;
  if (where.fullName.toLowerCase() !== group.repo.toLowerCase()) {
    result.resolved_repo = where.fullName;
  }

  // One consistent snapshot: every file is read from the same base commit the
  // bump commit is parented on, so a concurrent push can't be overwritten.
  const baseBranch = info.default_branch;
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
  const needsAlias = group.entries.filter(
    (e) => aliasUnavailable(e, target) && changed.some((f) => f.file === e.file),
  );
  if (needsAlias.length) {
    // The whole group waits: its files must move together.
    result.status = "skipped_no_alias";
    result.error = `${target.recommended} has no verified undated alias in the manifest today, and ${needsAlias.map((e) => e.file).join(", ")} write${needsAlias.length === 1 ? "s" : ""} {recommended_alias}; skipped rather than pinning the dated ID`;
    return result;
  }
  const incomplete = result.file_results.filter(
    (f) => f.status === "no_match" || f.status === "error",
  );
  if (changed.length && incomplete.length) {
    // A group's files move together: consumers hold their mirrors equal with
    // drift or parity tests, so a PR that bumps some files and not others
    // fails their CI, and a partial branch would outlive the registry fix.
    // Hold the whole group and let the alert name what to repair.
    result.status = "failed";
    result.error = `no PR opened: this group's files change together, and ${incomplete
      .map((f) => `${f.file} ${f.status === "error" ? `could not be read (${f.error})` : "matched nothing"}`)
      .join("; ")}`;
    return result;
  }
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
      // The default branch is already on the recommendation (a manual
      // upgrade, or an earlier bump merged): older bump PRs for this family
      // would now move it backwards, so sweep them too.
      const openPrs: ListedPr[] = await octokit.paginate(octokit.pulls.list, {
        owner,
        repo,
        state: "open",
        per_page: 100,
      });
      result.superseded = await closeSuperseded(
        octokit,
        where,
        openPrs,
        group,
        branch,
        null,
        target,
      ).catch((err) => {
        console.warn(`[${group.repo}] superseded-PR sweep failed: ${messageOf(err)}`);
        return [] as string[];
      });
    }
    return result;
  }

  // PRs for this exact branch (any state), plus every open PR: the open list
  // double-checks the head-filtered lookup before a branch is ever reset, and
  // feeds the superseded sweep.
  const forBranch = (
    await octokit.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: "all", per_page: 100 })
  ).data.filter((p) => headIsIn(p, where) && p.head.ref === branch);
  const openPrs: ListedPr[] = await octokit.paginate(octokit.pulls.list, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });
  const sweep = (current: { number: number; url: string; declined?: boolean }) =>
    closeSuperseded(octokit, where, openPrs, group, branch, current, target).catch((err) => {
      console.warn(`[${group.repo}] superseded-PR sweep failed: ${messageOf(err)}`);
      return [] as string[];
    });

  const open =
    forBranch.find((p) => p.state === "open") ??
    openPrs.find((p) => headIsIn(p, where) && p.head.ref === branch);
  if (open) {
    result.status = "skipped_existing_pr";
    result.url = open.html_url;
    // Re-run the sweep so an older PR that a failed sweep left open still
    // gets closed in favour of this one.
    result.superseded = await sweep({ number: open.number, url: open.html_url });
    return result;
  }
  // Closed unmerged by a person. A PR modelmonitor closed as superseded is
  // not an opt-out: the recommendation came back to this ID.
  const declined = forBranch.find(
    (p) => p.state === "closed" && !p.merged_at && !closedAsSuperseded(p),
  );
  if (declined) {
    result.status = "skipped_declined";
    result.url = declined.html_url;
    // Older bump PRs still point at IDs that are no longer recommended.
    result.superseded = await sweep({
      number: declined.number,
      url: declined.html_url,
      declined: true,
    });
    return result;
  }

  const first = group.entries[0];
  const text = buildPrText({
    repo: where.fullName,
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

  // The branch's commit before this run touched it, when it already existed.
  let previousSha: string | undefined;
  try {
    previousSha = (await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` })).data.object
      .sha;
  } catch (err) {
    if (statusOf(err) !== 404) throw err;
  }

  // What this run did to the branch, so a failure undoes exactly that.
  let moved: "created" | "reset" | undefined;
  const undoBranch = async () => {
    try {
      if (moved === "created") {
        await octokit.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
      } else if (moved === "reset" && previousSha) {
        await octokit.git.updateRef({
          owner,
          repo,
          ref: `heads/${branch}`,
          sha: previousSha,
          force: true,
        });
      }
    } catch (err) {
      console.warn(`[${group.repo}] could not undo ${branch} after a failed bump: ${messageOf(err)}`);
    }
  };

  try {
    if (previousSha) {
      // Left behind without an open or declined PR (a failed run, a merged
      // PR whose branch wasn't deleted): safe to reset. A branch with an open
      // PR returned above and is never reset.
      await octokit.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: commit.data.sha,
        force: true,
      });
      moved = "reset";
    } else {
      await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: commit.data.sha,
      });
      moved = "created";
    }

    let pr: { number: number; html_url: string; user?: { login: string } | null };
    try {
      pr = (
        await octokit.pulls.create({
          owner,
          repo,
          head: branch,
          base: baseBranch,
          title: text.title,
          body: text.body,
        })
      ).data;
    } catch (err) {
      if (!isPrAlreadyExists(err)) throw err;
      // A PR for this branch opened after the lookup above (or the lookup
      // missed it). It is someone's live PR: put a branch this run reset back
      // where it was, never delete the branch (that would close the PR), and
      // report the existing PR instead of a failure.
      if (moved === "reset") await undoBranch();
      moved = undefined;
      result.status = "skipped_existing_pr";
      const existing = await findOpenPr(octokit, where, branch);
      if (existing) {
        result.url = existing.html_url;
        result.superseded = await sweep({ number: existing.number, url: existing.html_url });
      } else {
        console.warn(`[${group.repo}] GitHub reports an open PR for ${branch} but it could not be listed`);
      }
      return result;
    }
    result.status = "opened";
    result.url = pr.html_url;

    // The PR's author (the token's owner) can't review it: GitHub rejects the
    // whole request with a 422, so ask only everyone else.
    const author = pr.user?.login?.toLowerCase();
    const reviewers = [...new Set(group.entries.flatMap((e) => e.reviewers))].filter(
      (r) => r.toLowerCase() !== author,
    );
    if (reviewers.length) {
      await octokit.pulls
        .requestReviewers({ owner, repo, pull_number: pr.number, reviewers })
        .catch((err) => {
          console.warn(`[${group.repo}] requestReviewers failed: ${messageOf(err)}`);
        });
    }

    result.superseded = await sweep({ number: pr.number, url: pr.html_url });
    return result;
  } catch (err) {
    if (result.status !== "opened") await undoBranch();
    throw err;
  }
}

// GitHub's 422 for a second PR on the same head. Octokit folds the
// validation errors into the message; check the raw errors too.
function isPrAlreadyExists(err: unknown): boolean {
  if (statusOf(err) !== 422) return false;
  const data = (err as { response?: { data?: unknown } }).response?.data;
  return /pull request already exists/i.test(`${messageOf(err)} ${JSON.stringify(data ?? "")}`);
}

async function findOpenPr(
  octokit: Octokit,
  where: RepoRef,
  branch: string,
): Promise<ListedPr | undefined> {
  try {
    const { owner, repo } = where;
    return (
      await octokit.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: "open" })
    ).data.find((p) => headIsIn(p, where) && p.head.ref === branch);
  } catch (err) {
    console.warn(`[${where.fullName}] could not list PRs for ${branch}: ${messageOf(err)}`);
    return undefined;
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
