// Static pre-merge checklist for Claude model bumps.
//
// A bump PR is a string swap, but newer Claude models reject request shapes
// older ones accepted, so a swap that type-checks can still 400 in
// production. The Models API capability tree can't express those rules (it
// has no field for "sampling params rejected" or "forced tool_choice
// rejected"), so they live here as a hand-maintained table keyed on the
// target model's family and version, checked against the migration guide:
// https://platform.claude.com/docs/en/about-claude/models/migration-guide.md
//
// When a new model changes the request surface, add a rule below and a case
// to tests/migration-notes.test.ts.

export const MIGRATION_GUIDE_URL =
  "https://platform.claude.com/docs/en/about-claude/models/migration-guide.md";

export interface ClaudeVersion {
  family: string;
  major: number;
  minor: number;
}

// claude-<family>-<major>[-<minor>][-<yyyymmdd>]. Legacy version-first IDs
// (claude-3-5-sonnet-20241022) return null and only get the generic items.
export function parseClaudeId(id: string): ClaudeVersion | null {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (!m) return null;
  return { family: m[1], major: Number(m[2]), minor: m[3] ? Number(m[3]) : 0 };
}

function atLeast(
  v: ClaudeVersion | null,
  families: string[],
  major: number,
  minor = 0,
): boolean {
  if (!v || !families.includes(v.family)) return false;
  return v.major > major || (v.major === major && v.minor >= minor);
}

// Checklist items (markdown, without the leading "- [ ] ") for moving call
// sites from any of `fromIds` to `toId`. Empty for non-Anthropic providers.
export function migrationChecklist(
  provider: string,
  fromIds: string[],
  toId: string,
): string[] {
  if (provider !== "anthropic") return [];
  const to = parseClaudeId(toId);
  const from = fromIds.map(parseClaudeId);

  const fableLine = atLeast(to, ["fable", "mythos"], 5);
  const noSampling = atLeast(to, ["opus"], 4, 7) || atLeast(to, ["sonnet"], 5);
  const adaptiveOnly = noSampling || fableLine;
  const thinksByDefault =
    atLeast(to, ["opus"], 5) || atLeast(to, ["sonnet"], 5) || fableLine;
  const opus55 = atLeast(to, ["opus"], 5, 5);
  const noForcedTools = opus55 || atLeast(to, ["fable", "mythos"], 5, 1);
  const noPrefill =
    atLeast(to, ["opus"], 4, 6) || atLeast(to, ["sonnet"], 4, 6) || fableLine;
  const newTokenizer =
    (atLeast(to, ["sonnet"], 5) &&
      from.some((f) => f?.family === "sonnet" && f.major < 5)) ||
    (atLeast(to, ["opus"], 4, 7) &&
      from.some((f) => f?.family === "opus" && !atLeast(f, ["opus"], 4, 7)));

  const items: string[] = [];
  if (noSampling) {
    items.push(
      "Remove `temperature`, `top_p` and `top_k`: non-default values return 400 on Opus 4.7+ and Sonnet 5+. Steer tone and variety from the prompt.",
    );
  }
  if (adaptiveOnly) {
    items.push(
      'Replace `thinking: {type: "enabled", budget_tokens}` with `thinking: {type: "adaptive"}` plus an explicit `output_config: {effort}`. `budget_tokens` returns 400.',
    );
  }
  if (opus55 || fableLine) {
    items.push(
      'Remove `thinking: {type: "disabled"}`: it returns 400 on Opus 5.5+ and Fable at every effort. Lower `effort` for faster, cheaper turns instead.',
    );
  } else if (atLeast(to, ["opus"], 5)) {
    items.push(
      'Keep `effort` at `high` or below anywhere `thinking: {type: "disabled"}` is sent: Opus 5 rejects disabled thinking at `xhigh` and `max`, and Opus 5.5 rejects it at every effort.',
    );
  }
  if (opus55) {
    items.push(
      "Set `effort` explicitly: Opus 5.5 defaults to `medium`, one level below earlier Opus models.",
    );
  }
  if (to?.family === "haiku" && to.major === 4) {
    items.push(
      'Send neither `thinking: {type: "adaptive"}` nor `output_config.effort` on Haiku 4.5 routes: both return 400.',
    );
  }
  if (thinksByDefault) {
    items.push(
      "Size `max_tokens` for thinking plus the answer: thinking runs when `thinking` is omitted and counts toward `max_tokens`. Stream calls whose budget grows past what the SDK allows without streaming.",
    );
  }
  if (newTokenizer) {
    items.push(
      "Re-check token budgets: the new tokenizer produces about 30% more tokens for the same text, so limits tuned on the old model can truncate.",
    );
  }
  if (noPrefill) {
    items.push(
      "Remove assistant-turn prefill: it returns 400. Use `output_config.format` or a system-prompt instruction.",
    );
  }
  items.push(
    'Read text by block type (`content.filter(b => b.type === "text")`), never `content[0].text`: with thinking on, the first block can be a `thinking` block.',
  );
  items.push(
    "Check `stop_reason` before trusting output: `refusal` (a safety classifier or the model declined; content is empty or partial) and `max_tokens` (truncated) are failures, not empty successes.",
  );
  if (noForcedTools) {
    items.push(
      'Replace forced `tool_choice` (`{type: "any"}` / `{type: "tool"}`): it returns 400 on Opus 5.5+ and Fable 5.1+. Use `auto` with `strict: true` tools and prompt steering, then check the call happened.',
    );
  }
  if (thinksByDefault) {
    items.push(
      "In manual tool-use loops, append the full `response.content` as the assistant turn, thinking blocks included and unmodified.",
    );
  }
  if (opus55) {
    items.push(
      'Opt non-batch calls into server-side refusal fallbacks (header `anthropic-beta: server-side-fallback-2026-07-01`, body `fallbacks: "default"`). Never send `fallbacks` to the Message Batches API.',
    );
  }
  return items;
}

// Markdown section for a bump PR body, or "" when there is nothing to say.
export function renderMigrationNotes(
  provider: string,
  fromIds: string[],
  toId: string,
): string {
  const items = migrationChecklist(provider, fromIds, toId);
  if (!items.length) return "";
  return [
    "### Before merging",
    "",
    `This PR only changes the model ID. \`${toId}\` may reject request shapes the old model accepted, so check every call site that uses it:`,
    "",
    ...items.map((i) => `- [ ] ${i}`),
    "",
    `Details: [Claude model migration guide](${MIGRATION_GUIDE_URL})`,
  ].join("\n");
}
