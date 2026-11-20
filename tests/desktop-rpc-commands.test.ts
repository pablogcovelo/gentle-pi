import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DESKTOP_RPC_SCHEMA, DESKTOP_RPC_WIDGET } from "../lib/desktop-rpc.ts";
import {
	DESKTOP_COMMANDS_EVENTS,
	DESKTOP_COMMANDS_METHODS,
	INVALID_COMMAND_PARAMS,
	parseRunCommandParams,
} from "../lib/desktop-rpc-commands.ts";
import { DesktopCommandsBridge } from "../lib/desktop-commands-service.ts";
import { DESKTOP_FEED_BUILTIN_COMMANDS } from "../lib/desktop-feed.ts";

// run_command (odd/tasks/desktop-run-command.md T2): a closed execution mapping
// over the host's own catalog. The bridge executes with the command context's
// session lifecycle calls and the extension API's own setters; every other
// catalog name is refused `terminal_only`, a name outside the catalog
// `unknown_command`, and a catalog name never throws.

/** The replacement-session context pi hands `withSession`, as far as publishing needs it. */
interface Replacement {
	ui: { setWidget(key: string, lines: string[]): void };
}

interface HostOverrides {
	newSession?: unknown;
	switchSession?: unknown;
	reload?: unknown;
	compact?: unknown;
	modelRegistry?: unknown;
}

function fakeHost(overrides: HostOverrides = {}): Record<string, unknown> {
	return {
		cwd: "/w",
		sessionManager: {},
		compact: () => {},
		modelRegistry: { find: () => undefined, getAll: () => [] },
		...overrides,
	};
}

interface ApiCalls {
	getCommands: unknown[];
	setModel: unknown[];
	setThinkingLevel: unknown[];
	setSessionName: unknown[];
}

function fakePi(registry: Array<{ name: string; source: string }> = [], absent: Array<"setModel" | "setThinkingLevel" | "setSessionName" | "getCommands"> = []) {
	const calls: ApiCalls = { getCommands: [], setModel: [], setThinkingLevel: [], setSessionName: [] };
	const pi: Record<string, unknown> = {};
	if (!absent.includes("getCommands")) pi.getCommands = () => { calls.getCommands.push(null); return registry; };
	if (!absent.includes("setModel")) pi.setModel = async (model: unknown) => { calls.setModel.push(model); return true; };
	if (!absent.includes("setThinkingLevel")) pi.setThinkingLevel = (level: unknown) => { calls.setThinkingLevel.push(level); };
	if (!absent.includes("setSessionName")) pi.setSessionName = (name: unknown) => { calls.setSessionName.push(name); };
	return { pi: pi as unknown as ExtensionAPI, calls };
}

function bridge(host: unknown, pi: ExtensionAPI): DesktopCommandsBridge {
	const instance = new DesktopCommandsBridge(pi);
	instance.attach(host as never);
	return instance;
}

const FAILING = () => { throw new Error("must not be called"); };

// ---- Contract ----

test("the contract is one method, no event, with closed params", () => {
	assert.deepEqual([...DESKTOP_COMMANDS_METHODS], ["run_command"]);
	assert.deepEqual([...DESKTOP_COMMANDS_EVENTS], []);
	assert.deepEqual(parseRunCommandParams({ name: "new" }), { name: "new", args: undefined });
	assert.deepEqual(parseRunCommandParams({ name: "name", args: "Feed" }), { name: "name", args: "Feed" });
	for (const params of [{}, { name: 7 }, { name: "" }, { name: "new", args: 7 }, { name: "new", extra: 1 }, { args: "x" }]) {
		assert.deepEqual(parseRunCommandParams(params as Record<string, unknown>), { error: INVALID_COMMAND_PARAMS });
	}
});

// ---- S4: the eight executable names ----

