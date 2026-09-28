import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ProviderSnapshot } from "../src/types.ts";
import {
  detectFamily as anthropicFamily,
  fetchModels as fetchAnthropic,
  type AnthropicModelsClient,
} from "../src/providers/anthropic.ts";
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

  it("accepts snapshots written before the optional model fields existed", () => {
    const ok = ProviderSnapshot.safeParse({
      families: {
        haiku: {
          recommended: "claude-haiku-4-5-20251001",
          all: [{ id: "claude-haiku-4-5-20251001", deprecated: false }],
        },
      },
    });
    expect(ok.success).toBe(true);
  });

  it("accepts limits, capabilities and aliases, null or populated", () => {
    const ok = ProviderSnapshot.safeParse({
      families: {
        haiku: {
          recommended: "claude-haiku-4-5-20251001",
          recommended_alias: "claude-haiku-4-5",
          all: [
            {
              id: "claude-haiku-4-5-20251001",
              max_input_tokens: 200000,
              max_tokens: 64000,
              capabilities: { batch: { supported: true } },
              aliases: ["claude-haiku-4-5"],
            },
            {
              id: "claude-haiku-4-5-legacy",
              max_input_tokens: null,
              max_tokens: null,
              capabilities: null,
            },
          ],
        },
      },
    });
    expect(ok.success).toBe(true);
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

  it("classifies point releases under their family", () => {
    expect(anthropicFamily("claude-opus-5-5")).toBe("opus");
    expect(anthropicFamily("claude-fable-5-1")).toBe("fable");
    expect(anthropicFamily("claude-mythos-5-1")).toBe("mythos");
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

const capabilities = (adaptive: boolean) =>
  ({
    batch: { supported: true },
    citations: { supported: true },
    code_execution: { supported: true },
    context_management: {
      clear_thinking_20251015: { supported: true },
      clear_tool_uses_20250919: { supported: true },
      compact_20260112: null,
      supported: true,
    },
    effort: {
      low: { supported: adaptive },
      medium: { supported: adaptive },
      high: { supported: adaptive },
      max: { supported: adaptive },
      xhigh: adaptive ? { supported: true } : null,
      supported: adaptive,
    },
    image_input: { supported: true },
    pdf_input: { supported: true },
    structured_outputs: { supported: true },
    thinking: {
      supported: true,
      types: {
        adaptive: { supported: adaptive },
        enabled: { supported: !adaptive },
      },
    },
  }) satisfies Anthropic.ModelCapabilities;

const apiModel = (
  id: string,
  created_at: string,
  extra: Partial<Anthropic.ModelInfo> = {},
): Anthropic.ModelInfo => ({
  id,
  display_name: id,
  created_at,
  max_input_tokens: 1_000_000,
  max_tokens: 128_000,
  capabilities: capabilities(true),
  type: "model",
  ...extra,
});

// A stub of the SDK's models resource: `list` yields `listed`; `retrieve`
// resolves aliases through `resolves` and fails for anything else.
function stubClient(
  listed: Anthropic.ModelInfo[],
  resolves: Record<string, string>,
): AnthropicModelsClient & { retrieve: ReturnType<typeof vi.fn> } {
  const byId = new Map(listed.map((m) => [m.id, m]));
  const retrieve = vi.fn(async (id: string) => {
    const target = resolves[id] ?? (byId.has(id) ? id : undefined);
    if (!target) throw new Error(`404 model not found: ${id}`);
    return byId.get(target) ?? apiModel(target, "2026-01-01T00:00:00Z");
  });
  return {
    retrieve,
    models: {
      list: vi.fn(async function* () {
        yield* listed;
      }),
      retrieve,
    },
  };
}

describe("anthropic fetchModels", () => {
  it("publishes the typed limit and capability fields as the API reports them", async () => {
    const client = stubClient(
      [
        apiModel("claude-sonnet-5", "2026-06-29T00:00:00Z"),
        apiModel("claude-sonnet-4-6", "2026-02-17T00:00:00Z", {
          max_input_tokens: null,
          max_tokens: null,
          capabilities: null,
        }),
      ],
      {},
    );
    const { snapshot } = await fetchAnthropic("unused", client);
    const [latest, older] = snapshot.families.sonnet.all;
    expect(latest).toEqual({
      id: "claude-sonnet-5",
      display_name: "claude-sonnet-5",
      created_at: "2026-06-29T00:00:00Z",
      deprecated: false,
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
      capabilities: capabilities(true),
    });
    expect(older.max_input_tokens).toBeNull();
    expect(older.max_tokens).toBeNull();
    expect(older.capabilities).toBeNull();
    expect(ProviderSnapshot.safeParse(snapshot).success).toBe(true);
  });

  it("records an alias only when the API resolves it back to the dated ID", async () => {
    const client = stubClient(
      [
        apiModel("claude-haiku-4-5-20251001", "2025-10-15T00:00:00Z", {
          capabilities: capabilities(false),
        }),
        apiModel("claude-sonnet-4-5-20250929", "2025-09-29T00:00:00Z"),
        apiModel("claude-opus-4-5-20251101", "2025-11-24T00:00:00Z"),
        apiModel("claude-opus-5-5", "2026-09-21T16:24:00Z"),
      ],
      {
        "claude-haiku-4-5": "claude-haiku-4-5-20251001",
        // Resolves, but to a different snapshot: not an alias of this ID.
        "claude-sonnet-4-5": "claude-sonnet-4-5-20260101",
        // claude-opus-4-5 is absent, so retrieve throws a 404.
      },
    );
    const { snapshot } = await fetchAnthropic("unused", client);

    const haiku = snapshot.families.haiku;
    expect(haiku.recommended).toBe("claude-haiku-4-5-20251001");
    expect(haiku.recommended_alias).toBe("claude-haiku-4-5");
    expect(haiku.all[0].aliases).toEqual(["claude-haiku-4-5"]);

    expect(snapshot.families.sonnet.all[0].aliases).toBeUndefined();
    expect(snapshot.families.sonnet.recommended_alias).toBeUndefined();

    // The failed lookup is tolerated: no alias, and the refresh still succeeds.
    const opus = snapshot.families.opus;
    expect(opus.recommended).toBe("claude-opus-5-5");
    expect(opus.recommended_alias).toBeUndefined();
    expect(opus.all.find((m) => m.id === "claude-opus-4-5-20251101")?.aliases)
      .toBeUndefined();

    // Only dated IDs are looked up.
    expect(client.retrieve.mock.calls.map(([id]) => id).sort()).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-5",
      "claude-sonnet-4-5",
    ]);
  });

  it("gives an undated recommended model no recommended_alias", async () => {
    const client = stubClient(
      [apiModel("claude-opus-5-5", "2026-09-21T16:24:00Z")],
      {},
    );
    const { snapshot } = await fetchAnthropic("unused", client);
    expect(snapshot.families.opus).toEqual({
      recommended: "claude-opus-5-5",
      all: [expect.objectContaining({ id: "claude-opus-5-5" })],
    });
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
