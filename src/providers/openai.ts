import OpenAI from "openai";
import type { ModelInfo, ProviderResult, ProviderSnapshot } from "../types.ts";
import { pickRecommended } from "../rank.ts";

// Non-chat endpoints. These are deliberately out of scope, not unclassified —
// they must never reach the unclassified alert or it would fire every run.
const EXCLUDE_RE =
  /(embedding|whisper|tts|dall-e|moderation|davinci|babbage|audio|image|realtime|transcribe|search)/i;

// Unlike Anthropic's, these keys are not derived from the ID: `gpt-5`
// intentionally collects gpt-5, gpt-5.1, gpt-5.5, … under one stable key that
// registry.yml entries pin against. A genuinely new line (gpt-6, o-series
// successor) surfaces via the unclassified alert rather than inventing a key.
export function detectFamily(id: string): string | null {
  if (EXCLUDE_RE.test(id)) return null;
  if (/^gpt-5/.test(id)) return "gpt-5";
  if (/^gpt-4o/.test(id)) return "gpt-4o";
  if (/^gpt-4\.1/.test(id)) return "gpt-4.1";
  if (/^gpt-4(\b|-)/.test(id)) return "gpt-4";
  if (/^gpt-3\.5/.test(id)) return "gpt-3.5";
  if (/^o\d(\b|-)/.test(id)) return "o-series";
  if (/^chatgpt/.test(id)) return "chatgpt";
  return null;
}

export async function fetchModels(apiKey: string): Promise<ProviderResult> {
  const client = new OpenAI({ apiKey });
  const list = await client.models.list();
  const models: Array<ModelInfo & { _family: string }> = [];
  const unclassified: string[] = [];
  for (const m of list.data) {
    const fam = detectFamily(m.id);
    if (!fam) {
      if (!EXCLUDE_RE.test(m.id)) unclassified.push(m.id);
      continue;
    }
    const created_at = m.created
      ? new Date(m.created * 1000).toISOString()
      : undefined;
    models.push({ id: m.id, created_at, deprecated: false, _family: fam });
  }

  const families: Record<string, ModelInfo[]> = {};
  for (const m of models) {
    const { _family, ...info } = m;
    (families[_family] ??= []).push(info);
  }

  const snapshot: ProviderSnapshot = { families: {} };
  for (const [fam, items] of Object.entries(families)) {
    items.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    snapshot.families[fam] = {
      recommended: pickRecommended(items, (m) => m.created_at ?? ""),
      all: items,
    };
  }
  return { snapshot, unclassified: unclassified.sort() };
}
