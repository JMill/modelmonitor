import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ZodRawShape, ZodObject } from "zod";
import { readManifest } from "../src/manifest.ts";
import { Family, Manifest, ModelInfo, ProviderSnapshot } from "../src/types.ts";

// The published manifest has two schemas: zod (src/types.ts), which the
// code parses with, and docs/schema.json, which consumers validate with.
// These tests keep them from drifting apart and keep the committed manifest
// valid under both.

const readJson = async (rel: string) =>
  JSON.parse(await readFile(new URL(rel, import.meta.url), "utf8"));

const jsonSchema = await readJson("../docs/schema.json");
const committed = await readJson("../docs/models.json");

function compileJsonSchema() {
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats(ajv);
  return ajv.compile(jsonSchema);
}

// A manifest carrying every optional field the Anthropic provider can emit.
const enriched = {
  $schema: "https://jmill.github.io/modelmonitor/schema.json",
  version: "1",
  generated_at: "2026-09-28T09:29:12.706Z",
  providers: {
    anthropic: {
      families: {
        haiku: {
          recommended: "claude-haiku-4-5-20251001",
          recommended_alias: "claude-haiku-4-5",
          all: [
            {
              id: "claude-haiku-4-5-20251001",
              display_name: "Claude Haiku 4.5",
              created_at: "2025-10-15T00:00:00Z",
              deprecated: false,
              max_input_tokens: 200000,
              max_tokens: 64000,
              capabilities: {
                thinking: {
                  supported: true,
                  types: {
                    adaptive: { supported: false },
                    enabled: { supported: true },
                  },
                },
                // A leaf the SDK doesn't type yet must survive untouched.
                some_future_capability: { supported: true },
              },
              aliases: ["claude-haiku-4-5"],
            },
          ],
        },
        sonnet: {
          recommended: "claude-sonnet-5",
          all: [
            {
              id: "claude-sonnet-5",
              deprecated: false,
              max_input_tokens: null,
              max_tokens: null,
              capabilities: null,
            },
          ],
        },
      },
    },
  },
};

describe("committed docs/models.json", () => {
  it("parses with the zod Manifest", () => {
    expect(Manifest.safeParse(committed).success).toBe(true);
  });

  it("validates against docs/schema.json", () => {
    const validate = compileJsonSchema();
    const ok = validate(committed);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });
});

describe("optional manifest fields", () => {
  it("validate under both schemas, including nulls", () => {
    expect(Manifest.safeParse(enriched).success).toBe(true);
    const validate = compileJsonSchema();
    expect(validate(enriched)).toBe(true);
  });

  it("survive a zod round-trip unchanged", () => {
    expect(Manifest.parse(enriched)).toEqual(enriched);
  });

  it("survive readManifest, which feeds the previous manifest to the diff", async () => {
    const dir = await mkdtemp(join(tmpdir(), "modelmonitor-"));
    const path = join(dir, "models.json");
    await writeFile(path, JSON.stringify(enriched));
    expect(await readManifest(path)).toEqual(enriched);
  });

  it("are rejected by both schemas when mistyped", () => {
    const bad = structuredClone(enriched);
    (bad.providers.anthropic.families.haiku.all[0] as Record<string, unknown>)
      .max_tokens = "64k";
    expect(Manifest.safeParse(bad).success).toBe(false);
    expect(compileJsonSchema()(bad)).toBe(false);
  });
});

describe("zod and docs/schema.json declare the same shape", () => {
  const defs = jsonSchema.definitions;
  const pairs: [string, ZodObject<ZodRawShape>, { properties: object; required?: string[] }][] = [
    ["Manifest", Manifest, jsonSchema],
    ["ProviderSnapshot", ProviderSnapshot, defs.providerSnapshot],
    ["Family", Family, defs.family],
    ["ModelInfo", ModelInfo, defs.modelInfo],
  ];

  for (const [name, zodObj, json] of pairs) {
    it(`${name}: same property keys`, () => {
      expect(Object.keys(zodObj.shape).sort()).toEqual(
        Object.keys(json.properties).sort(),
      );
    });

    it(`${name}: same required keys`, () => {
      const zodRequired = Object.entries(zodObj.shape)
        .filter(([, v]) => !v.isOptional())
        .map(([k]) => k)
        .sort();
      expect(zodRequired).toEqual([...(json.required ?? [])].sort());
    });
  }
});
