import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import { DESKTOP_RPC_SCHEMA } from "../lib/desktop-rpc.ts";
import { DesktopSessionStateBridge } from "../lib/desktop-rpc-session-state.ts";
import { oddPhaseRegistry } from "../lib/odd-phase.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

// ---- Fakes: pi event bus + a session context carrying the real owners ----

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface FakePi {
	pi: ExtensionAPI;
	fire(name: string, event: unknown, ctx: ExtensionContext): void;
	handlerCount(name: string): number;
	setThinking(level: string | undefined): void;
}

function fakePi(): FakePi {
	const handlers = new Map<string, Handler[]>();
	let thinking: string | undefined = "medium";
	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => {
				const index = list.indexOf(handler);
				if (index >= 0) list.splice(index, 1);
			};
		},
		getThinkingLevel: () => thinking,
	} as unknown as ExtensionAPI;
	return {
		pi,
		fire(name, event, ctx) {
			for (const handler of [...(handlers.get(name) ?? [])]) handler(event, ctx);
		},
		handlerCount(name) {
			return (handlers.get(name) ?? []).length;
		},
		setThinking(level) {
			thinking = level;
		},
	};
}

interface CtxOverrides {
	model?: Record<string, unknown> | undefined;
	usage?: Record<string, unknown> | undefined;
	entries?: unknown[] | undefined;
}

function fakeCtx(overrides: CtxOverrides = {}): ExtensionContext {
	return {
		model: "model" in overrides ? overrides.model : { id: "anthropic/claude-opus-4-6", reasoning: true, contextWindow: 272_000 },
		getContextUsage: () => ("usage" in overrides ? overrides.usage : { tokens: 48_211, contextWindow: 272_000, percent: 17.7 }),
		sessionManager: "entries" in overrides
			? { getSessionId: () => "session-1", getEntries: () => overrides.entries }
			: { getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;
}

function sessionStateBridge(): { bridge: DesktopSessionStateBridge; emitted: Array<{ event: string; data: Record<string, unknown> }> } {
	const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
	const bridge = new DesktopSessionStateBridge(fakePi().pi);
	bridge.wire((event, data) => emitted.push({ event, data }));
	return { bridge, emitted };
}

// ---- Transport: the event is advertised, existing order untouched ----

test("the Desktop transport advertises session_state_changed after the existing events", async (t) => {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const fires = new Map<string, Handler[]>();
	const pi = {
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		on(name: string, handler: Handler) {
			const list = fires.get(name) ?? [];
			list.push(handler);
			fires.set(name, list);
		},
	} as unknown as ExtensionAPI;
	desktopRpc(pi);
	const widgets: Array<{ key: string; lines: string[] }> = [];
	const ctx = { mode: "rpc", ui: { setWidget(key: string, lines: string[]) { widgets.push({ key, lines }); } } };
	for (const handler of fires.get("session_start") ?? []) handler({}, ctx as unknown as ExtensionContext);
	await commands.get("gentle:desktop")!.handler(
		JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "cap-1", method: "capabilities", params: {} }),
		ctx,
	);
	const response = JSON.parse(widgets[0]!.lines[0]!);
	assert.deepEqual(response.data.events, [
		"config_changed",
		"permission_mode_changed",
		"rate_limit",
		"design_canvas",
		"jobs_update",
		"profile_applied",
		"agents_update",
		"session_state_changed",
		"review_mode_changed",
	]);
});

// ---- Payload shape: every field available ----

test("a settled turn emits one event carrying model, thinking level and context", async () => {
	const { bridge, emitted } = sessionStateBridge();
	bridge.settle(fakeCtx());
	assert.equal(emitted.length, 1);
	assert.equal(emitted[0]!.event, "session_state_changed");
	assert.deepEqual(emitted[0]!.data, {
		model: "anthropic/claude-opus-4-6",
		thinkingLevel: "medium",
		context: { tokens: 48_211, percent: 17.7, contextWindow: 272_000 },
	});
	assert.equal("cost" in emitted[0]!.data, false, "a host with no session entries cannot be summed, so cost is omitted");
});

// ---- Cost: the owner's number, or nothing at all ----

