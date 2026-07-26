import type { ModelInfo } from "./types.ts";

// Size tier within a family. Lower = smaller/cheaper variant that should not
// be recommended when a larger sibling exists. "nano" is the smallest, then
// "mini"/"lite" (incl. Google's "flash-lite"); everything else — flagship,
// "pro", specialized variants — is treated as full size.
export function sizeTier(id: string): number {
  if (/(^|[-_])nano([-_]|$)/i.test(id)) return 0;
  if (/(^|[-_])(mini|lite)([-_]|$)/i.test(id)) return 1;
  return 2;
}

// Digit-aware string compare, for recency keys that embed unpadded version
// numbers. Plain localeCompare puts "-9" above "-10"; providers that rank by
// ID rather than by timestamp need this to pick the genuinely newest model.
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

// Pick the recommended model ID from a family: prefer the largest size tier,
// then the most recent within that tier. `recencyKey` is an ISO created_at for
// Anthropic/OpenAI and the ID for Google; `compare` sorts those keys ascending
// (ISO timestamps are fixed-width, so the default lexicographic order is
// already correct for them — pass naturalCompare for ID-derived keys).
export function pickRecommended(
  models: ModelInfo[],
  recencyKey: (m: ModelInfo) => string,
  compare: (a: string, b: string) => number = (a, b) => a.localeCompare(b),
): string {
  const ranked = [...models].sort((a, b) => {
    const tier = sizeTier(b.id) - sizeTier(a.id);
    if (tier !== 0) return tier;
    return compare(recencyKey(b), recencyKey(a));
  });
  return ranked[0].id;
}
