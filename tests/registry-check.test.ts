import { describe, it, expect } from "vitest";
import { checkRegistry } from "../src/registry-check.ts";
import { Manifest } from "../src/types.ts";

const manifest = Manifest.parse({
  version: "1",
  generated_at: "2026-09-28T00:00:00Z",
  providers: {
    anthropic: {
      families: {
        sonnet: {
          recommended: "claude-sonnet-5",
          all: [{ id: "claude-sonnet-5" }, { id: "claude-sonnet-4-6" }],
        },
        haiku: {
          recommended: "claude-haiku-4-5-20251001",
          all: [{ id: "claude-haiku-4-5-20251001" }],
        },
      },
    },
  },
});

const sonnetEntry = (file = "src/models.ts", extra = "") => `
  - repo: JMill/app
    file: ${file}
    family: anthropic.sonnet
    pattern: '(\\bsonnet:\\s*["''])claude-sonnet-[a-z0-9-]+(["''])'
    replacement_template: '$1{recommended}$2'${extra}`;

const files: Record<string, string> = {
  "/co/app/src/models.ts": "export const M = {\n  sonnet: 'claude-sonnet-4-6',\n  haiku: 'claude-haiku-4-5',\n};\n",
  "/co/app/src/current.ts": "export const M = { sonnet: \"claude-sonnet-5\" };\n",
  "/co/app/src/retired.ts": "export const M = { sonnet: 'claude-sonnet-4-20250514' };\n",
  "/co/app/src/none.ts": "export const MODEL = process.env.MODEL;\n",
  "/co/app/src/old-haiku.ts": "export const M = { haiku: 'claude-haiku-3-5' };\n",
};

const run = (rawYaml: string, locals: Record<string, string> = {}) =>
  checkRegistry({
    rawYaml,
    manifest,
    locals: new Map(Object.entries(locals)),
    readLocal: async (root, file) => files[`${root}/${file}`] ?? null,
  });

describe("checkRegistry", () => {
  it("passes an empty registry", async () => {
    const r = await run("consumers: []\n");
    expect(r.errors).toEqual([]);
  });

  it("reports YAML that a stray single quote breaks", async () => {
    const r = await run(`consumers:
  - repo: JMill/app
    file: a.ts
    family: anthropic.sonnet
    pattern: '(\\bsonnet:\\s*["'])claude-sonnet-[a-z0-9-]+(["'])'
    replacement_template: '$1{recommended}$2'
`);
    expect(r.errors).toEqual([expect.stringContaining("not valid YAML")]);
  });

  it("reports schema errors with their path", async () => {
    const r = await run(`consumers:${sonnetEntry()}
  - repo: JMill/app
    file: b.ts
    family: anthropic.sonnet
    pattern: '(unclosed'
    replacement_template: 'no placeholder'
`);
    expect(r.errors).toEqual([
      expect.stringMatching(/^consumers\.1\.replacement_template: must contain/),
      expect.stringMatching(/^consumers\.1\.pattern: invalid regex/),
    ]);
  });

  it("fails families the manifest does not publish", async () => {
    const r = await run(`consumers:
  - repo: JMill/app
    file: a.ts
    family: anthropic.mythos
    pattern: 'claude-mythos-[a-z0-9-]+'
    replacement_template: '{recommended}'
`);
    expect(r.errors).toEqual([
      expect.stringContaining("anthropic.mythos: family is not published"),
    ]);
  });

  it("reports matches, pins and pending bumps from a local checkout", async () => {
    const r = await run(`consumers:${sonnetEntry()}${sonnetEntry("src/current.ts")}
  - repo: JMill/app
    file: src/models.ts
    family: anthropic.haiku
    pattern: '(\\bhaiku:\\s*["''])claude-haiku-[a-z0-9-]+(["''])'
    replacement_template: '$1{recommended_alias}$2'
`, { "jmill/app": "/co/app" });
    expect(r.errors).toEqual([]);
    expect(r.lines).toContain(
      "  matches: 1, pinned: claude-sonnet-4-6, would change line 2: claude-sonnet-4-6 -> claude-sonnet-5",
    );
    expect(r.lines).toContain("  matches: 1, pinned: claude-sonnet-5, current, no bump");
    // Same equivalence as the bumper: the undated alias is current.
    expect(r.lines).toContain("  matches: 1, pinned: claude-haiku-4-5, current, no bump");
  });

  it("fails an entry whose pattern matches nothing locally, or whose file is missing", async () => {
    const r = await run(`consumers:${sonnetEntry("src/none.ts")}${sonnetEntry("src/missing.ts")}`, {
      "jmill/app": "/co/app",
    });
    expect(r.errors).toEqual([
      expect.stringContaining("pattern matches nothing"),
      expect.stringContaining("src/missing.ts not found"),
    ]);
  });

  it("warns about retired pins, disagreeing templates and unused --local mappings", async () => {
    const r = await run(
      `consumers:${sonnetEntry("src/retired.ts", "\n    title_template: 'Ship {to}'")}${sonnetEntry("src/current.ts")}`,
      { "jmill/app": "/co/app", "jmill/other": "/co/other" },
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      expect.stringContaining("disagree on title_template"),
      expect.stringContaining("pinned claude-sonnet-4-20250514 is no longer listed"),
      "--local jmill/other: no registry entry for this repo",
    ]);
  });

  it("warns when a bump would be held back for want of an alias", async () => {
    const r = await run(
      `consumers:
  - repo: JMill/app
    file: src/old-haiku.ts
    family: anthropic.haiku
    pattern: '(\\bhaiku:\\s*["''])claude-haiku-[a-z0-9-]+(["''])'
    replacement_template: '$1{recommended_alias}$2'
`,
      { "jmill/app": "/co/app" },
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      expect.stringContaining("a bump today would be skipped: claude-haiku-4-5-20251001 has no verified undated alias"),
      expect.stringContaining("pinned claude-haiku-3-5 is no longer listed"),
    ]);
  });

  it("parses without --local and leaves file checks out", async () => {
    const r = await run(`consumers:${sonnetEntry("src/none.ts")}`);
    expect(r.errors).toEqual([]);
    expect(r.lines).toEqual([
      "registry.yml: 1 consumer entry",
      "consumers[0] JMill/app src/none.ts anthropic.sonnet -> claude-sonnet-5",
    ]);
  });
});
