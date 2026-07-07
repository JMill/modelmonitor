import type { ModelInfo, ProviderSnapshot } from "../types.ts";
import { pickRecommended } from "../rank.ts";

interface GoogleModel {
  name: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
  version?: string;
}

const FAMILY_RE = /^(gemini-\d+(?:\.\d+)?(?:-(?:flash|pro|nano|ultra))?)/;

function detectFamily(bareId: string): string | null {
  const m = bareId.match(FAMILY_RE);
  return m ? m[1] : null;
}

export async function fetchModels(apiKey: string): Promise<ProviderSnapshot> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`google models list failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { models?: GoogleModel[] };
  const families: Record<string, ModelInfo[]> = {};
  for (const m of body.models ?? []) {
    if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
    const bareId = m.name.replace(/^models\//, "");
    const fam = detectFamily(bareId);
    if (!fam) continue;
    (families[fam] ??= []).push({
      id: bareId,
      display_name: m.displayName,
      deprecated: false,
    });
  }

  const out: ProviderSnapshot = { families: {} };
  for (const [fam, items] of Object.entries(families)) {
    items.sort((a, b) => b.id.localeCompare(a.id));
    out.families[fam] = {
      recommended: pickRecommended(items, (m) => m.id),
      all: items,
    };
  }
  return out;
}