test("new replaces the session and the replacement answers with executed: true", async () => {
	const publishes: string[] = [];
	let withSession: ((next: Replacement) => Promise<void>) | undefined;
	const host = fakeHost({
		newSession: async (options: { withSession?: (next: Replacement) => Promise<void> }) => {
			withSession = options?.withSession;
			if (withSession) await withSession({ ui: { setWidget: (_key: string, lines: string[]) => publishes.push(...lines) } });
			return { cancelled: false };
		},
	});
	const { pi } = fakePi();
	const response = await bridge(host, pi).handle("run_command", { name: "new" }, "run-new");
	assert.deepEqual(response, { ok: true, data: { executed: true } });
	assert.equal(typeof withSession, "function", "the answer is published from the replacement session");
	assert.deepEqual(JSON.parse(publishes[0]!), {
		schema: DESKTOP_RPC_SCHEMA,
		kind: "response",
		requestId: "run-new",
		ok: true,
		data: { executed: true },
	});
});

test("resume switches to the session file the args name", async () => {
	let path: unknown;
	const host = fakeHost({ switchSession: async (sessionPath: string) => { path = sessionPath; return { cancelled: false }; } });
	const { pi } = fakePi();
	const response = await bridge(host, pi).handle("run_command", { name: "resume", args: "/s/probe.jsonl" }, "run-resume");
	assert.deepEqual(response, { ok: true, data: { executed: true } });
	assert.equal(path, "/s/probe.jsonl");
});

test("resume without args is terminal_only and never a throw", async () => {
	const host = fakeHost({ switchSession: FAILING });
	const { pi } = fakePi();
	for (const params of [{ name: "resume" }, { name: "resume", args: "" }, { name: "resume", args: "   " }]) {
		assert.deepEqual(await bridge(host, pi).handle("run_command", params, "run-resume"), { ok: true, data: { executed: false, reason: "terminal_only" } });
	}
});

test("compact triggers the host's compaction", async () => {
	let called = 0;
	const host = fakeHost({ compact: () => { called += 1; } });
	const { pi } = fakePi();
	assert.deepEqual(await bridge(host, pi).handle("run_command", { name: "compact" }, "run-compact"), { ok: true, data: { executed: true } });
	assert.equal(called, 1);
});

test("reload triggers the host's reload", async () => {
	let called = 0;
	const host = fakeHost({ reload: async () => { called += 1; } });
	const { pi } = fakePi();
	assert.deepEqual(await bridge(host, pi).handle("run_command", { name: "reload" }, "run-reload"), { ok: true, data: { executed: true } });
	assert.equal(called, 1, "the reload promise is not awaited");
});

test("model resolves the provider/id args through the session's registry and sets it", async () => {
	const model = { provider: "anthropic", id: "claude-opus-5-5" };
	const host = fakeHost({ modelRegistry: { find: (provider: string, id: string) => (provider === "anthropic" && id === "claude-opus-5-5" ? model : undefined), getAll: () => [] } });
	const { pi, calls } = fakePi();
	const response = await bridge(host, pi).handle("run_command", { name: "model", args: "anthropic/claude-opus-5-5" }, "run-model");
	assert.deepEqual(response, { ok: true, data: { executed: true } });
	assert.deepEqual(calls.setModel, [model]);
});

test("model without args, an unknown model, or a refused set is terminal_only", async () => {
	const host = fakeHost({ modelRegistry: { find: () => undefined, getAll: () => [] } });
	const { pi, calls } = fakePi();
	const instance = bridge(host, pi);
	for (const params of [{ name: "model" }, { name: "model", args: " " }, { name: "model", args: "anthropic/nope" }, { name: "model", args: "no-such-model" }]) {
		assert.deepEqual(await instance.handle("run_command", params, "run-model"), { ok: true, data: { executed: false, reason: "terminal_only" } }, JSON.stringify(params));
	}
	assert.deepEqual(calls.setModel, [], "no model was set");
});

