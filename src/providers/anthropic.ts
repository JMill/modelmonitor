import Anthropic from "@anthropic-ai/sdk";
import type { ModelInfo, ProviderResult, ProviderSnapshot } from "../types.ts";
import { pickRecommended } from "../rank.ts";

// Modern IDs put the family first: `claude-<family>-<version>[-<date>]`
// (claude-opus-5-5, claude-fable-5-1, claude-haiku-4-5-20251001).
const MODERN_RE = /^claude-([a-z]+)-\d/;
// Legacy IDs put the version first: `claude-<version>-<family>-<date>`
// (claude-3-5-sonnet-20241022, claude-3-opus-20240229).
const LEGACY_RE = /^claude-[\d.-]+-([a-z]+)/;

// Derived, not enumerated. The previous rule hardcoded opus|sonnet|haiku, so
// every model in a family nobody had listed yet was dropped on the floor —
// which is how Fable went missing from the manifest. Capturing the family
// instead means the next one lands in the manifest on its first refresh.
export function detectFamily(id: string): string | null {
  const m = id.match(MODERN_RE) ?? id.match(LEGACY_RE);
  return m ? m[1] : null;
}

// The slice of the SDK client this module uses. The real `Anthropic` client
// satisfies it; tests pass a stub.
export interface AnthropicModelsClient {
  models: {
    list(params?: { limit?: number }): AsyncIterable<Anthropic.ModelInfo>;
    retrieve(modelID: string): PromiseLike<Anthropic.ModelInfo>;
  };
}

const DATE_SUFFIX_RE = /-\d{8}$/;

// The Models API lists some models only under a dated ID
// (claude-haiku-4-5-20251001) while the documented, stable name is the
// undated alias (claude-haiku-4-5). Nothing in the list links the two, so the
// alias is derived by stripping the date and confirmed with models.retrieve:
// it counts only if the API resolves it back to this exact dated ID. Any
// error (a 404 for a date-only model, a transient failure) just means no
// alias is published this run; it never fails the refresh.
export async function deriveAliases(
  client: AnthropicModelsClient,
  ids: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const id of ids) {
    if (!DATE_SUFFIX_RE.test(id)) continue;
    const candidate = id.replace(DATE_SUFFIX_RE, "");
    try {
      const resolved = await client.models.retrieve(candidate);
      if (resolved.id === id) out.set(id, [candidate]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[anthropic] alias check for ${candidate} failed: ${msg}`);
    }
  }
  return out;
}

export async function fetchModels(
  apiKey: string,
  client: AnthropicModelsClient = new Anthropic({ apiKey }),
): Promise<ProviderResult> {
  const models: ModelInfo[] = [];
  // 1000 is the endpoint's page-size ceiling: one request instead of pages of 20.
  for await (const m of client.models.list({ limit: 1000 })) {
    models.push({
      id: m.id,
      display_name: m.display_name,
      created_at: m.created_at,
      // The Models API has no deprecation field; retired models just stop
      // being listed. See the README before relying on this.
      deprecated: false,
      max_input_tokens: m.max_input_tokens,
      max_tokens: m.max_tokens,
      // Shallow spread, not a cast: TypeScript won't treat an SDK interface
      // as a string-keyed record, but it accepts a plain copy of one.
      capabilities: m.capabilities ? { ...m.capabilities } : null,
    });
  }

  const aliases = await deriveAliases(
    client,
    models.map((m) => m.id),
  );
  for (const m of models) {
    const a = aliases.get(m.id);
    if (a) m.aliases = a;
  }

  const families: Record<string, ModelInfo[]> = {};
  const unclassified: string[] = [];
  for (const m of models) {
    const fam = detectFamily(m.id);
    if (!fam) {
      unclassified.push(m.id);
      continue;
    }
    (families[fam] ??= []).push(m);
  }

  const snapshot: ProviderSnapshot = { families: {} };
  for (const [fam, list] of Object.entries(families)) {
    list.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    const recommended = pickRecommended(list, (m) => m.created_at ?? "");
    const recommended_alias = list.find((m) => m.id === recommended)
      ?.aliases?.[0];
    snapshot.families[fam] = {
      recommended,
      ...(recommended_alias ? { recommended_alias } : {}),
      all: list,
    };
  }
  return { snapshot, unclassified: unclassified.sort() };
}
