// Gentle Desktop commands bridge: executes `run_command` with the authority the
// command context (`ExtensionCommandContext`) and the extension API already
// expose — never model text (odd/tasks/desktop-run-command.md S4).
//
// `new` and `resume` replace the session; like `switch_session`, their answer
// is published from the replacement session through `withSession`, correlated
// by the original requestId, and the in-flight token lets the transport gate
// concurrent requests (`session_switching`). `compact` is pi's own
// fire-and-forget call; `reload` replaces the runtime, so its answer is
// settled through the router first and only then is the reload itself invoked
// (odd/tasks/desktop-run-command-switch-answer.md L9). `model`,
// `thinking`, and `name` are the extension API's own setters. Every other
// catalog name — including `scoped-models`, which is never runnable (S4a: pi
// exposes model scoping only as the read-only `ctx.scopedModels` snapshot) —
// answers `terminal_only`; a name the host catalog does not list answers
// `unknown_command`. A catalog name never throws: a missing capability, a
// refused execution, and a failed call all answer `terminal_only` — except
// `reload`, whose answer has to cross the wire before the invocation replaces
// the runtime that would publish it: there `executed` means "reload
// scheduled", and a failure discovered afterwards is never retracted
// (docs/desktop-rpc.md, Commands limits).

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { parseModelRef } from "./agents-config.ts";
import { DESKTOP_FEED_BUILTIN_COMMANDS, HIDDEN_COMMANDS } from "./desktop-feed.ts";
import { DESKTOP_RPC_WIDGET, type DesktopRpcOutcome } from "./desktop-rpc.ts";
import {
	INVALID_COMMAND_PARAMS,
	parseRunCommandParams,
	type DesktopRunCommandParams,
	type DesktopRunCommandResult,
} from "./desktop-rpc-commands.ts";
import { desktopSessionsResponseLine } from "./desktop-rpc-sessions.ts";
import { THINKING_LEVELS } from "./model-routing-authority.ts";

/** Where the live runtime keeps the command context's session lifecycle calls. */
type CommandsHost = Pick<ExtensionCommandContext, "cwd" | "sessionManager"> &
	Partial<Pick<ExtensionCommandContext, "newSession" | "switchSession" | "reload">> &
	Partial<Pick<ExtensionContext, "compact" | "modelRegistry">>;

const COMMANDS_UNAVAILABLE = { code: "commands_unavailable", message: "Commands execution unavailable for this session" } as const;

/** Every built-in the feed catalog lists: a superset of `runnable` names. */
const BUILTIN_CATALOG = new Set(DESKTOP_FEED_BUILTIN_COMMANDS.map((command) => command.name));
/**
 * Built-ins pi really has but the feed leaves off the wire: `/quit` is typed,
 * never one click away, yet S4's table still refuses it as `terminal_only`
 * instead of calling it unknown.
 */
const BUILTIN_OFF_WIRE = new Set(["quit"]);

const EXECUTED: DesktopRunCommandResult = { executed: true };
const TERMINAL_ONLY: DesktopRunCommandResult = { executed: false, reason: "terminal_only" };
const UNKNOWN_COMMAND: DesktopRunCommandResult = { executed: false, reason: "unknown_command" };

/** `run_command` never carries an event, so an answer is just its result data. */
const answered = (result: DesktopRunCommandResult): DesktopRpcOutcome => ({
	ok: true,
	// SAFETY: `run_command` answers `{ executed }` exactly, which is a valid
	// `DesktopRpcState` record; the closed result type is only narrower.
	data: result as unknown as Record<string, unknown>,
});

const isCallable = (value: unknown): value is (...args: never[]) => unknown => typeof value === "function";

/** A replacement session's context, as far as publishing the answer needs it. */
interface ReplacedPublishContext {
	ui: { setWidget(key: string, lines: string[]): void };
}

/**
 * The Desktop domain slice for `run_command`. Session-scoped like the sessions
 * slice: a reset (session replacement or shutdown) unbinds the command context.
 */
export class DesktopCommandsBridge {
	private readonly pi: ExtensionAPI;
	private host: CommandsHost | undefined;
	private generation = 0;
	/** A session-replacing execution dispatched and not yet settled; at most one per session. */
	private inFlight: { requestId: string | null } | undefined;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	/** The command context of this Desktop session; bound per `/gentle:desktop` command. */
	attach(context: CommandsHost): void {
		this.host = context;
	}

	/** Session start/shutdown: the previous session's command context is stale. */
	reset(): void {
		this.generation += 1;
		this.host = undefined;
		this.inFlight = undefined;
	}

	/**
	 * The session-replacing execution currently in flight. The transport folds
	 * this into its switch gate, so `run_command`'s replacements refuse every
	 * other request exactly like `switch_session`'s do.
	 */
	switchInFlight(): { requestId: string | null } | undefined {
		return this.inFlight;
	}

	/** `undefined` for methods this slice does not own, so the extension falls through. */
	handle(method: string, params: Record<string, unknown>, requestId: string | null): Promise<DesktopRpcOutcome> | undefined {
		if (method !== "run_command") return undefined;
		return this.run(params, requestId);
	}

