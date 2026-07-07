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

// Pick the recommended model id from a family: prefer the largest size tier,
// then the most recent within that tier (recencyKey sorts descending by
// localeCompare — an ISO created_at for Anthropic/OpenAI, the id for Google).
export function pickRecommended(
  models: ModelInfo[],
  recencyKey: (m: ModelInfo) => string,
): string {
  const ranked = [...models].sort((a, b) => {
    const tier = sizeTier(b.id) - sizeTier(a.id);
    if (tier !== 0) return tier;
    return recencyKey(b).localeCompare(recencyKey(a));
  });
  return ranked[0].id;
}
