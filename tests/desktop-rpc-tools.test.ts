import assert from "node:assert/strict";
import test from "node:test";
import {
	DESKTOP_TOOLS_ENTRIES_LIMIT,
	DESKTOP_TOOLS_METHOD,
	DESKTOP_TOOLS_METHODS,
	INVALID_TOOLS_PARAMS,
	DesktopToolsBridge,
	toolVocabularyOutcome,
} from "../lib/desktop-rpc-tools.ts";
import { DESKTOP_RPC_SCHEMA, DesktopRpcRouter } from "../lib/desktop-rpc.ts";

// The tool-vocabulary slice publishes the native action classification as
// data — tool name or pattern mapped to a category and its native glyph —
// straight from lib/tool-vocabulary.ts, the same single projection the three
// render consumers use. The method is a pure read: no owner, no host, no state,
// and no render module behind the published payload.

test("tool_vocabulary advertises exactly its one method beside the core methods", async () => {
	const lines: string[] = [];
	const router = new DesktopRpcRouter(["capabilities", "get_snapshot", ...DESKTOP_TOOLS_METHODS], [], undefined, () => undefined);
	router.start((line) => lines.push(line));
	await router.handle(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "caps", method: "capabilities", params: {} }));
	assert.deepEqual(JSON.parse(lines[0]!).data.methods, ["capabilities", "get_snapshot", ...DESKTOP_TOOLS_METHODS]);
});

test("tool_vocabulary takes no params besides the optional tool name", () => {
	for (const params of [{ tool: 5 }, { tool: "" }, { tool: "x".repeat(257) }, { other: 1 }, { tool: "grep", extra: true }]) {
		assert.deepEqual(toolVocabularyOutcome(params), { ok: false, error: INVALID_TOOLS_PARAMS }, JSON.stringify(params));
	}
});

interface VocabularyData {
	categories: string[];
	entries: Array<{ category: string; glyph: string; tools?: string[]; patterns?: string[]; heading?: string }>;
	truncated: boolean;
}

test("the full read publishes every category and its native glyphs as pure data", () => {
	const outcome = toolVocabularyOutcome({});
	assert.ok(outcome.ok);
	const data = (outcome.ok ? outcome.data : {}) as unknown as VocabularyData;
	assert.deepEqual(data.categories, ["read", "edit", "write", "search", "list", "bash", "delegation", "rdd"]);
	assert.ok(!data.categories.includes("memory"), "the memory family stays absent, not invented");
	for (const entry of data.entries) {
		assert.equal(typeof entry.category, "string");
		assert.equal(typeof entry.glyph, "string");
		assert.ok(entry.glyph.length > 0);
	}
	const covered = new Set(data.entries.map((entry) => entry.category));
	for (const category of data.categories) assert.ok(covered.has(category), `${category} is published`);
	assert.equal(data.truncated, false, "the closed table fits inside the bound");
	// Pure data: the payload survives a JSON round-trip unchanged.
	assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
});

test("a vocabulary larger than the bound is clipped and labeled", () => {
	const many = Array.from({ length: DESKTOP_TOOLS_ENTRIES_LIMIT + 5 }, (_, i) => ({ category: "read" as const, glyph: "≡", tools: [`tool-${i}`] }));
	const outcome = toolVocabularyOutcome({}, many);
	assert.ok(outcome.ok);
	const data = outcome.data as unknown as VocabularyData;
	assert.equal(data.entries.length, DESKTOP_TOOLS_ENTRIES_LIMIT, "the list is bounded");
	assert.equal(data.truncated, true, "the clip is published, never silent");
	assert.deepEqual(data.categories, ["read", "edit", "write", "search", "list", "bash", "delegation", "rdd"], "the category set is unchanged");
});

test("a single tool classifies by exact name and by the review pattern", () => {
	assert.deepEqual(toolVocabularyOutcome({ tool: "grep" }), {
		ok: true, data: { tool: "grep", matched: true, category: "search", glyph: "⌕" },
	});
	assert.deepEqual(toolVocabularyOutcome({ tool: "subagent_run" }), {
		ok: true, data: { tool: "subagent_run", matched: true, category: "delegation", glyph: "→", heading: "Delegating" },
	});
	assert.deepEqual(toolVocabularyOutcome({ tool: "gentle_review_capture" }), {
		ok: true, data: { tool: "gentle_review_capture", matched: true, category: "rdd", glyph: "🌹", heading: "rdd" },
	});
});

test("a tool name outside every category answers unclassified, never invented", () => {
	assert.deepEqual(toolVocabularyOutcome({ tool: "totally_unknown" }), { ok: true, data: { tool: "totally_unknown", matched: false } });
	assert.deepEqual(toolVocabularyOutcome({ tool: "mem_search" }), { ok: true, data: { tool: "mem_search", matched: false } });
});

test("the bridge routes only its own method through the real router", async () => {
	const bridge = new DesktopToolsBridge();
	assert.equal(bridge.handle("get_snapshot", {}), undefined, "foreign methods fall through");
	const lines: string[] = [];
	const router = new DesktopRpcRouter(["capabilities", "get_snapshot", ...DESKTOP_TOOLS_METHODS], [], undefined, (method, params) => bridge.handle(method, params));
	router.start((line) => lines.push(line));
	await router.handle(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "t-1", method: DESKTOP_TOOLS_METHOD, params: { tool: "read" } }));
	assert.deepEqual(JSON.parse(lines[0]!), {
		schema: DESKTOP_RPC_SCHEMA,
		kind: "response",
		requestId: "t-1",
		ok: true,
		data: { tool: "read", matched: true, category: "read", glyph: "≡" },
	});
	assert.equal(lines.length, 1, "the method has no event");
	await router.handle(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "t-2", method: DESKTOP_TOOLS_METHOD, params: { tool: 5 } }));
	assert.equal(JSON.parse(lines[1]!).error.code, "invalid_request");
});
