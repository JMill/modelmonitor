import Anthropic from "@anthropic-ai/sdk";
import type { ModelInfo, ProviderSnapshot } from "../types.ts";
import { pickRecommended } from "../rank.ts";

const FAMILY_RE = /^claude-(opus|sonnet|haiku)-/;

function detectFamily(id: string): string | null {
  const m = id.match(FAMILY_RE);
  return m ? m[1] : null;
}

export async function fetchModels(apiKey: string): Promise<ProviderSnapshot> {
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
  for (const m of models) {
    const fam = detectFamily(m.id);
    if (!fam) continue;
    (families[fam] ??= []).push(m);
  }

  const out: ProviderSnapshot = { families: {} };
  for (const [fam, list] of Object.entries(families)) {
    list.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    out.families[fam] = {
      recommended: pickRecommended(list, (m) => m.created_at ?? ""),
      all: list,
    };
  }
  return out;
}
