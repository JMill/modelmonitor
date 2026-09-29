import { describe, it, expect } from "vitest";
import {
  MIGRATION_GUIDE_URL,
  migrationChecklist,
  parseClaudeId,
  renderMigrationNotes,
} from "../src/migration-notes.ts";

const has = (items: string[], needle: string) => items.some((i) => i.includes(needle));

describe("parseClaudeId", () => {
  it("reads family, major and minor, ignoring a date suffix", () => {
    expect(parseClaudeId("claude-opus-5-5")).toEqual({ family: "opus", major: 5, minor: 5 });
    expect(parseClaudeId("claude-sonnet-5")).toEqual({ family: "sonnet", major: 5, minor: 0 });
    expect(parseClaudeId("claude-haiku-4-5-20251001")).toEqual({
      family: "haiku",
      major: 4,
      minor: 5,
    });
    expect(parseClaudeId("claude-sonnet-4-20250514")).toEqual({
      family: "sonnet",
      major: 4,
      minor: 0,
    });
  });

  it("returns null for legacy and non-Claude IDs", () => {
    expect(parseClaudeId("claude-3-5-sonnet-20241022")).toBeNull();
    expect(parseClaudeId("gpt-5.5")).toBeNull();
  });
});

describe("migrationChecklist", () => {
  it("covers every Opus 5.5 breaking change", () => {
    const items = migrationChecklist("anthropic", ["claude-opus-4-8"], "claude-opus-5-5");
    expect(has(items, "`temperature`, `top_p` and `top_k`")).toBe(true);
    expect(has(items, "budget_tokens")).toBe(true);
    expect(has(items, 'type: "disabled"}`: it returns 400')).toBe(true);
    expect(has(items, "defaults to `medium`")).toBe(true);
    expect(has(items, "Size `max_tokens`")).toBe(true);
    expect(has(items, "block type")).toBe(true);
    expect(has(items, "`refusal`")).toBe(true);
    expect(has(items, "forced `tool_choice`")).toBe(true);
    expect(has(items, "server-side-fallback-2026-07-01")).toBe(true);
  });

  it("gives Sonnet 5 the sampling, thinking and tokenizer items but not the Opus 5.5 ones", () => {
    const items = migrationChecklist("anthropic", ["claude-sonnet-4-6"], "claude-sonnet-5");
    expect(has(items, "`temperature`, `top_p` and `top_k`")).toBe(true);
    expect(has(items, "budget_tokens")).toBe(true);
    expect(has(items, "about 30% more tokens")).toBe(true);
    expect(has(items, "forced `tool_choice`")).toBe(false);
    expect(has(items, "server-side-fallback")).toBe(false);
    expect(has(items, 'type: "disabled"}`: it returns 400')).toBe(false);
  });

  it("skips the tokenizer item when the old model already used it", () => {
    const items = migrationChecklist("anthropic", ["claude-opus-5"], "claude-opus-5-5");
    expect(has(items, "about 30% more tokens")).toBe(false);
  });

  it("tells Haiku 4.5 routes to send no adaptive thinking or effort", () => {
    const items = migrationChecklist("anthropic", ["claude-3-5-haiku-20241022"], "claude-haiku-4-5");
    expect(has(items, "Haiku 4.5")).toBe(true);
    expect(has(items, "`temperature`")).toBe(false);
    expect(has(items, "block type")).toBe(true);
  });

  it("flags forced tool_choice for Fable 5.1", () => {
    expect(
      has(migrationChecklist("anthropic", ["claude-fable-5"], "claude-fable-5-1"), "forced `tool_choice`"),
    ).toBe(true);
  });

  it("says nothing for other providers", () => {
    expect(migrationChecklist("openai", ["gpt-5.5"], "gpt-5.6")).toEqual([]);
    expect(renderMigrationNotes("openai", ["gpt-5.5"], "gpt-5.6")).toBe("");
  });
});

describe("renderMigrationNotes", () => {
  it("renders a task list that links the migration guide", () => {
    const md = renderMigrationNotes("anthropic", ["claude-sonnet-4-6"], "claude-sonnet-5");
    expect(md).toMatch(/^### Before merging/);
    expect(md).toContain("- [ ] Remove `temperature`");
    expect(md).toContain(`(${MIGRATION_GUIDE_URL})`);
  });
});
