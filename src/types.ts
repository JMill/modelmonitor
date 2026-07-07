import { z } from "zod";

export const ProviderId = z.enum(["anthropic", "openai", "google"]);
export type ProviderId = z.infer<typeof ProviderId>;

export const ModelInfo = z.object({
  id: z.string(),
  display_name: z.string().optional(),
  created_at: z.string().optional(),
  deprecated: z.boolean().default(false),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const Family = z.object({
  recommended: z.string(),
  all: z.array(ModelInfo),
});
export type Family = z.infer<typeof Family>;

export const ProviderSnapshot = z.object({
  families: z.record(z.string(), Family),
});
export type ProviderSnapshot = z.infer<typeof ProviderSnapshot>;

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
  | { kind: "schema_invalid"; error: string }
  | { kind: "no_providers_configured"; error: string };