test("the settled event carries the session cost the owner reports", async () => {
	const { bridge, emitted } = sessionStateBridge();
	bridge.settle(fakeCtx({ entries: [
		{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.25 } } } },
		{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.75 } } } },
		{ type: "message", message: { role: "user" } },
	] }));
	assert.equal(emitted[0]!.data.cost, 1);
});

test("a session that spent nothing yet keeps the owner's zero", async () => {
	const { bridge, emitted } = sessionStateBridge();
	bridge.settle(fakeCtx({ entries: [] }));
	assert.equal(emitted[0]!.data.cost, 0);
});

test("an unsummable host omits cost instead of claiming a zero", async () => {
	const { bridge, emitted } = sessionStateBridge();
	bridge.settle(fakeCtx());
	assert.equal("cost" in emitted[0]!.data, false);
});

test("a settle that only moves the cost emits exactly one more event", async () => {
	// Advisory R3-002: the field's interaction with the change-only dedup is a
	// consequence of the shared mechanism, and this proves it over two settles.
	const { bridge, emitted } = sessionStateBridge();
	bridge.settle(fakeCtx({ entries: [] }));
	assert.equal(emitted.length, 1, "the first settle delivers the state");
	assert.equal(emitted[0]!.data.cost, 0);

	bridge.settle(fakeCtx({ entries: [] }));
	assert.equal(emitted.length, 1, "an unchanged cost delivers nothing");

	bridge.settle(fakeCtx({ entries: [
		{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.5 } } } },
	] }));
	assert.equal(emitted.length, 2, "a cost-only change delivers exactly one event");
	assert.equal(emitted[1]!.data.cost, 0.5);
});

// ---- ODD phase: the owner's value, and clearing by omission ----

test("the settled event carries the ODD phase the registry holds for this session", (t) => {
	t.after(() => oddPhaseRegistry.clear("session-1"));
	const { bridge, emitted } = sessionStateBridge();
	oddPhaseRegistry.report("session-1", "implementing");
	bridge.settle(fakeCtx());
	assert.equal(
		emitted[0]!.data.oddPhase,
		"implementing",
		"the owner's phase token travels, never its display label",
	);
});

test("a session with no ODD phase omits the field instead of claiming one", (t) => {
	t.after(() => oddPhaseRegistry.clear("session-1"));
	oddPhaseRegistry.clear("session-1");
	const { bridge, emitted } = sessionStateBridge();
	bridge.settle(fakeCtx());
	assert.equal(emitted.length, 1, "the other fields still deliver the state");
	assert.equal("oddPhase" in emitted[0]!.data, false, "an unknown phase is omitted, never a placeholder");
});

test("another session's phase never reaches this session's event", (t) => {
	t.after(() => oddPhaseRegistry.clear("session-2"));
	const { bridge, emitted } = sessionStateBridge();
	oddPhaseRegistry.report("session-2", "checking");
	bridge.settle(fakeCtx());
	assert.equal("oddPhase" in emitted[0]!.data, false, "the phase is read for this session only");
});

test("clearing the phase is published as omission, not as a stale token", (t) => {
	t.after(() => oddPhaseRegistry.clear("session-1"));
	const { bridge, emitted } = sessionStateBridge();
	oddPhaseRegistry.report("session-1", "implementing");
	bridge.settle(fakeCtx());
	assert.equal(emitted[0]!.data.oddPhase, "implementing");

	oddPhaseRegistry.clear("session-1");
	bridge.settle(fakeCtx());
	assert.equal(emitted.length, 2, "a cleared phase is a real change and delivers one event");
	assert.equal("oddPhase" in emitted[1]!.data, false, "cleared means omitted");
});

// ---- Availability is per field: unavailable is omitted, never zero ----

