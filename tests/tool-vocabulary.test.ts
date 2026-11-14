import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderGentleAiLifecycleCall } from "../lib/gentle-ai-renderer.ts";
import { createQuietToolRenderer } from "../extensions/quiet-tools.ts";
import installGentleAgents from "../extensions/gentle-agents.ts";
// The projection module is imported inside the tests that need it: the three
// render pins above must characterize the render modules as they are, and the
// vocabulary tests fail on their own until lib/tool-vocabulary.ts exists.
type VocabularyModule = typeof import("../lib/tool-vocabulary.ts");
interface ClassifiedEntry {
	category: string;
	glyph: string;
	heading?: string;
}
const vocabulary = async (): Promise<VocabularyModule> => await import("../lib/tool-vocabulary.ts");

initTheme("dark");
const plainTheme = { bold: (value: string) => value, fg: (_color: string, value: string) => value };

// S6 risk item 3: the glyph tables below are consumed by the live TUI render.
// These three pins freeze the current rendered output byte for byte BEFORE the
// tables move into lib/tool-vocabulary.ts; after the inversion they must render
// the exact same strings, which is the contract for the move.

// Pin 1 — the rdd card (lib/gentle-ai-renderer.ts): the rose glyph and the
// `rdd` title, rendered for a review operation that is still preparing.
test("render pin: the rdd card keeps its rose glyph and rdd title", () => {
	const card = renderGentleAiLifecycleCall("review assess", plainTheme, { argsComplete: false, executionStarted: false });
	assert.deepEqual(card.render(60), [
		"╭─ 🌹 rdd preparing · assess ──────────────────────────────╮",
		"╰──────────────────────────────────────────────────────────╯",
	]);
});

// Pin 2 — the delegation call card (extensions/gentle-agents.ts): the per-action
// glyph (→) and heading (Delegating) on the subagent_run call card.
test("render pin: the delegation call card keeps its glyph and heading", () => {
	const registered: Array<{ name: string; renderCall: (args: Record<string, unknown>, theme: unknown, context: unknown) => { render(width: number): string[] } }> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: { on: () => () => {}, emit() {} },
		registerTool(tool: { name: string; renderCall: (args: Record<string, unknown>, theme: unknown, context: unknown) => { render(width: number): string[] } }) { registered.push(tool); },
		registerCommand() {}, registerShortcut() {}, registerMarkdownTransformer() {},
		registerMessageRenderer() {}, registerEntryRenderer() {},
	};
	installGentleAgents(pi as never, { GENTLE_PI_CONFIG_HOME: "/dev/null" }, {
		home: "/dev/null", agentHome: "/dev/null", env: { GENTLE_PI_CONFIG_HOME: "/dev/null" },
		now: () => 5_000, schedule: () => () => {}, resolveWorktree: () => undefined,
	});
	const run = registered.find((tool) => tool.name === "subagent_run");
	assert.ok(run, "subagent_run is registered");
	assert.deepEqual(run.renderCall({ agent: "scout" }, plainTheme, undefined).render(80), [
		"\u001b[38;2;143;122;217m╭\u001b[39m\u001b[38;2;143;122;217m─ \u001b[39m\u001b[38;2;185;167;242m→ Delegating\u001b[39m · scout\u001b[38;2;143;122;217m ──────────────────────────────────────────────\u001b[39m \u001b[38;2;126;136;142m\u001b[39m\u001b[38;2;157;165;169m expand\u001b[39m \u001b[38;2;143;122;217m╮\u001b[39m",
		"\u001b[38;2;143;122;217m│\u001b[39m running…                                                                     \u001b[38;2;143;122;217m│\u001b[39m",
		"\u001b[38;2;143;122;217m╰\u001b[39m\u001b[38;2;143;122;217m──────────────────────────────────────────────────────────────────────────────╯\u001b[39m",
	]);
});

// Pin 3 — the quiet tool card (extensions/quiet-tools.ts): the per-tool glyph
// (⌕) on the grep call card.
test("render pin: the quiet tool card keeps its glyph", () => {
	const grep = createQuietToolRenderer("grep");
	const context = {
		args: { pattern: "TODO" }, toolCallId: "tool-call", invalidate() {}, lastComponent: undefined,
		cwd: "/repo", executionStarted: false, argsComplete: true, isPartial: true, expanded: false,
		showImages: false, isError: false,
	};
	assert.deepEqual(grep.renderCall({ pattern: "TODO" }, plainTheme as never, context as never).render(80), [
		"╭─ ⌕ grep /TODO/ in . ─────────────────────────────────────────────────────────╮",
		"│ running…                                                                     │",
		"╰──────────────────────────────────────────────────────────────────────────────╯",
	]);
});

// ---- The published projection: the same tables as data ----

test("the published categories are exactly the eight native families, with no memory family", async () => {
	const { TOOL_VOCABULARY, TOOL_VOCABULARY_CATEGORIES } = await vocabulary();
	assert.deepEqual([...TOOL_VOCABULARY_CATEGORIES], ["read", "edit", "write", "search", "list", "bash", "delegation", "rdd"]);
	assert.ok(!TOOL_VOCABULARY_CATEGORIES.includes("memory" as never), "no memory category is invented");
	assert.ok(TOOL_VOCABULARY.length > 0);
});