	private async run(params: Record<string, unknown>, requestId: string | null): Promise<DesktopRpcOutcome> {
		// Parse first: a malformed request never touches the host.
		const parsed = parseRunCommandParams(params);
		if ("error" in parsed) return { ok: false, error: parsed.error };
		const host = this.host;
		if (!host) return { ok: false, error: COMMANDS_UNAVAILABLE };
		const generation = this.generation;
		// The catalog decides existence: a name the host does not list is
		// `unknown_command`, whatever its args say.
		if (!this.cataloged(parsed.name)) return answered(UNKNOWN_COMMAND);
		switch (parsed.name) {
			case "new": return this.runNew(host, generation, requestId);
			case "resume": return this.runResume(host, generation, requestId, parsed.args);
			case "compact": return this.runCompact(host);
			case "reload": return this.runReload(host);
			case "model": return this.runModel(host, parsed.args);
			case "thinking": return this.runThinking(parsed.args);
			case "name": return this.runName(parsed.args);
			// Every other catalog name — the remaining builtins, `scoped-models`
			// (S4a: never runnable, pi exposes scoping only as the read-only
			// `ctx.scopedModels` snapshot), and every extension, prompt, and skill
			// entry — lives in pi's TUI.
			default: return answered(TERMINAL_ONLY);
		}
	}

	/** True when the name is in the feed's builtin table or pi's command registry. */
	private cataloged(name: string): boolean {
		if (BUILTIN_CATALOG.has(name) || BUILTIN_OFF_WIRE.has(name)) return true;
		// SAFETY: a capability check, not a typed call: older pi builds may lack
		// `getCommands`, so the API object is read as its own runtime shape.
		const getCommands = (this.pi as unknown as Record<string, unknown>).getCommands;
		if (typeof getCommands !== "function") return false;
		try {
			const registry = getCommands.call(this.pi) as Array<{ name?: unknown }> | undefined;
			return Array.isArray(registry) && registry.some((command) => command?.name === name && !HIDDEN_COMMANDS.has(name));
		} catch {
			return false;
		}
	}

	/**
	 * The answer a replacement publishes from the session pi started in place of
	 * this one; the router that would otherwise answer was stopped with it.
	 *
	 * Published only when the generation CHANGED: pi tears the session down
	 * before it runs `withSession`, so `session_shutdown` has always reset this
	 * slice by then. The polarity is `switch_session`'s own
	 * (`lib/desktop-sessions-service.ts`); comparing it the other way drops every
	 * session-replacing `run_command` answer and leaves the request that
	 * triggered the switch unanswered.
	 */
	private publishReplacement(next: ReplacedPublishContext, generation: number, requestId: string | null): Promise<void> {
		return (async () => {
			if (generation === this.generation || requestId === null) return;
			try {
				// SAFETY: the published data is the constant `{ executed: true }`, a
				// plain record by construction.
				next.ui.setWidget(DESKTOP_RPC_WIDGET, [desktopSessionsResponseLine(requestId, EXECUTED as unknown as Record<string, unknown>)]);
			} catch {
				/* transport failures are never retried as a second response */
			}
		})();
	}

	/** Wraps a session-replacing call: in-flight token, replacement publish, closed refusals. */
	private async replaceSession(
		run: (options: { withSession: (next: ReplacedPublishContext) => Promise<void> }) => Promise<{ cancelled?: unknown } | undefined>,
		generation: number,
		requestId: string | null,
	): Promise<DesktopRpcOutcome> {
		const token = { requestId };
		this.inFlight = token;
		try {
			const result = await run({
				// Pi tears this session down and starts the replacement before running
				// `withSession` with a context bound to it; the replacement publishes
				// the response there (see `lib/desktop-sessions-service.ts`).
				withSession: (next) => this.publishReplacement(next, generation, requestId),
			});
			if (result && result.cancelled === true) return answered(TERMINAL_ONLY);
			// After a real replacement the router that would publish this outcome
			// was stopped with the old session, so it is dropped; the replacement
			// context already answered. If no replacement happened, it answers here.
			return answered(EXECUTED);
		} catch {
			// Pi refused the execution (for example a session path that is gone);
			// its error names paths, and the closed answer set carries none.
			return answered(TERMINAL_ONLY);
		} finally {
			if (this.inFlight === token) this.inFlight = undefined;
		}
	}

	private runNew(host: CommandsHost, generation: number, requestId: string | null): Promise<DesktopRpcOutcome> {
		const newSession = host.newSession;
		if (!isCallable(newSession)) return Promise.resolve(answered(TERMINAL_ONLY));
		return this.replaceSession((options) => newSession.call(host, options) as Promise<{ cancelled?: unknown }>, generation, requestId);
	}

	private runResume(host: CommandsHost, generation: number, requestId: string | null, args: string | undefined): Promise<DesktopRpcOutcome> {
		// `resume` selects a session file: without the path the client must make
		// that choice in the Terminal, and the refusal is the answer, never a throw.
		if (typeof args !== "string" || args.trim().length === 0) return Promise.resolve(answered(TERMINAL_ONLY));
		const switchSession = host.switchSession;
		if (!isCallable(switchSession)) return Promise.resolve(answered(TERMINAL_ONLY));
		return this.replaceSession((options) => switchSession.call(host, args, options) as Promise<{ cancelled?: unknown }>, generation, requestId);
	}

