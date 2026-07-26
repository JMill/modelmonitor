import Anthropic from "@anthropic-ai/sdk";
import type { ModelInfo, ProviderResult, ProviderSnapshot } from "../types.ts";
import { pickRecommended } from "../rank.ts";

// Modern IDs put the family first: `claude-<family>-<version>[-<date>]`
// (claude-opus-5, claude-fable-5, claude-haiku-4-5-20251001).
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

export async function fetchModels(apiKey: string): Promise<ProviderResult> {
  const client = new Anthropic({ apiKey });
  const models: ModelInfo[] = [];
  for await (const m of client.models.list()) {
    const id = (m as { id: string }).id;
    const created_at = (m as { created_at?: string }).created_at;
    const display_name = (m as { display_name?: string }).display_name;
    models.push({
      id,
      display_name,
      created_at,
      deprecated: false,
    });
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
    snapshot.families[fam] = {
      recommended: pickRecommended(list, (m) => m.created_at ?? ""),
      all: list,
    };
  }
  return { snapshot, unclassified: unclassified.sort() };
}
