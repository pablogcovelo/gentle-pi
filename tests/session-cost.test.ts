import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildShellBarModel } from "../extensions/gentle-shell.ts";
import { readSessionCost, sessionCost } from "../lib/session-cost.ts";
import { renderShellBar, type ShellBarTheme } from "../lib/shell-bar.ts";

// The footer cost pin: the contract the session-cost extraction must hold.
// The bar's cost segment comes from summing the assistant usage entries of the
// live session, and the sum is the footer's own rendering contract — moved
// code may not change what the footer shows.

const plainTheme = {
	fg(_color: string, value: string) {
		return value;
	},
	bold(value: string) {
		return value;
	},
	bg(_color: string, value: string) {
		return value;
	},
} satisfies ShellBarTheme & { bg(color: string, value: string): string };

interface UsageEntry {
	type: string;
	message?: {
		role?: string;
		usage?: { cost?: { total?: number } };
	};
}

function assistantEntry(cost: number): UsageEntry {
	return { type: "message", message: { role: "assistant", usage: { cost: { total: cost } } } };
}

const footerData = {
	getGitBranch: () => null,
	getExtensionStatuses: () => new Map(),
	getAvailableProviderCount: () => 1,
	onBranchChange: () => () => {},
};

function fakeCtx(entries: UsageEntry[]): ExtensionContext {
	return {
		cwd: "/repo",
		model: { id: "gpt-5.5", provider: "openai-codex", reasoning: true, contextWindow: 272_000 },
		sessionManager: {
			getCwd: () => "/repo",
			getSessionName: () => "fixture",
			getEntries: () => entries,
			getSessionId: () => "session-cost-fixture",
		},
		modelRegistry: { isUsingOAuth: () => true },
		getContextUsage: () => ({ tokens: 122_400, contextWindow: 272_000, percent: 45 }),
	} as unknown as ExtensionContext;
}

test("footer cost pin: the bar renders the summed session cost of the assistant entries", () => {
	const pi = { getThinkingLevel: () => "medium" } as unknown as ExtensionAPI;
	const ctx = fakeCtx([assistantEntry(0.5), assistantEntry(0.25), { type: "message", message: { role: "user" } }]);
	const built = buildShellBarModel(pi, ctx, footerData, {});
	assert.equal(built.costTotal, 0.75);
	const bar = renderShellBar(built, plainTheme, 120).join("\n");
	assert.ok(bar.includes("$0.750"), `the bar must render the summed cost, got: ${bar}`);
});

test("the owner is the only place the value lives: the footer's cost is exactly the owner's read", () => {
	const pi = { getThinkingLevel: () => "medium" } as unknown as ExtensionAPI;
	// A cost-bearing session: whatever number the owner reports, the footer
	// renders — no shadow accumulator may exist in the extension.
	const ctx = fakeCtx([assistantEntry(0.5), assistantEntry(0.25), { type: "message", message: { role: "user" } }]);
	assert.equal(readSessionCost(ctx), 0.75);
	assert.equal(buildShellBarModel(pi, ctx, footerData, {}).costTotal, readSessionCost(ctx));

	// A session with entries but no assistant cost yet: owner-reported 0 kept.
	const zero = fakeCtx([{ type: "message", message: { role: "user" } }]);
	assert.equal(readSessionCost(zero), 0);
	assert.equal(buildShellBarModel(pi, zero, footerData, {}).costTotal, 0);

	// A host without the entries accessor: the owner has nothing to read.
	const unreadable = { sessionManager: { getSessionId: () => "s" } } as unknown as ExtensionContext;
	assert.equal(readSessionCost(unreadable), undefined, "unavailable is omitted, never zero");
	assert.equal(sessionCost(unreadable), 0, "the footer's read keeps its zero fallback");
});

test("footer cost pin: dollar-plus costs format without decimals padding and a fresh session reads zero", () => {
	const pi = { getThinkingLevel: () => "medium" } as unknown as ExtensionAPI;
	const rich = buildShellBarModel(pi, fakeCtx([assistantEntry(1), assistantEntry(0.25)]), footerData, {});
	assert.equal(rich.costTotal, 1.25);
	assert.ok(renderShellBar(rich, plainTheme, 120).join("\n").includes("$1.25"));

	const fresh = buildShellBarModel(pi, fakeCtx([]), footerData, {});
	assert.equal(fresh.costTotal, 0);
	assert.ok(renderShellBar(fresh, plainTheme, 120).join("\n").includes("$0.000"));
});

test("an owner that throws while answering reads as unavailable, never as zero", () => {
	// Advisory R3-001: the catch branch is a documented guarantee, so it needs a
	// test. This is an accessor that fails, not one that is absent.
	const pi = { getThinkingLevel: () => "medium" } as unknown as ExtensionAPI;
	const throwing = {
		cwd: "/repo",
		model: { id: "gpt-5.5", provider: "openai-codex", reasoning: true, contextWindow: 272_000 },
		sessionManager: {
			getCwd: () => "/repo",
			getSessionName: () => "fixture",
			getEntries: () => { throw new Error("session store unavailable"); },
			getSessionId: () => "session-cost-throwing",
		},
		modelRegistry: { isUsingOAuth: () => true },
		getContextUsage: () => ({ tokens: 1_000, contextWindow: 272_000, percent: 1 }),
	} as unknown as ExtensionContext;
	assert.equal(readSessionCost(throwing), undefined, "a failure to answer is unavailability, not zero");
	assert.equal(sessionCost(throwing), 0, "the footer's read keeps its zero fallback");
	assert.equal(buildShellBarModel(pi, throwing, footerData, {}).costTotal, 0);
});
