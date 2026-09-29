import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { Registry, RegistryEntry, splitFamily } from "../src/types.ts";

const base = {
  repo: "JMill/tee-site",
  file: "packages/models/src/models.ts",
  pattern: `(\\bsonnet:\\s*["'])claude-sonnet-[a-z0-9-]+(["'])`,
  replacement_template: "$1{recommended}$2",
  family: "anthropic.sonnet",
};

const issues = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? [] : r.error!.issues.map((i) => i.message);

describe("RegistryEntry", () => {
  it("fills defaults", () => {
    expect(RegistryEntry.parse(base)).toEqual({
      ...base,
      flags: "",
      branch_prefix: "chore/model-bump",
      reviewers: [],
    });
  });

  it("accepts dotted family keys", () => {
    for (const family of [
      "openai.gpt-4.1",
      "google.gemini-2.0-flash",
      "openai.gpt-3.5",
    ]) {
      expect(RegistryEntry.safeParse({ ...base, family }).success).toBe(true);
    }
  });

  it("rejects malformed family keys and unknown providers", () => {
    expect(RegistryEntry.safeParse({ ...base, family: "sonnet" }).success).toBe(false);
    expect(RegistryEntry.safeParse({ ...base, family: "anthropic." }).success).toBe(false);
    expect(RegistryEntry.safeParse({ ...base, family: "Anthropic.sonnet" }).success).toBe(false);
    expect(issues(RegistryEntry.safeParse({ ...base, family: "mistral.large" }))).toEqual([
      expect.stringContaining('unknown provider "mistral"'),
    ]);
  });

  it("requires a placeholder in replacement_template", () => {
    expect(
      issues(RegistryEntry.safeParse({ ...base, replacement_template: '$1claude-sonnet-5$2' })),
    ).toEqual([expect.stringContaining("{recommended}")]);
    expect(
      RegistryEntry.safeParse({ ...base, replacement_template: "$1{recommended_alias}$2" })
        .success,
    ).toBe(true);
  });

  it("compiles the pattern at parse time", () => {
    expect(issues(RegistryEntry.safeParse({ ...base, pattern: "(unclosed" }))).toEqual([
      expect.stringContaining("invalid regex"),
    ]);
  });

  it("rejects a pattern that matches the empty string", () => {
    expect(issues(RegistryEntry.safeParse({ ...base, pattern: "(claude-sonnet-5)?" }))).toEqual([
      "pattern matches the empty string",
    ]);
  });

  it("allows only i/m/s/u flags", () => {
    expect(RegistryEntry.safeParse({ ...base, flags: "m" }).success).toBe(true);
    expect(RegistryEntry.safeParse({ ...base, flags: "g" }).success).toBe(false);
    expect(RegistryEntry.safeParse({ ...base, flags: "y" }).success).toBe(false);
    // Repeated flags are a RegExp syntax error, caught by the compile step.
    expect(RegistryEntry.safeParse({ ...base, flags: "mm" }).success).toBe(false);
  });

  it("accepts only plain repo-relative file paths", () => {
    for (const file of [
      "scripts/_shared/models.ts",
      "Flare/config.json",
      "a.ts",
      ".github/models.yml",
      "pkg/.hidden/models.ts",
    ]) {
      expect(RegistryEntry.safeParse({ ...base, file }).success, file).toBe(true);
    }
    const bad: Record<string, string> = {
      "/scripts/models.ts": 'a leading "/" (write "scripts/models.ts")',
      "./scripts/models.ts": 'a "." segment (write "scripts/models.ts")',
      "scripts/./models.ts": 'a "." segment',
      "../other/models.ts": 'a ".." segment',
      "scripts/../models.ts": 'a ".." segment',
      "scripts//models.ts": "an empty segment",
      "scripts/": 'a trailing "/"',
      "/": 'a leading "/"',
    };
    for (const [file, why] of Object.entries(bad)) {
      expect(issues(RegistryEntry.safeParse({ ...base, file })), file).toEqual([
        expect.stringContaining(why),
      ]);
    }
  });

  it("rejects branch prefixes git would refuse", () => {
    for (const branch_prefix of ["/bump", "bump/", "bump//x", "a..b", "has space"]) {
      expect(RegistryEntry.safeParse({ ...base, branch_prefix }).success).toBe(false);
    }
    expect(RegistryEntry.safeParse({ ...base, branch_prefix: "deps/models" }).success).toBe(true);
  });
});

describe("splitFamily", () => {
  it("splits on the first dot only", () => {
    expect(splitFamily("openai.gpt-4.1")).toEqual({ provider: "openai", family: "gpt-4.1" });
    expect(splitFamily("google.gemini-2.0-flash")).toEqual({
      provider: "google",
      family: "gemini-2.0-flash",
    });
    expect(splitFamily("anthropic.sonnet")).toEqual({ provider: "anthropic", family: "sonnet" });
  });
});

describe("Registry", () => {
  it("rejects a duplicate (repo, file, family), ignoring repo case", () => {
    const r = Registry.safeParse({
      consumers: [base, { ...base, repo: "jmill/TEE-site", reviewers: ["JMill"] }],
    });
    expect(issues(r)).toEqual([expect.stringContaining("duplicate (repo, file, family)")]);
  });

  it("allows the same file under different families", () => {
    const r = Registry.safeParse({
      consumers: [
        base,
        {
          ...base,
          family: "anthropic.opus",
          pattern: `(\\bopus:\\s*["'])claude-opus-[a-z0-9-]+(["'])`,
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("parses the committed registry.yml", async () => {
    const raw = await readFile(new URL("../registry.yml", import.meta.url), "utf8");
    expect(Registry.safeParse(yaml.load(raw)).success).toBe(true);
  });
});