test("thinking sets a valid level and refuses anything else", async () => {
	const host = fakeHost();
	const { pi, calls } = fakePi();
	const instance = bridge(host, pi);
	assert.deepEqual(await instance.handle("run_command", { name: "thinking", args: "high" }, "run-think"), { ok: true, data: { executed: true } });
	assert.deepEqual(calls.setThinkingLevel, ["high"]);
	calls.setThinkingLevel.length = 0;
	for (const args of [undefined, "", "loud"]) {
		assert.deepEqual(await instance.handle("run_command", { name: "thinking", ...(args === undefined ? {} : { args }) }, "run-think"), { ok: true, data: { executed: false, reason: "terminal_only" } });
	}
	assert.deepEqual(calls.setThinkingLevel, []);
});

test("name sets the session name and refuses a missing one", async () => {
	const host = fakeHost();
	const { pi, calls } = fakePi();
	const instance = bridge(host, pi);
	assert.deepEqual(await instance.handle("run_command", { name: "name", args: "Feed" }, "run-name"), { ok: true, data: { executed: true } });
	assert.deepEqual(calls.setSessionName, ["Feed"]);
	calls.setSessionName.length = 0;
	for (const params of [{ name: "name" }, { name: "name", args: " " }]) {
		assert.deepEqual(await instance.handle("run_command", params, "run-name"), { ok: true, data: { executed: false, reason: "terminal_only" } });
	}
	assert.deepEqual(calls.setSessionName, []);
});

// ---- S4: everything else is refused, never executed ----

test("terminal-only builtins are refused without touching the host", async () => {
	const { pi } = fakePi();
	for (const name of ["login", "settings", "hotkeys", "changelog", "copy", "share", "bug", "trust", "quit", "logout", "import", "export", "tree", "fork", "clone", "session"]) {
		assert.equal(DESKTOP_FEED_BUILTIN_COMMANDS.some((command) => command.name === name), name !== "quit", name);
		assert.deepEqual(await bridge(fakeHost({ newSession: FAILING, switchSession: FAILING, compact: FAILING, reload: FAILING }), pi).handle("run_command", { name }, "run-refused"),
			{ ok: true, data: { executed: false, reason: "terminal_only" } }, name);
	}
});

test("scoped-models is never runnable (S4a): it answers terminal_only like any non-runnable name", async () => {
	const { pi } = fakePi();
	assert.deepEqual(await bridge(fakeHost(), pi).handle("run_command", { name: "scoped-models", args: "anthropic/claude-opus-5-5" }, "run-scoped"),
		{ ok: true, data: { executed: false, reason: "terminal_only" } });
});

test("an extension command and the hidden RPC channel are terminal_only or unknown", async () => {
	const { pi } = fakePi([{ name: "gentle:status", source: "extension" }, { name: "gentle:desktop", source: "extension" }]);
	const instance = bridge(fakeHost({ newSession: FAILING, switchSession: FAILING }), pi);
	assert.deepEqual(await instance.handle("run_command", { name: "gentle:status", args: "x" }, "run-ext"), { ok: true, data: { executed: false, reason: "terminal_only" } });
	assert.deepEqual(await instance.handle("run_command", { name: "gentle:desktop" }, "run-ext"), { ok: true, data: { executed: false, reason: "unknown_command" } });
});

test("a name outside the host catalog is unknown_command", async () => {
	const { pi } = fakePi();
	assert.deepEqual(await bridge(fakeHost(), pi).handle("run_command", { name: "definitely-not-a-command" }, "run-unknown"), { ok: true, data: { executed: false, reason: "unknown_command" } });
});

test("malformed params answer invalid_request, never the executed set", async () => {
	const { pi } = fakePi();
	assert.deepEqual(await bridge(fakeHost(), pi).handle("run_command", { name: 7 }, "run-bad"), { ok: false, error: INVALID_COMMAND_PARAMS });
});

// ---- Missing capabilities degrade to terminal_only ----

