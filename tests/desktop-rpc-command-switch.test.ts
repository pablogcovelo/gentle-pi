import assert from "node:assert/strict";
import { test } from "node:test";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import { DESKTOP_RPC_SCHEMA, DESKTOP_RPC_WIDGET } from "../lib/desktop-rpc.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

// A session-replacing `run_command` through the REAL domain
// (odd/tasks/desktop-run-command-switch-answer.md, S1-S4). `new` and `resume`
// replace the session in-child, so the answer must come from the replacement
// after the teardown, exactly once, and only requests that arrive DURING the
// switch may be refused as `session_switching`. The unit tests in
// `desktop-rpc-commands.test.ts` exercise the bridge alone; these exercise the
// extension's dispatch, which is where the dispatching `requestId` is bound.

type WidgetCall = { key: string; lines: string[] };
type ReplacementPublisher = { ui: { setWidget(key: string, lines: string[]): void } };

function interactiveHost(t: test.TestContext): void {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
}

function harness(t: test.TestContext) {
	interactiveHost(t);
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const events = new Map<string, (event: unknown, ctx: unknown) => void>();
	const pi = {
		registerCommand(name: string, command: never) { commands.set(name, command); },
		on(name: string, handler: never) { events.set(name, handler); },
	};
	desktopRpc(pi as never);
	const widgets: WidgetCall[] = [];
	const publish = (key: string, lines: string[]) => { widgets.push({ key, lines }); };
	const ctx = { mode: "rpc", ui: { setWidget: publish } };
	return {
		events,
		widgets,
		publish,
		start() { events.get("session_start")?.({}, ctx); },
		async invoke(raw: string, targetCtx: unknown = ctx) {
			await commands.get("gentle:desktop")!.handler(raw, targetCtx);
		},
	};
}

function commandRequest(requestId: string, name: string): string {
	return JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method: "run_command", params: { name } });
}

function snapshotRequest(requestId: string): string {
	return JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method: "get_snapshot" });
}

function payloads(app: ReturnType<typeof harness>): any[] {
	return app.widgets.map((call) => {
		assert.equal(call.key, DESKTOP_RPC_WIDGET);
		assert.equal(call.lines.length, 1);
		return JSON.parse(call.lines[0]!);
	});
}

test("a session-replacing run_command answers once after the teardown", async (t) => {
	const app = harness(t);
	app.start();
	const host: Record<string, unknown> = {
		mode: "rpc",
		ui: { setWidget: app.publish },
		newSession: async (options: { withSession?: (next: ReplacementPublisher) => Promise<void> }) => {
			// Pi's order: the old session is torn down — `session_shutdown` resets
			// this slice and stops its router — before the replacement answers.
			app.events.get("session_shutdown")?.({}, host);
			await options.withSession?.({ ui: { setWidget: app.publish } });
			return { cancelled: false };
		},
	};
	await app.invoke(commandRequest("req-run", "new"), host);
	assert.deepEqual(payloads(app), [
		{
			schema: DESKTOP_RPC_SCHEMA,
			kind: "response",
			requestId: "req-run",
			ok: true,
			data: { executed: true },
		},
	]);
});

test("a run_command reload answers exactly once, before the reload replaces the runtime", async (t) => {
	const app = harness(t);
	app.start();
	const host: Record<string, unknown> = {
		mode: "rpc",
		ui: { setWidget: app.publish },
		reload: async () => {
			// Pi's order: the reload tears this session down first — the
			// extension's `session_shutdown` handler resets the slices and stops
			// the router — and only then the replacement takes over, starting a
			// fresh session on this same wire.
			app.events.get("session_shutdown")?.({}, host);
			app.events.get("session_start")?.({}, host);
		},
	};
	await app.invoke(commandRequest("req-reload", "reload"), host);

	const answers = payloads(app).filter((payload) => payload.kind === "response" && payload.requestId === "req-reload");
	assert.equal(answers.length, 1, "the reload request is answered exactly once, never zero and never twice");
	assert.deepEqual(answers[0], {
		schema: DESKTOP_RPC_SCHEMA,
		kind: "response",
		requestId: "req-reload",
		ok: true,
		data: { executed: true },
	});

	// Let the deferred reload actually run its teardown and replacement.
	await new Promise((settle) => setTimeout(settle, 0));
	// The replacement session keeps serving new requests.
	await app.invoke(snapshotRequest("req-after-reload"), host);
	const after = payloads(app).find((payload) => payload.kind === "response" && payload.requestId === "req-after-reload");
	assert.equal(after?.ok, true, "a follow-up request is still served after the reload");
});

test("only the requests that arrive during the switch are refused", async (t) => {
	const app = harness(t);
	app.start();
	let release = () => {};
	const held = new Promise<void>((resolve) => { release = resolve; });
	const host: Record<string, unknown> = {
		mode: "rpc",
		ui: { setWidget: app.publish },
		newSession: async (options: { withSession?: (next: ReplacementPublisher) => Promise<void> }) => {
			await held;
			app.events.get("session_shutdown")?.({}, host);
			await options.withSession?.({ ui: { setWidget: app.publish } });
			return { cancelled: false };
		},
	};
	const switching = app.invoke(commandRequest("req-run", "new"), host);
	// Let the dispatch reach the replacement and mark the switch in flight.
	await new Promise((settle) => setTimeout(settle, 20));
	await app.invoke(snapshotRequest("req-during"), host);
	release();
	await switching;

	const answers = payloads(app);
	assert.equal(answers.length, 2, "one answer per request, never a duplicate");
	const during = answers.find((answer) => answer.requestId === "req-during");
	assert.equal(during?.ok, false);
	assert.equal(during?.error.code, "session_switching");
	assert.deepEqual(answers.find((answer) => answer.requestId === "req-run"), {
		schema: DESKTOP_RPC_SCHEMA,
		kind: "response",
		requestId: "req-run",
		ok: true,
		data: { executed: true },
	});
});
