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
  // e.g. claude-haiku-4-5 for claude-haiku-4-5-20251001.
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

export const RegistryEntry = z.object({
  repo: z.string().regex(/^[^/]+\/[^/]+$/, "must be owner/repo"),
  file: z.string(),
  pattern: z.string(),
  replacement_template: z.string(),
  family: z.string().regex(/^[a-z]+\.[a-z0-9-]+$/, "must be provider.family"),
  branch_prefix: z.string().default("chore/model-bump"),
  reviewers: z.array(z.string()).default([]),
});
export type RegistryEntry = z.infer<typeof RegistryEntry>;

export const Registry = z.object({
  consumers: z.array(RegistryEntry),
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
