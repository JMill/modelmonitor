import { describe, it, expect } from "vitest";
import { sizeTier, pickRecommended, naturalCompare } from "../src/rank.ts";

const m = (id: string, created_at?: string) => ({ id, created_at, deprecated: false });

describe("sizeTier", () => {
  it("ranks nano below mini/lite below flagship", () => {
    expect(sizeTier("gpt-4.1-nano")).toBe(0);
    expect(sizeTier("gpt-4.1-mini")).toBe(1);
    expect(sizeTier("gemini-2.0-flash-lite")).toBe(1);
    expect(sizeTier("gpt-4.1")).toBe(2);
    expect(sizeTier("gpt-5.5-pro")).toBe(2);
  });
});

describe("pickRecommended", () => {
  it("prefers the flagship over mini/nano at the same date", () => {
    const items = [
      m("gpt-4.1-nano", "2025-04-14"),
      m("gpt-4.1-mini", "2025-04-14"),
      m("gpt-4.1", "2025-04-14"),
    ];
    expect(pickRecommended(items, (x) => x.created_at ?? "")).toBe("gpt-4.1");
  });

  it("prefers a flagship even when a mini variant is newer", () => {
    const items = [
      m("gpt-4.1-mini", "2025-06-01"),
      m("gpt-4.1", "2025-04-14"),
    ];
    expect(pickRecommended(items, (x) => x.created_at ?? "")).toBe("gpt-4.1");
  });

  it("breaks ties within the top tier by recency", () => {
    const items = [
      m("gpt-5.5", "2026-01-01"),
      m("gpt-5.5-pro", "2026-04-23"),
    ];
    expect(pickRecommended(items, (x) => x.created_at ?? "")).toBe("gpt-5.5-pro");
  });

  it("uses the id as the recency key for Google", () => {
    const items = [m("gemini-2.0-flash-lite"), m("gemini-2.0-flash-001")];
    expect(pickRecommended(items, (x) => x.id)).toBe("gemini-2.0-flash-001");
  });

  it("orders unpadded id revisions numerically, not lexicographically", () => {
    const items = [m("gemini-3-pro-9"), m("gemini-3-pro-10")];
    expect(pickRecommended(items, (x) => x.id, naturalCompare)).toBe(
      "gemini-3-pro-10",
    );
  });
});

describe("naturalCompare", () => {
  it("sorts embedded numbers by value", () => {
    expect(naturalCompare("v9", "v10")).toBeLessThan(0);
  });

  it("leaves fixed-width ISO timestamps in chronological order", () => {
    expect(
      naturalCompare("2026-05-28T00:00:00Z", "2026-07-24T00:00:00Z"),
    ).toBeLessThan(0);
  });
});
