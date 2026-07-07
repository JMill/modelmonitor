import OpenAI from "openai";
import type { ModelInfo, ProviderSnapshot } from "../types.ts";
import { pickRecommended } from "../rank.ts";

const EXCLUDE_RE =
  /(embedding|whisper|tts|dall-e|moderation|davinci|babbage|audio|image|realtime|transcribe|search)/i;

function detectFamily(id: string): string | null {
  if (EXCLUDE_RE.test(id)) return null;
  if (/^gpt-5/.test(id)) return "gpt-5";
  if (/^gpt-4o/.test(id)) return "gpt-4o";
  if (/^gpt-4\.1/.test(id)) return "gpt-4.1";
  if (/^gpt-4(\b|-)/.test(id)) return "gpt-4";
  if (/^gpt-3\.5/.test(id)) return "gpt-3.5";
  if (/^o[134](\b|-)/.test(id)) return "o-series";
  if (/^chatgpt/.test(id)) return "chatgpt";
  return null;
}

export async function fetchModels(apiKey: string): Promise<ProviderSnapshot> {
  const client = new OpenAI({ apiKey });
  const list = await client.models.list();
  const models: Array<ModelInfo & { _family: string }> = [];
  for (const m of list.data) {
    const fam = detectFamily(m.id);
    if (!fam) continue;
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

  const out: ProviderSnapshot = { families: {} };
  for (const [fam, items] of Object.entries(families)) {
    items.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    out.families[fam] = {
      recommended: pickRecommended(items, (m) => m.created_at ?? ""),
      all: items,
    };
  }
  return out;
}
