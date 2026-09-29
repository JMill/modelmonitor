import { z } from "zod";

export const ProviderId = z.enum(["anthropic", "openai", "google"]);
export type ProviderId = z.infer<typeof ProviderId>;

// Every field added after the first published manifest is optional, so a
// v1 manifest written before it still parses. They must still be declared
// here: zod strips unknown keys, and readManifest() parses the previous
// manifest, so an undeclared field would silently vanish from `prev`.
// docs/schema.json mirrors this shape; tests/schema.test.ts fails on drift.
export const ModelInfo = z.object({
  id: z.string(),
  display_name: z.string().optional(),
  created_at: z.string().optional(),
  // No provider's models endpoint reports deprecation today, so this is
  // always false. Retired models simply stop being listed.
  deprecated: z.boolean().default(false),
  // Context window and output ceiling as the provider reports them (Anthropic
  // only). null means the API returned no value for this model.
  max_input_tokens: z.number().int().nullable().optional(),
  max_tokens: z.number().int().nullable().optional(),
  // Raw Anthropic capability tree, passed through untouched so leaves the API
  // adds later (a new effort level, a new context-management strategy) are
  // published without a code change. Leaves are `{ supported: boolean }`.
  capabilities: z.record(z.string(), z.unknown()).nullable().optional(),
  // Undated aliases verified to resolve to this dated ID (Anthropic only),
  // e.g. claude-haiku-4-5 for claude-haiku-4-5-20251001. An empty array is a
  // definite "none": the undated name was checked and is another model or
  // doesn't exist. Absent means unknown (not checked, or the check failed).
  aliases: z.array(z.string()).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const Family = z.object({
  recommended: z.string(),
  // Verified undated alias of `recommended`, when it has one. Prefer it when
  // pinning: it is the ID the provider documents, and it doesn't churn.
  recommended_alias: z.string().optional(),
  all: z.array(ModelInfo),
});
export type Family = z.infer<typeof Family>;

export const ProviderSnapshot = z.object({
  families: z.record(z.string(), Family),
  // Diagnostic: model IDs the provider returned that no family rule matched.
  // Published so a naming change that outruns our rules is visible in the
  // manifest instead of silently disappearing from it. Omitted when empty.
  unclassified: z.array(z.string()).optional(),
});
export type ProviderSnapshot = z.infer<typeof ProviderSnapshot>;

// What a provider module returns. `unclassified` stays out of the snapshot
// unless it's non-empty, so the published manifest keeps its usual shape.
export interface ProviderResult {
  snapshot: ProviderSnapshot;
  unclassified: string[];
}

export const Manifest = z.object({
  $schema: z.string().optional(),
  version: z.literal("1"),
  generated_at: z.string(),
  providers: z.record(ProviderId, ProviderSnapshot),
});
export type Manifest = z.infer<typeof Manifest>;

// A replacement_template must name the ID it writes. A template with neither
// placeholder would stamp the same literal into the file on every bump.
export const TEMPLATE_PLACEHOLDERS = [
  "{recommended}",
  "{recommended_alias}",
] as const;

// Split a registry family key on its FIRST dot only. OpenAI and Google family
// keys carry dots of their own: splitting "openai.gpt-4.1" on every dot gives
// "gpt-4", which is a different published family, so a gpt-4.1 pin would be
// silently rewritten to gpt-4's recommended ID.
export function splitFamily(key: string): { provider: string; family: string } {
  const i = key.indexOf(".");
  return i < 0
    ? { provider: key, family: "" }
    : { provider: key.slice(0, i), family: key.slice(i + 1) };
}

// Every registry pattern is matched globally; `flags` adds i/m/s/u on top.
export function compilePattern(pattern: string, flags = ""): RegExp {
  return new RegExp(pattern, `g${flags}`);
}

// Registry `file` values go straight into the git tree API, which wants a
// plain repo-relative path. Anything else passes a local join() but fails
// (or writes the wrong entry) on bump day, and two spellings of one file
// would dodge the uniqueness check. Returns why `file` isn't one, or null.
export function repoPathProblem(file: string): string | null {
  const segments = file.split("/");
  const problems: string[] = [];
  if (file.startsWith("/")) problems.push('a leading "/"');
  if (file.endsWith("/")) problems.push('a trailing "/"');
  if (segments.slice(1, -1).includes("") || /\/\/+/.test(file)) problems.push("an empty segment");
  if (segments.includes(".")) problems.push('a "." segment');
  if (segments.includes("..")) problems.push('a ".." segment');
  if (!problems.length) return null;
  const tidy = segments.filter((s) => s !== "" && s !== ".").join("/");
  const hint = segments.includes("..") || !tidy ? "" : ` (write "${tidy}")`;
  return `must be a path relative to the repo root; found ${problems.join(", ")}${hint}`;
}

export const RegistryEntry = z
  .object({
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be owner/repo"),
    file: z
      .string()
      .min(1)
      .superRefine((file, ctx) => {
        const problem = repoPathProblem(file);
        if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
      }),
    // JS regex. Anchor it on the key or constant that holds the ID (see the
    // README) so it can't touch comments, docs or other families' lines.
    pattern: z.string().min(1),
    flags: z
      .string()
      .regex(/^[imsu]*$/, "only i, m, s and u are allowed (g is always on)")
      .default(""),
    replacement_template: z
      .string()
      .refine((t) => TEMPLATE_PLACEHOLDERS.some((p) => t.includes(p)), {
        message: `must contain ${TEMPLATE_PLACEHOLDERS.join(" or ")}`,
      }),
    family: z
      .string()
      .regex(/^[a-z]+\.[a-z0-9][a-z0-9.-]*$/, "must be provider.family"),
    branch_prefix: z
      .string()
      .regex(
        /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/,
        "must be a slash-separated git ref path",
      )
      .refine((p) => !p.includes(".."), "must not contain '..'")
      // Git's ref rules (git check-ref-format --branch): a branch can't
      // start with '-', and no path component may end in '.' or '.lock'.
      // The charset regex above already rules out the rest.
      .refine((p) => !p.startsWith("-"), "must not start with '-'")
      .refine(
        (p) => p.split("/").every((c) => !c.endsWith(".") && !c.endsWith(".lock")),
        "no path component may end in '.' or '.lock'",
      )
      .default("chore/model-bump"),
    reviewers: z.array(z.string()).default([]),
    // PR title / commit subject overrides; {family}, {recommended}, {from}
    // and {to} are substituted. Entries that share a PR (same repo, family
    // and branch_prefix) should agree; where they don't, the first wins.
    title_template: z.string().min(1).optional(),
    commit_template: z.string().min(1).optional(),
  })
  .superRefine((entry, ctx) => {
    // Compile at parse time: a bad pattern fails validation (and CI) instead
    // of throwing inside one entry on the day it first runs.
    let re: RegExp;
    try {
      re = compilePattern(entry.pattern, entry.flags);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pattern"],
        message: `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    if (re.test("")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pattern"],
        message: "pattern matches the empty string",
      });
    }
    const { provider } = splitFamily(entry.family);
    if (!ProviderId.safeParse(provider).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["family"],
        message: `unknown provider "${provider}" (expected one of ${ProviderId.options.join(", ")})`,
      });
    }
  });
export type RegistryEntry = z.infer<typeof RegistryEntry>;

export const Registry = z
  .object({
    consumers: z.array(RegistryEntry),
  })
  .superRefine((registry, ctx) => {
    // One entry per (repo, file, family). A duplicate would race its twin
    // for the same lines. GitHub repo names are case-insensitive.
    const seen = new Map<string, number>();
    registry.consumers.forEach((e, i) => {
      const key = `${e.repo.toLowerCase()}\u0000${e.file}\u0000${e.family}`;
      const first = seen.get(key);
      if (first === undefined) {
        seen.set(key, i);
        return;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["consumers", i],
        message: `duplicate (repo, file, family) ${e.repo} ${e.file} ${e.family}; first declared at consumers[${first}]`,
      });
    });
  });
export type Registry = z.infer<typeof Registry>;

export type DiffEntry =
  | { kind: "added"; provider: ProviderId; family: string; model: string }
  | { kind: "removed"; provider: ProviderId; family: string; model: string }
  | {
      kind: "recommended_changed";
      provider: ProviderId;
      family: string;
      from: string;
      to: string;
    };

export type AlertEntry =
  | { kind: "provider_failed"; provider: ProviderId; error: string }
  | {
      kind: "no_successor";
      provider: ProviderId;
      family: string;
      lost: string;
    }
  | {
      kind: "unclassified_models";
      provider: ProviderId;
      models: string[];
    }
  | { kind: "schema_invalid"; error: string }
  | { kind: "no_providers_configured"; error: string };