test("a missing capability answers terminal_only instead of failing", async () => {
	const { pi } = fakePi([], ["setModel", "setThinkingLevel", "setSessionName"]);
	for (const [params, host] of [
		[{ name: "new" }, fakeHost({ newSession: undefined })],
		[{ name: "resume", args: "/s/x.jsonl" }, fakeHost({ switchSession: undefined })],
		[{ name: "compact" }, fakeHost({ compact: undefined })],
		[{ name: "reload" }, fakeHost({ reload: undefined })],
		[{ name: "model", args: "anthropic/claude-opus-5-5" }, fakeHost({ modelRegistry: undefined })],
		[{ name: "thinking", args: "high" }, fakeHost()],
		[{ name: "name", args: "Feed" }, fakeHost()],
	] as const) {
		assert.deepEqual(await bridge(host, pi).handle("run_command", params as Record<string, unknown>, "run-missing"), { ok: true, data: { executed: false, reason: "terminal_only" } }, JSON.stringify(params));
	}
});

test("a capability that throws answers terminal_only and never throws out", async () => {
	const throwing = fakePi([], ["setModel", "setThinkingLevel", "setSessionName"]).pi;
	for (const [params, host, api] of [
		[{ name: "new" }, fakeHost({ newSession: async () => { throw new Error("boom"); } }), throwing],
		[{ name: "resume", args: "/s/gone.jsonl" }, fakeHost({ switchSession: async () => { throw new Error("gone"); } }), throwing],
		[{ name: "compact" }, fakeHost({ compact: () => { throw new Error("boom"); } }), throwing],
		[{ name: "reload" }, fakeHost({ reload: () => { throw new Error("boom"); } }), throwing],
		[{ name: "model", args: "anthropic/claude-opus-5-5" }, fakeHost({ modelRegistry: { find: () => { throw new Error("boom"); }, getAll: () => { throw new Error("boom"); } } }), throwing],
		[{ name: "thinking", args: "high" }, fakeHost(), (() => { const { pi } = fakePi(); (pi as unknown as Record<string, unknown>).setThinkingLevel = () => { throw new Error("boom"); }; return pi; })()],
		[{ name: "name", args: "Feed" }, fakeHost(), (() => { const { pi } = fakePi(); (pi as unknown as Record<string, unknown>).setSessionName = () => { throw new Error("boom"); }; return pi; })()],
	] as const) {
		assert.deepEqual(await bridge(host, api).handle("run_command", params as Record<string, unknown>, "run-throw"), { ok: true, data: { executed: false, reason: "terminal_only" } }, JSON.stringify(params));
	}
});

test("a cancelled replacement is not reported as executed", async () => {
	const host = fakeHost({ newSession: async () => ({ cancelled: true }) });
	const { pi } = fakePi();
	assert.deepEqual(await bridge(host, pi).handle("run_command", { name: "new" }, "run-cancel"), { ok: true, data: { executed: false, reason: "terminal_only" } });
});

// ---- In-flight coordination with the router's switch gate ----

test("a replacement in flight is exposed like a switch, then cleared", async () => {
	let release: (() => void) | undefined;
	const host = fakeHost({ newSession: () => new Promise<{ cancelled: boolean }>((resolve) => { release = () => resolve({ cancelled: false }); }) });
	const { pi } = fakePi();
	const instance = bridge(host, pi);
	const pending = instance.handle("run_command", { name: "new" }, "run-flight");
	assert.deepEqual(instance.switchInFlight(), { requestId: "run-flight" });
	release!();
	assert.deepEqual(await pending, { ok: true, data: { executed: true } });
	assert.equal(instance.switchInFlight(), undefined);
});

test("a refused run names nothing from the host on the wire", async () => {
	const { pi } = fakePi([{ name: "gentle:status", source: "extension" }]);
	const response = await bridge(fakeHost(), pi).handle("run_command", { name: "gentle:status" }, "run-quiet");
	assert.doesNotMatch(JSON.stringify(response), /gentle|source|extension|\/w/);
	assert.equal(DESKTOP_RPC_WIDGET.length > 0, true);
});