	private runCompact(host: CommandsHost): DesktopRpcOutcome {
		const compact = host.compact;
		if (!isCallable(compact)) return answered(TERMINAL_ONLY);
		try {
			// Pi's compaction is fire-and-forget: triggering it is the execution,
			// and its outcome surfaces through the session's own compact events.
			compact.call(host);
		} catch {
			return answered(TERMINAL_ONLY);
		}
		return answered(EXECUTED);
	}

	private runReload(host: CommandsHost): DesktopRpcOutcome {
		const reload = host.reload;
		if (!isCallable(reload)) return answered(TERMINAL_ONLY);
		// Defect L9 (odd/tasks/desktop-run-command-switch-answer.md): invoking the
		// reload inside this answer's path let its teardown fire `session_shutdown`
		// — which resets this slice and stops the router — before the router could
		// publish the outcome, so `run_command {name:"reload"}` answered nothing
		// and the desktop waited forever. The invocation is therefore moved out of
		// the answer's path: the closed answer is returned now and the router
		// settles first (a macrotask runs only after every pending promise
		// continuation, including the router's publish), and the reload then runs
		// out of band — wrapped so a throwing or rejecting reload can never become
		// a second answer or an unhandled rejection.
		setTimeout(() => {
			try {
				const pending = reload.call(host) as unknown;
				const promise = pending as Promise<void> | undefined;
				if (promise && typeof promise.catch === "function") promise.catch(() => {});
			} catch {
				/* a failed reload cannot retract the answer already published */
			}
		}, 0);
		return answered(EXECUTED);
	}

	private async runModel(host: CommandsHost, args: string | undefined): Promise<DesktopRpcOutcome> {
		// SAFETY: a capability check, not a typed call: older pi builds may lack
		// `setModel`, so the API object is read as its own runtime shape.
		const setModel = (this.pi as unknown as Record<string, unknown>).setModel;
		if (!isCallable(setModel) || typeof args !== "string" || args.trim().length === 0) return answered(TERMINAL_ONLY);
		const model = this.resolveModel(host, args);
		if (!model) return answered(TERMINAL_ONLY);
		try {
			// `false` is pi's own refusal (no authentication configured).
			return (await (setModel as (model: Model<never>) => Promise<boolean>).call(this.pi, model)) === true ? answered(EXECUTED) : answered(TERMINAL_ONLY);
		} catch {
			return answered(TERMINAL_ONLY);
		}
	}

	/** The registry model a `provider/id` (or bare `id`) arg names, or undefined. */
	private resolveModel(host: CommandsHost, args: string): Model<Api> | undefined {
		// SAFETY: `host.modelRegistry` is pi's ModelRegistry facade; the defensive
		// subset keeps older builds (missing methods) answerable instead of throwing.
		const registry = host.modelRegistry as unknown as { find?: (provider: string, id: string) => Model<Api> | undefined; getAll?: () => Model<Api>[] } | undefined;
		if (!registry || typeof registry.find !== "function" || typeof registry.getAll !== "function") return undefined;
		const ref = parseModelRef(args);
		if (!ref) return undefined;
		try {
			const model = ref.provider ? registry.find!(ref.provider, ref.id) : registry.getAll!().find((candidate) => candidate.id === ref.id);
			return model ?? undefined;
		} catch {
			return undefined;
		}
	}

	private runThinking(args: string | undefined): DesktopRpcOutcome {
		// SAFETY: a capability check, not a typed call: older pi builds may lack
		// `setThinkingLevel`, so the API object is read as its own runtime shape.
		const setThinkingLevel = (this.pi as unknown as Record<string, unknown>).setThinkingLevel;
		const level = typeof args === "string" ? args.trim().toLowerCase() : "";
		if (!isCallable(setThinkingLevel) || !(THINKING_LEVELS as readonly string[]).includes(level)) return answered(TERMINAL_ONLY);
		try {
			(setThinkingLevel as (level: string) => void).call(this.pi, level);
		} catch {
			return answered(TERMINAL_ONLY);
		}
		return answered(EXECUTED);
	}

	private runName(args: string | undefined): DesktopRpcOutcome {
		// SAFETY: a capability check, not a typed call: older pi builds may lack
		// `setSessionName`, so the API object is read as its own runtime shape.
		const setSessionName = (this.pi as unknown as Record<string, unknown>).setSessionName;
		if (!isCallable(setSessionName) || typeof args !== "string" || args.trim().length === 0) return answered(TERMINAL_ONLY);
		try {
			(setSessionName as (name: string) => void).call(this.pi, args);
		} catch {
			return answered(TERMINAL_ONLY);
		}
		return answered(EXECUTED);
	}
}

/** Re-exported for the transport's invalid-request wording in tests. */
export { INVALID_COMMAND_PARAMS };

export type { DesktopRunCommandParams, DesktopRunCommandResult };
