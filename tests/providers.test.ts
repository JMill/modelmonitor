import { describe, it, expect } from "vitest";
import { ProviderSnapshot } from "../src/types.ts";

describe("provider snapshot shape", () => {
  it("validates a minimal snapshot", () => {
    const ok = ProviderSnapshot.safeParse({
      families: {
        sonnet: {
          recommended: "claude-sonnet-4-6",
          all: [{ id: "claude-sonnet-4-6", deprecated: false }],
        },
      },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects a snapshot missing recommended", () => {
    const bad = ProviderSnapshot.safeParse({
      families: { sonnet: { all: [] } as unknown },
    });
    expect(bad.success).toBe(false);
  });
});