test("an unavailable value is omitted, never sent as zero or a placeholder", async () => {
	const { bridge, emitted } = sessionStateBridge();
	// No model at all: no model, no thinking (even though pi would answer), no context.
	bridge.settle(fakeCtx({ model: undefined, usage: undefined }));
	assert.equal(emitted.length, 0, "a state with nothing available emits nothing");

	// A model without reasoning support: no thinkingLevel even though pi answers.
	bridge.settle(fakeCtx({ model: { id: "openai/gpt-5", contextWindow: 400_000 }, usage: undefined }));
	assert.deepEqual(emitted[0]!.data, { model: "openai/gpt-5", context: { contextWindow: 400_000 } });

	// pi reports null tokens and percent right after compaction: only the window stays.
	bridge.settle(fakeCtx({ usage: { tokens: null, contextWindow: 272_000, percent: null } }));
	assert.deepEqual(emitted[1]!.data, {
		model: "anthropic/claude-opus-4-6",
		thinkingLevel: "medium",
		context: { contextWindow: 272_000 },
	});

	// No context owner answer, but the model carries a window: the footer's fallback read.
	bridge.settle(fakeCtx({ model: { id: "openai/gpt-5", reasoning: true, contextWindow: 400_000 }, usage: undefined }));
	assert.deepEqual(emitted[2]!.data, {
		model: "openai/gpt-5",
		thinkingLevel: "medium",
		context: { contextWindow: 400_000 },
	});
	assert.equal(emitted.every((entry) => !JSON.stringify(entry.data).includes('"cost"')), true);
});

test("zero is a real value from the owner and is kept", async () => {
	const { bridge, emitted } = sessionStateBridge();
	bridge.settle(fakeCtx({ usage: { tokens: 0, contextWindow: 272_000, percent: 0 } }));
	assert.deepEqual(emitted[0]!.data, {
		model: "anthropic/claude-opus-4-6",
		thinkingLevel: "medium",
		context: { tokens: 0, percent: 0, contextWindow: 272_000 },
	});
});

// ---- Effective values, never the requested ones ----

test("model and thinking are read back as the session runs them, after the change", async () => {
	const host = fakePi();
	const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
	const bridge = new DesktopSessionStateBridge(host.pi);
	bridge.wire((event: string, data: Record<string, unknown>) => emitted.push({ event, data }));
	const ctx = fakeCtx({ usage: undefined });
	// The requested model at session start differs from what the session settles on.
	(ctx as unknown as { model: unknown }).model = { id: "openai/gpt-5-nano", reasoning: false, contextWindow: 128_000 };
	host.setThinking("low");
	host.fire("turn_end", { type: "turn_end" }, ctx);
	assert.deepEqual(emitted[0]!.data, { model: "openai/gpt-5-nano", context: { contextWindow: 128_000 } });

	// A model_select is read through ctx.model afterwards: the effective model.
	(ctx as unknown as { model: unknown }).model = { id: "anthropic/claude-opus-4-6", reasoning: true, contextWindow: 272_000 };
	host.fire("model_select", { type: "model_select", source: "set" }, ctx);
	assert.deepEqual(emitted[1]!.data, {
		model: "anthropic/claude-opus-4-6",
		thinkingLevel: "low",
		context: { contextWindow: 272_000 },
	});

	// A thinking_level_select reads the level the session now runs.
	host.setThinking("high");
	host.fire("thinking_level_select", { type: "thinking_level_select" }, ctx);
	assert.equal(emitted.length, 3);
	assert.deepEqual(emitted[2]!.data, {
		model: "anthropic/claude-opus-4-6",
		thinkingLevel: "high",
		context: { contextWindow: 272_000 },
	});

	// A settle with nothing left to change stays silent.
	host.fire("thinking_level_select", { type: "thinking_level_select" }, ctx);
	assert.equal(emitted.length, 3);
});

// ---- Coalescing: one event per settled change, none when nothing changed ----

test("several fields moving within one settle produce exactly one event", async () => {
	const { bridge, emitted } = sessionStateBridge();
	bridge.settle(fakeCtx());
	assert.equal(emitted.length, 1);
	// The next turn settles with a new model and new usage at once: one event.
	bridge.settle(fakeCtx({ model: { id: "openai/gpt-5", reasoning: true, contextWindow: 400_000 }, usage: { tokens: 90_000, contextWindow: 400_000, percent: 22.5 } }));
	assert.equal(emitted.length, 2);
	assert.deepEqual(emitted[1]!.data, {
		model: "openai/gpt-5",
		thinkingLevel: "medium",
		context: { tokens: 90_000, percent: 22.5, contextWindow: 400_000 },
	});
});

test("a turn that settles nothing emits nothing", async () => {
	const { bridge, emitted } = sessionStateBridge();
	bridge.settle(fakeCtx());
	assert.equal(emitted.length, 1);
	for (let index = 0; index < 5; index += 1) bridge.settle(fakeCtx());
	assert.equal(emitted.length, 1, "no polling contract: unchanged settles are silent");
});

