import { describe, it, expect } from "vitest";
import {
  buildManifest,
  diffManifests,
  holdUnclassifiedForRetry,
} from "../src/manifest.ts";
import { Manifest, type ProviderId } from "../src/types.ts";

const snapshot = (recommended: string, ids: string[]) => ({
  recommended,
  all: ids.map((id) => ({ id, deprecated: false })),
});

describe("buildManifest", () => {
  it("produces a v1 manifest with current timestamp", () => {
    const m = buildManifest({});
    expect(m.version).toBe("1");
    expect(m.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Manifest.parse(m)).toEqual(m);
  });
});

describe("diffManifests", () => {
  const prev = buildManifest({
    anthropic: {
      families: {
        sonnet: snapshot("claude-sonnet-4-6", [
          "claude-sonnet-4-6",
          "claude-sonnet-4-5",
        ]),
      },
    },
  });

  it("flags recommended_changed when the recommended ID moves", () => {
    const next = buildManifest({
      anthropic: {
        families: {
          sonnet: snapshot("claude-sonnet-4-7", [
            "claude-sonnet-4-7",
            "claude-sonnet-4-6",
          ]),
        },
      },
    });
    const diffs = diffManifests(prev, next);
    expect(
      diffs.some(
        (d) =>
          d.kind === "recommended_changed" &&
          d.from === "claude-sonnet-4-6" &&
          d.to === "claude-sonnet-4-7",
      ),
    ).toBe(true);
    expect(diffs.some((d) => d.kind === "added")).toBe(true);
  });

  it("flags removed when a model disappears", () => {
    const next = buildManifest({
      anthropic: {
        families: { sonnet: snapshot("claude-sonnet-4-6", ["claude-sonnet-4-6"]) },
      },
    });
    const diffs = diffManifests(prev, next);
    expect(
      diffs.some((d) => d.kind === "removed" && d.model === "claude-sonnet-4-5"),
    ).toBe(true);
  });

  it("returns empty diff against null prev for new providers", () => {
    expect(diffManifests(null, prev)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "added",
          model: "claude-sonnet-4-6",
        }),
      ]),
    );
  });
});

describe("holdUnclassifiedForRetry", () => {
  const withUnclassified = (ids: string[]) =>
    buildManifest({
      anthropic: { families: {}, unclassified: ids },
    });

  it("drops IDs whose alert was not delivered so they re-alert next run", () => {
    const m = withUnclassified(["claude-2.1", "claude-quartz-6"]);
    holdUnclassifiedForRetry(
      m,
      new Map<ProviderId, string[]>([["anthropic", ["claude-quartz-6"]]]),
    );
    // Previously-reported IDs stay recorded; only the undelivered one is
    // rolled back, so the next run treats it as new.
    expect(m.providers.anthropic!.unclassified).toEqual(["claude-2.1"]);
  });

  it("omits the field entirely when nothing was successfully reported", () => {
    const m = withUnclassified(["claude-quartz-6"]);
    holdUnclassifiedForRetry(
      m,
      new Map<ProviderId, string[]>([["anthropic", ["claude-quartz-6"]]]),
    );
    expect(m.providers.anthropic!.unclassified).toBeUndefined();
    // And it must not survive a round-trip through the published file.
    expect(JSON.parse(JSON.stringify(m))).not.toHaveProperty(
      "providers.anthropic.unclassified",
    );
  });

  it("leaves providers with no pending IDs untouched", () => {
    const m = withUnclassified(["claude-2.1"]);
    holdUnclassifiedForRetry(m, new Map<ProviderId, string[]>());
    expect(m.providers.anthropic!.unclassified).toEqual(["claude-2.1"]);
  });
});
