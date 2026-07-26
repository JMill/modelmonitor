import { describe, it, expect } from "vitest";
import { ProviderSnapshot } from "../src/types.ts";
import { detectFamily as anthropicFamily } from "../src/providers/anthropic.ts";
import { detectFamily as openaiFamily } from "../src/providers/openai.ts";
import { detectFamily as googleFamily } from "../src/providers/google.ts";

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

  it("accepts the optional unclassified diagnostic", () => {
    const ok = ProviderSnapshot.safeParse({
      families: {},
      unclassified: ["claude-2.1"],
    });
    expect(ok.success).toBe(true);
  });
});

describe("anthropic detectFamily", () => {
  it("classifies the current lineup", () => {
    expect(anthropicFamily("claude-opus-5")).toBe("opus");
    expect(anthropicFamily("claude-sonnet-5")).toBe("sonnet");
    expect(anthropicFamily("claude-haiku-4-5-20251001")).toBe("haiku");
  });

  it("adopts families that postdate these rules", () => {
    // The regression that motivated this: a hardcoded opus|sonnet|haiku list
    // dropped every Fable model out of the manifest without a trace.
    expect(anthropicFamily("claude-fable-5")).toBe("fable");
    expect(anthropicFamily("claude-mythos-5")).toBe("mythos");
  });

  it("handles legacy version-first IDs", () => {
    expect(anthropicFamily("claude-3-5-sonnet-20241022")).toBe("sonnet");
    expect(anthropicFamily("claude-3-opus-20240229")).toBe("opus");
  });

  it("returns null for IDs with no family segment", () => {
    expect(anthropicFamily("claude-2.1")).toBeNull();
  });
});

describe("openai detectFamily", () => {
  it("keeps point releases under one stable family key", () => {
    expect(openaiFamily("gpt-5")).toBe("gpt-5");
    expect(openaiFamily("gpt-5.5-pro")).toBe("gpt-5");
  });

  it("matches o-series beyond the originally-listed generations", () => {
    expect(openaiFamily("o3-mini")).toBe("o-series");
    expect(openaiFamily("o5")).toBe("o-series");
  });

  it("excludes non-chat endpoints", () => {
    expect(openaiFamily("text-embedding-3-large")).toBeNull();
    expect(openaiFamily("whisper-1")).toBeNull();
  });

  it("distinguishes gpt-4o, gpt-4.1 and gpt-4", () => {
    expect(openaiFamily("gpt-4o-2024-11-20")).toBe("gpt-4o");
    expect(openaiFamily("gpt-4.1-mini")).toBe("gpt-4.1");
    expect(openaiFamily("gpt-4-turbo")).toBe("gpt-4");
  });
});

describe("google detectFamily", () => {
  it("keys on version plus variant", () => {
    expect(googleFamily("gemini-2.0-flash-001")).toBe("gemini-2.0-flash");
    expect(googleFamily("gemini-3-pro-preview")).toBe("gemini-3-pro");
  });

  it("returns null for non-gemini lines", () => {
    expect(googleFamily("gemma-3-27b-it")).toBeNull();
  });
});