test("internal mutations between settles emit nothing; only settle points are observed", async () => {
	const host = fakePi();
	const bridge = new DesktopSessionStateBridge(host.pi);
	let emitted = 0;
	bridge.wire(() => {
		emitted += 1;
	});
	const ctx = fakeCtx();
	host.fire("turn_end", { type: "turn_end" }, ctx);
	// Tool and message traffic inside the next turn is not observed at all.
	host.fire("tool_execution_end", { type: "tool_execution_end" }, ctx);
	host.fire("message_end", { type: "message_end" }, ctx);
	assert.equal(emitted, 1);
	assert.equal(host.handlerCount("tool_execution_end"), 0);
	assert.equal(host.handlerCount("message_end"), 0);
	// Compaction and branch switches are settle points: context collapses there.
	(ctx as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({ tokens: null, contextWindow: 272_000, percent: null });
	host.fire("session_compact", { type: "session_compact" }, ctx);
	assert.equal(emitted, 2);
});

// ---- Router contract: existing events keep their order and seq ----

test("the event rides the router sequencer and never disturbs the response contract", async (t) => {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const fires = new Map<string, Handler[]>();
	const pi = {
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		on(name: string, handler: Handler) {
			const list = fires.get(name) ?? [];
			list.push(handler);
			fires.set(name, list);
		},
	} as unknown as ExtensionAPI;
	desktopRpc(pi);
	const widgets: Array<{ key: string; lines: string[] }> = [];
	const ctx = {
		mode: "rpc",
		model: { id: "anthropic/claude-opus-4-6", reasoning: true, contextWindow: 272_000 },
		getContextUsage: () => ({ tokens: 48_211, contextWindow: 272_000, percent: 17.7 }),
		ui: { setWidget(key: string, lines: string[]) { widgets.push({ key, lines }); } },
	} as unknown as ExtensionContext;
	for (const handler of fires.get("session_start") ?? []) handler({}, ctx);

	const invoke = async (method: string) =>
		commands.get("gentle:desktop")!.handler(
			JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: `req-${method}`, method, params: {} }),
			ctx,
		);
	await invoke("capabilities");
	assert.equal(JSON.parse(widgets[0]!.lines[0]!).kind, "response");

	for (const handler of fires.get("turn_end") ?? []) handler({ type: "turn_end" }, ctx);
	assert.equal(JSON.parse(widgets[1]!.lines[0]!).seq, 1, "the first settled state is seq 1");

	// A response between events consumes no sequence number.
	await invoke("get_snapshot");
	assert.equal(JSON.parse(widgets[2]!.lines[0]!).data.sequence, 1);

	(ctx as unknown as { model: unknown }).model = { id: "openai/gpt-5", reasoning: true, contextWindow: 400_000 };
	for (const handler of fires.get("model_select") ?? []) handler({ type: "model_select" }, ctx);
	const second = JSON.parse(widgets[3]!.lines[0]!);
	assert.equal(second.seq, 2, "seq keeps counting through the same sequencer");
	assert.equal(second.event, "session_state_changed");
	// The context owner still answers, so its window rides, not the model fallback.
	assert.deepEqual(second.data, {
		model: "openai/gpt-5",
		context: { tokens: 48_211, percent: 17.7, contextWindow: 272_000 },
	});
});

// ---- Lifecycle: reset disconnects the settle observers ----

test("a reset disconnects the settle observers and a fresh wire re-subscribes once", async () => {
	const host = fakePi();
	const bridge = new DesktopSessionStateBridge(host.pi);
	let emitted = 0;
	bridge.wire(() => {
		emitted += 1;
	});
	assert.equal(host.handlerCount("turn_end"), 1);
	bridge.reset();
	assert.equal(host.handlerCount("turn_end"), 0);
	host.fire("turn_end", { type: "turn_end" }, fakeCtx());
	assert.equal(emitted, 0, "a replaced session emits nothing");
	bridge.wire(() => {
		emitted += 1;
	});
	assert.equal(host.handlerCount("turn_end"), 1, "rewiring subscribes exactly once");
});
