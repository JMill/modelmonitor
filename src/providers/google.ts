import type { ModelInfo, ProviderResult, ProviderSnapshot } from "../types.ts";
import { naturalCompare, pickRecommended } from "../rank.ts";

interface GoogleModel {
  name: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
  version?: string;
}

const FAMILY_RE = /^(gemini-\d+(?:\.\d+)?(?:-(?:flash|pro|nano|ultra))?)/;

export function detectFamily(bareId: string): string | null {
  const m = bareId.match(FAMILY_RE);
  return m ? m[1] : null;
}

export async function fetchModels(apiKey: string): Promise<ProviderResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`google models list failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { models?: GoogleModel[] };
  const families: Record<string, ModelInfo[]> = {};
  const unclassified: string[] = [];
  for (const m of body.models ?? []) {
    // Embedding/tuning endpoints are out of scope rather than unclassified.
    if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
    const bareId = m.name.replace(/^models\//, "");
    const fam = detectFamily(bareId);
    if (!fam) {
      unclassified.push(bareId);
      continue;
    }
    (families[fam] ??= []).push({
      id: bareId,
      display_name: m.displayName,
      deprecated: false,
    });
  }

  const snapshot: ProviderSnapshot = { families: {} };
  for (const [fam, items] of Object.entries(families)) {
    // Google's list carries no timestamps, so recency comes from the ID.
    items.sort((a, b) => naturalCompare(b.id, a.id));
    snapshot.families[fam] = {
      recommended: pickRecommended(items, (m) => m.id, naturalCompare),
      all: items,
    };
  }
  return { snapshot, unclassified: unclassified.sort() };
}