test("every entry is data and stays inside the published categories", async () => {
	const { TOOL_VOCABULARY, TOOL_VOCABULARY_CATEGORIES } = await vocabulary();
	for (const entry of TOOL_VOCABULARY) {
		assert.ok(TOOL_VOCABULARY_CATEGORIES.includes(entry.category), `category ${entry.category} is published`);
		assert.equal(typeof entry.glyph, "string");
		assert.ok(entry.glyph.length > 0, `entry for ${entry.category} carries a non-empty glyph`);
		assert.ok((entry.tools?.length ?? 0) + (entry.patterns?.length ?? 0) > 0, `entry for ${entry.category} names at least one tool or pattern`);
	}
	// The projection is data: it survives a JSON round-trip unchanged, so no
	// renderer or pi-tui function can hide inside it.
	assert.deepEqual(JSON.parse(JSON.stringify(TOOL_VOCABULARY)) as unknown[], TOOL_VOCABULARY as unknown);
});

test("the projection certifies the absent memory family instead of inventing it", async () => {
	const { TOOL_VOCABULARY, classifyTool } = await vocabulary();
	assert.equal(classifyTool("mem_search"), undefined, "no mem_* tool is registered in this repository");
	assert.equal(classifyTool("memory_save"), undefined);
	for (const entry of TOOL_VOCABULARY) {
		assert.notEqual(entry.category, "memory");
		for (const name of entry.tools ?? []) assert.ok(!name.startsWith("mem_"), `no mem_* tool published: ${name}`);
		for (const pattern of entry.patterns ?? []) assert.ok(!pattern.startsWith("mem_"), `no mem_* pattern published: ${pattern}`);
	}
});

test("every published category resolves with its native glyph", async () => {
	const { RDD_CARD_GLYPH, TOOL_VOCABULARY, TOOL_VOCABULARY_CATEGORIES } = await vocabulary();
	const glyphs = new Map<string, string>();
	for (const entry of TOOL_VOCABULARY) if (!glyphs.has(entry.category)) glyphs.set(entry.category, entry.glyph);
	for (const category of TOOL_VOCABULARY_CATEGORIES) {
		assert.ok(glyphs.has(category), `category ${category} is published with a glyph`);
	}
	assert.equal(glyphs.get("read"), "≡");
	assert.equal(glyphs.get("edit"), "✎");
	assert.equal(glyphs.get("write"), "+");
	assert.equal(glyphs.get("search"), "⌕");
	assert.equal(glyphs.get("list"), "☷");
	assert.equal(glyphs.get("bash"), "$");
	assert.equal(glyphs.get("delegation"), "→");
	assert.equal(glyphs.get("rdd"), RDD_CARD_GLYPH);
});

test("classification resolves exact names and the review pattern, and nothing else", async () => {
	const { TOOL_GLYPH, DELEGATION_ACTION_GLYPH, DELEGATION_ACTION_HEADING, classifyTool } = await vocabulary();
	const entry = (name: string): ClassifiedEntry => {
		const found = classifyTool(name);
		assert.ok(found, `${name} classifies`);
		return found;
	};
	assert.equal(entry("read").category, "read");
	assert.equal(entry("edit").glyph, TOOL_GLYPH.edit);
	assert.equal(entry("write").glyph, TOOL_GLYPH.write);
	assert.equal(entry("grep").category, "search");
	assert.equal(entry("grep").glyph, "⌕");
	assert.equal(entry("find").category, "search", "find shares the search family");
	assert.equal(entry("find").glyph, "⌖", "but keeps its own glyph");
	assert.equal(entry("ls").category, "list");
	assert.equal(entry("bash").category, "bash");
	assert.equal(entry("subagent_run").category, "delegation");
	assert.equal(entry("subagent_run").heading, DELEGATION_ACTION_HEADING.run);
	assert.equal(entry("subagent_run").glyph, DELEGATION_ACTION_GLYPH.run);
	assert.equal(entry("subagent_list_agents").glyph, DELEGATION_ACTION_GLYPH.list_agents);
	assert.equal(entry("gentle_review").category, "rdd");
	assert.equal(entry("gentle_review_run").category, "rdd", "the review pattern covers the whole review family");
	assert.equal(entry("gentle_review_run").glyph, "🌹");
	assert.equal(classifyTool("totally_unknown"), undefined, "a tool outside every category stays unclassified");
});

test("the projection entries and the consumed tables cannot drift apart", async () => {
	const { TOOL_GLYPH, DELEGATION_ACTION_GLYPH, DELEGATION_ACTION_HEADING, classifyTool } = await vocabulary();
	for (const action of Object.keys(DELEGATION_ACTION_GLYPH)) {
		const entry = classifyTool(`subagent_${action}`);
		assert.ok(entry, `subagent_${action} classifies`);
		assert.equal(entry.glyph, DELEGATION_ACTION_GLYPH[action]);
		assert.equal(entry.heading, DELEGATION_ACTION_HEADING[action]);
	}
	for (const [name, glyph] of Object.entries(TOOL_GLYPH)) {
		const entry = classifyTool(name);
		assert.ok(entry, `${name} classifies`);
		assert.equal(entry.glyph, glyph);
	}
});
