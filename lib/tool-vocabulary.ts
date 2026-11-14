// Gentle Desktop tool-vocabulary slice: the native action classification
// published as data — a tool name or pattern mapped to a category and its
// native glyph — so the Desktop client renders glyphs and headings itself
// instead of parsing TUI text (odd/tasks/desktop-rpc-client-gaps.md S6).
//
// This module owns the three glyph tables the TUI render already consumes:
// the quiet-tool glyphs (formerly the private `TOOL_GLYPH` in
// extensions/quiet-tools.ts), the agent-action glyphs and headings (formerly
// the private `ACTION_GLYPH`/`ACTION_HEADING` in extensions/gentle-agents.ts),
// and the rdd card identity (formerly the private `REVIEW_PREFIX`,
// `REVIEW_TITLE`, `BINARY_TITLE` and `CARD_GLYPH` in lib/gentle-ai-renderer.ts).
// Each render module consumes its table from here: exactly one table, no copy,
// no drift. The published projection below is pure data — no pi-tui import, no
// render-module import, nothing that draws.

export const TOOL_VOCABULARY_CATEGORIES = ["read", "edit", "write", "search", "list", "bash", "delegation", "rdd"] as const;
export type ToolVocabularyCategory = (typeof TOOL_VOCABULARY_CATEGORIES)[number];

/** The quiet tools whose calls draw one card apiece, keyed as the model calls them. */
export const TOOL_VOCABULARY_TOOLS = ["read", "bash", "grep", "find", "ls", "edit", "write"] as const;
export type ToolVocabularyToolName = (typeof TOOL_VOCABULARY_TOOLS)[number];

// Moved verbatim from extensions/quiet-tools.ts (TOOL_GLYPH): caller-owned
// identities; shared notices and lower widgets retain their glyphs.
export const TOOL_GLYPH: Record<ToolVocabularyToolName, string> = {
	read: "≡",
	bash: "$",
	grep: "⌕",
	find: "⌖",
	ls: "☷",
	edit: "✎",
	write: "+",
} as const;

// Moved verbatim from extensions/gentle-agents.ts (ACTION_GLYPH): the
// per-action identity from the design handoff (agent-tool-cards/04) — each
// agent tool carries its own glyph and reads as a verb.
export const DELEGATION_ACTION_GLYPH: Record<string, string> = {
	run: "→",
	status: "◎",
	result: "↩",
	cancel: "⨯",
	send_message: "✉",
	reply: "✉",
	continue: "↻",
	list_tasks: "☰",
	list_agents: "☰",
};

// Moved verbatim from extensions/gentle-agents.ts (ACTION_HEADING).
export const DELEGATION_ACTION_HEADING: Record<string, string> = {
	run: "Delegating",
	status: "Agent status",
	result: "Agent answer",
	cancel: "Stopping agent",
	send_message: "Messaging agent",
	reply: "Replying to agent",
	continue: "Resuming agent",
	list_tasks: "Agent tasks",
	list_agents: "Agent roster",
};

// Moved verbatim from lib/gentle-ai-renderer.ts: the rdd card identity. The
// title reads like the quiet read card — a short name, then the operation.
// Review operations are `rdd <op>`; any other binary call is `gentle-ai <op>`.
export const RDD_REVIEW_PREFIX = "review";
export const RDD_REVIEW_TITLE = "rdd";
export const GENTLE_AI_BINARY_TITLE = "gentle-ai";
// The binary keeps its rose as a colored emoji (2 cells, no text-presentation
// selector); Gentle Shell notices keep the flower.
export const RDD_CARD_GLYPH = "\u{1F339}";

/** One published family: tool names or prefix patterns classified as a category with its native glyph, plus the card heading the native renderer shows when one exists. */
export interface ToolVocabularyEntry {
	/** Exact tool names classified by this entry, as the model calls them. */
	tools?: readonly string[];
	/** Prefix patterns ending in `*`; `gentle_review*` matches every review tool. */
	patterns?: readonly string[];
	category: ToolVocabularyCategory;
	glyph: string;
	heading?: string;
}

// The published projection, derived from the same tables the render modules
// consume — never a second copy of them. There is no `memory` category: no
// mem_* tool is registered in this repository (Engram ships as a separate
// companion package), so the family stays absent until a provider publishes it.
export const TOOL_VOCABULARY: readonly ToolVocabularyEntry[] = [
	{ tools: ["read"], category: "read", glyph: TOOL_GLYPH.read },
	{ tools: ["edit"], category: "edit", glyph: TOOL_GLYPH.edit },
	{ tools: ["write"], category: "write", glyph: TOOL_GLYPH.write },
	{ tools: ["grep"], category: "search", glyph: TOOL_GLYPH.grep },
	{ tools: ["find"], category: "search", glyph: TOOL_GLYPH.find },
	{ tools: ["ls"], category: "list", glyph: TOOL_GLYPH.ls },
	{ tools: ["bash"], category: "bash", glyph: TOOL_GLYPH.bash },
	{ tools: ["subagent_run"], category: "delegation", glyph: DELEGATION_ACTION_GLYPH.run, heading: DELEGATION_ACTION_HEADING.run },
	{ tools: ["subagent_status"], category: "delegation", glyph: DELEGATION_ACTION_GLYPH.status, heading: DELEGATION_ACTION_HEADING.status },
	{ tools: ["subagent_result"], category: "delegation", glyph: DELEGATION_ACTION_GLYPH.result, heading: DELEGATION_ACTION_HEADING.result },
	{ tools: ["subagent_cancel"], category: "delegation", glyph: DELEGATION_ACTION_GLYPH.cancel, heading: DELEGATION_ACTION_HEADING.cancel },
	{ tools: ["subagent_send_message"], category: "delegation", glyph: DELEGATION_ACTION_GLYPH.send_message, heading: DELEGATION_ACTION_HEADING.send_message },
	{ tools: ["subagent_reply"], category: "delegation", glyph: DELEGATION_ACTION_GLYPH.reply, heading: DELEGATION_ACTION_HEADING.reply },
	{ tools: ["subagent_continue"], category: "delegation", glyph: DELEGATION_ACTION_GLYPH.continue, heading: DELEGATION_ACTION_HEADING.continue },
	{ tools: ["subagent_list_tasks"], category: "delegation", glyph: DELEGATION_ACTION_GLYPH.list_tasks, heading: DELEGATION_ACTION_HEADING.list_tasks },
	{ tools: ["subagent_list_agents"], category: "delegation", glyph: DELEGATION_ACTION_GLYPH.list_agents, heading: DELEGATION_ACTION_HEADING.list_agents },
	{ patterns: ["gentle_review*"], category: "rdd", glyph: RDD_CARD_GLYPH, heading: RDD_REVIEW_TITLE },
];

/** One classification lookup: exact tool names first, then prefix patterns. A name outside every category stays unclassified. */
export function classifyTool(toolName: string): ToolVocabularyEntry | undefined {
	for (const entry of TOOL_VOCABULARY) {
		if (entry.tools?.includes(toolName)) return entry;
	}
	for (const entry of TOOL_VOCABULARY) {
		for (const pattern of entry.patterns ?? []) {
			if (pattern.endsWith("*") && toolName.startsWith(pattern.slice(0, -1))) return entry;
		}
	}
	return undefined;
}
