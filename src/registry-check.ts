import yaml from "js-yaml";
import {
  aliasUnavailable,
  groupEntries,
  isCurrentPin,
  isServed,
  planFile,
  resolveTarget,
} from "./pr-bumper.ts";
import { Registry, type Manifest } from "./types.ts";

// Static and (optionally) local checks for registry.yml, behind
// `npm run registry:check`. The bump run itself only finds a broken entry on
// the morning it runs, and a registry-level error (bad YAML, one invalid
// entry) stops every consumer's bump that day, so CI runs this first.
//
// Static: the YAML parses, every entry passes the zod schema (patterns
// compile, templates carry a placeholder, (repo, file, family) is unique),
// and every family is published in the manifest.
//
// Local (`--local owner/repo=/path/to/checkout`): reads each entry's file
// from the checkout and reports how many times the pattern matches, which
// IDs it pins, and whether a bump run would change the file today, using the
// same planFile / isCurrentPin logic as the bumper.

export interface CheckReport {
  errors: string[];
  warnings: string[];
  lines: string[];
}

export interface CheckOptions {
  rawYaml: string;
  manifest: Manifest | null;
  // Lower-cased owner/repo -> checkout root.
  locals: Map<string, string>;
  readLocal: (root: string, file: string) => Promise<string | null>;
}

export async function checkRegistry(opts: CheckOptions): Promise<CheckReport> {
  const report: CheckReport = { errors: [], warnings: [], lines: [] };
  const { errors, warnings, lines } = report;

  let doc: unknown;
  try {
    doc = yaml.load(opts.rawYaml);
  } catch (err) {
    errors.push(`registry.yml is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
    return report;
  }
  const parsed = Registry.safeParse(doc);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join(".") || "registry"}: ${issue.message}`);
    }
    return report;
  }
  const consumers = parsed.data.consumers;
  lines.push(`registry.yml: ${consumers.length} consumer entr${consumers.length === 1 ? "y" : "ies"}`);
  if (!opts.manifest) {
    errors.push("no manifest to check families against (docs/models.json missing)");
    return report;
  }
  const manifest = opts.manifest;
  const published = Object.entries(manifest.providers).flatMap(([p, snap]) =>
    Object.keys(snap?.families ?? {}).map((f) => `${p}.${f}`),
  );

  for (const g of groupEntries(consumers)) {
    const [first, ...rest] = g.entries;
    for (const field of ["title_template", "commit_template"] as const) {
      if (rest.some((e) => e[field] !== first[field])) {
        warnings.push(
          `${g.repo} ${g.family} (${g.branch_prefix}): entries share one PR but disagree on ${field}; the first entry's (${first.file}) is used`,
        );
      }
    }
  }

  const usedLocals = new Set<string>();
  for (const [i, entry] of consumers.entries()) {
    const label = `consumers[${i}] ${entry.repo} ${entry.file} ${entry.family}`;
    const target = resolveTarget(manifest, entry.family);
    if (!target) {
      errors.push(
        `${label}: family is not published in docs/models.json (published: ${published.join(", ")})`,
      );
      continue;
    }
    lines.push(`${label} -> ${target.recommended}${target.alias !== target.recommended ? ` (alias ${target.alias})` : ""}`);

    const root = opts.locals.get(entry.repo.toLowerCase());
    if (!root) {
      if (opts.locals.size) lines.push(`  not checked locally (no --local for ${entry.repo})`);
      continue;
    }
    usedLocals.add(entry.repo.toLowerCase());
    const content = await opts.readLocal(root, entry.file);
    if (content === null) {
      errors.push(`${label}: ${entry.file} not found under ${root}`);
      continue;
    }
    const plan = planFile(content, entry, target);
    if (plan.matches === 0) {
      errors.push(`${label}: pattern matches nothing in ${root}/${entry.file}`);
      continue;
    }
    if (plan.matches > 1) {
      warnings.push(`${label}: pattern matches ${plan.matches} times; every match is rewritten on a bump`);
    }
    const pinned = plan.pinned.length ? plan.pinned.join(", ") : "(ID not isolated by the template)";
    if (!plan.pinned.length) {
      warnings.push(
        `${label}: the template doesn't reproduce the text around the ID (a different quote style, say), so the pinned ID can't be isolated: an alias pin is only recognised through a capture group, retired pins aren't flagged, and the PR shows whole matches. Capture the surrounding text and write it back with $1/$2`,
      );
    }
    const bump = plan.changes.length
      ? `would change ${plan.changes.map((c) => `line ${c.line}: ${c.from} -> ${c.to}`).join("; ")}`
      : "current, no bump";
    lines.push(`  matches: ${plan.matches}, pinned: ${pinned}, ${bump}`);
    if (plan.changes.length && aliasUnavailable(entry, target)) {
      warnings.push(
        `${label}: a bump today would be skipped: ${target.recommended} has no verified undated alias for {recommended_alias}`,
      );
    }
    for (const id of plan.pinned) {
      if (!isCurrentPin(id, target) && !isServed(manifest, target.provider, id)) {
        warnings.push(`${label}: pinned ${id} is no longer listed by ${target.provider}`);
      }
    }
  }
  for (const repo of opts.locals.keys()) {
    if (!usedLocals.has(repo)) warnings.push(`--local ${repo}: no registry entry for this repo`);
  }
  return report;
}
