// Gentle Desktop subagents bridge: reaches the existing agents owner (the
// single parent-session `TaskStore` plus the parent `AgentRunner`, inside
// `extensions/gentle-agents.ts`) through a defensive, versioned owner-service
// event/adapter — the agents analogue of the jobs `discoverDesktopJobsService`
// seam. It never starts, stops, or spawns a subagent itself and keeps no
// second store or runner: every list and every cancel is the owner's own
// answer, shaped into the Desktop RPC contract by
// `lib/desktop-rpc-agents.ts`.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	AGENT_NOT_FOUND,
	DESKTOP_AGENTS_EVENT,
	DESKTOP_AGENTS_SERVICE_CHANNEL,
	agentsUnavailable,
	isDesktopAgentsServiceShape,
	parseCancelSubagentParams,
	parseDesktopAgentEntry,
	parseListSubagentsParams,
	type DesktopAgentEntry,
	type DesktopAgentsOwnerRead,
	type DesktopAgentsService,
} from "./desktop-rpc-agents.ts";
import { DESKTOP_UNAVAILABLE_REASON, parseTruncatedFlag, type DesktopRpcOutcome } from "./desktop-rpc.ts";

/**
 * The three outcomes of one owner read: a usable projection, an answer the
 * projection refused, or no usable answer at all. The list answer maps them to
 * its closed reasons instead of collapsing them into one unavailable code.
 */
type DesktopAgentsReadAttempt =
	| { kind: "ok"; read: DesktopAgentsOwnerRead }
	| { kind: "rejected" }
	| { kind: "absent" };

const DISCOVERY_TIMEOUT_MS = 100;
const DEFAULT_COALESCE_MS = 150;

/** The `agents_update` event payload: the active session's projected subagent list. */
export interface DesktopAgentsUpdateEvent {
	agents: DesktopAgentEntry[];
	/** Whether the owner's bound dropped entries from `agents`. */
	truncated: boolean;
}

/**
 * Dedupe key for one list answer: the projected entries plus the completeness
 * fact the event publishes. `truncated` belongs in the key because a burst can
 * leave the visible window byte-identical while the clip state flips; keying
 * on the entries alone would suppress that real change.
 */
function listKey(entries: readonly unknown[], truncated: boolean): string {
	return JSON.stringify([entries, truncated]);
}

interface HostUiAgentsRequest { context: ExtensionContext; respond(service: DesktopAgentsService): void }

/**
 * Discover the live agents owner exactly like the jobs seam: emit a bounded,
 * versioned request and accept only an adapter-shaped responder.
 */
export function discoverDesktopAgentsService(pi: ExtensionAPI, context: ExtensionContext): Promise<DesktopAgentsService | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => { settled = true; resolve(undefined); }, DISCOVERY_TIMEOUT_MS);
		const respond = (value: unknown) => {
			if (!isDesktopAgentsServiceShape(value)) return;
			if (settled) { value.dispose(); return; }
			settled = true; clearTimeout(timer); resolve(value);
		};
		try {
			pi.events.emit(DESKTOP_AGENTS_SERVICE_CHANNEL, { context, respond } satisfies HostUiAgentsRequest);
		} catch {
			settled = true; clearTimeout(timer); resolve(undefined);
		}
	});
}

type Emit = (event: string, data: Record<string, unknown>) => void;

interface DesktopAgentsBridgeOptions {
	discover?: typeof discoverDesktopAgentsService;
	schedule?: (fn: () => void, ms: number) => () => void;
	coalesceMs?: number;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
	const timer = setTimeout(fn, ms);
	// SAFETY: pi's host may or may not hand back a Node timer; `unref` is read
	// only when the runtime actually provides it, so an absent member is a no-op
	// rather than a cast that claims a shape the host never promised.
	(timer as unknown as { unref?: () => void }).unref?.();
	return () => clearTimeout(timer);
}

/**
 * The Desktop domain slice for `list_subagents`, `cancel_subagent`, and the
 * `agents_update` event. It is wired to the router's `emit` so TaskStore
 * transitions become ordered events, and it owns the session-scoped lifecycle:
 * a reset (session replacement or shutdown) disconnects the owner observer,
 * cancels any pending coalesced flush, and drops stale async outcomes. Bursts
 * of transitions are coalesced into one flush per window and byte-identical
 * projected lists are deduped, matching the activity publisher's behavior.
 */
export class DesktopAgentsBridge {
	private readonly pi: ExtensionAPI;
	private readonly discover: typeof discoverDesktopAgentsService;
	private readonly schedule: (fn: () => void, ms: number) => () => void;
	private readonly coalesceMs: number;
	private host: ExtensionContext | undefined;
	private service: DesktopAgentsService | undefined;
	private discovering: Promise<DesktopAgentsService | undefined> | undefined;
	private generation = 0;
	private observeDispose: (() => void) | undefined;
	private observeGeneration = 0;
	private emit: Emit | undefined;
	private flushTimer: (() => void) | undefined;
	/** Byte-identical projected list already emitted; suppresses observer duplicates. */
	private lastEmittedAgents: string | undefined;

	constructor(pi: ExtensionAPI, options: DesktopAgentsBridgeOptions = {}) {
		this.pi = pi;
		this.discover = options.discover ?? discoverDesktopAgentsService;
		this.schedule = options.schedule ?? defaultSchedule;
		this.coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
	}

	/** The live interactive context of this Desktop session; bound per command. */
	attach(context: ExtensionContext): void {
		this.host = context;
	}

	/** Route agent-driven `agents_update` events through the router's sequencer. */
	wire(emit: Emit): void {
		this.emit = emit;
	}

	/** Eager discovery/subscription so agent-driven transitions arrive before any request. */
	async start(): Promise<void> {
		const host = this.host;
		if (!host) return;
		await this.owner(host);
	}

	/** Session start/shutdown: the owner adapter of a previous session is invalid. */
	reset(): void {
		this.generation += 1;
		this.observeDispose?.();
		this.observeDispose = undefined;
		this.flushTimer?.();
		this.flushTimer = undefined;
		const service = this.service;
		this.service = undefined;
		this.discovering = undefined;
		this.host = undefined;
		this.emit = undefined;
		this.lastEmittedAgents = undefined;
		try {
			service?.dispose();
		} catch {
			/* owner teardown */
		}
	}

	async handle(method: string, params: Record<string, unknown>): Promise<DesktopRpcOutcome | undefined> {
		if (method !== "list_subagents" && method !== "cancel_subagent") return undefined;
		const host = this.host;
		if (!host) return { ok: false, error: agentsUnavailable(DESKTOP_UNAVAILABLE_REASON.NO_HOST) };
		// Parse before discovery: a malformed request must never trigger owner work.
		if (method === "list_subagents") {
			const parsed = parseListSubagentsParams(params);
			if ("error" in parsed) return { ok: false, error: parsed.error };
		} else {
			const parsed = parseCancelSubagentParams(params);
			if ("error" in parsed) return { ok: false, error: parsed.error };
		}
		const generation = this.generation;
		const service = await this.owner(host);
		if (generation !== this.generation || !service) return { ok: false, error: agentsUnavailable(DESKTOP_UNAVAILABLE_REASON.OWNER_UNAVAILABLE) };
		return method === "list_subagents" ? this.list(service) : this.cancel(service, params);
	}

	private async owner(context: ExtensionContext): Promise<DesktopAgentsService | undefined> {
		if (this.service) return this.service;
		if (!this.discovering) {
			const generation = this.generation;
			const discovering = Promise.resolve()
				.then(() => this.discover(this.pi, context))
				.then((service) => {
					// A reset/replacement happened while discovery was in flight: the
					// late adapter belongs to a superseded session. Dispose it and never
					// cache or re-subscribe it for the next session.
					if (generation !== this.generation || !service) {
						try { service?.dispose(); } catch { /* owner teardown */ }
						return undefined;
					}
					this.service = service;
					this.subscribe(service);
					return service;
				})
				.catch(() => undefined)
				.finally(() => {
					if (this.discovering === discovering) this.discovering = undefined;
				});
			this.discovering = discovering;
		}
		return this.discovering;
	}

	private subscribe(service: DesktopAgentsService): void {
		this.observeGeneration = this.generation;
		try {
			this.observeDispose = service.observe((sessionId) => this.onChanged(service, sessionId));
		} catch {
			this.observeDispose = undefined;
		}
	}

	/** Agent-driven transition: coalesce and then project the active session's list. */
	private onChanged(service: DesktopAgentsService, sessionId: string): void {
		if (this.observeGeneration !== this.generation) return;
		const host = this.host;
		const emit = this.emit;
		if (!host || !emit) return;
		if (sessionId !== this.activeSessionId(host)) return;
		this.scheduleFlush(service);
	}

	private scheduleFlush(service: DesktopAgentsService): void {
		if (this.flushTimer) return;
		this.flushTimer = this.schedule(() => {
			this.flushTimer = undefined;
			this.flush(service);
		}, this.coalesceMs);
	}

	/** Emit the active session's projected list once, deduping byte-identical content. */
	private flush(service: DesktopAgentsService): void {
		if (this.observeGeneration !== this.generation) return;
		const host = this.host;
		const emit = this.emit;
		if (!host || !emit) return;
		const attempt = this.readOwner(service);
		if (attempt.kind !== "ok") return;
		const read = attempt.read;
		const key = listKey(read.agents, read.truncated);
		if (key === this.lastEmittedAgents) return;
		this.lastEmittedAgents = key;
		emit(DESKTOP_AGENTS_EVENT, { agents: read.agents, truncated: read.truncated } satisfies DesktopAgentsUpdateEvent);
	}

	private activeSessionId(host: ExtensionContext): string {
		return host.sessionManager?.getSessionId?.() ?? "";
	}

	/**
	 * One owner read attempt, classified so an answer that was refused is
	 * distinguishable from an owner that answered nothing: `rejected` means the
	 * owner spoke and the projection refused its shape, `absent` means there was
	 * no usable answer at all (no responder, or a read that threw).
	 */
	private readOwner(service: DesktopAgentsService): DesktopAgentsReadAttempt {
		try {
			const read = service.read();
			if (!read || typeof read !== "object") return { kind: "absent" };
			const agents = this.parseAgents(read.agents);
			if (agents === undefined) return { kind: "rejected" };
			// A responder that cannot say whether it clipped is unusable: publishing
			// its list would claim completeness the owner never asserted.
			const truncated = parseTruncatedFlag(read.truncated);
			if (truncated === undefined) return { kind: "rejected" };
			return { kind: "ok", read: { sessionId: read.sessionId, agents, truncated } };
		} catch {
			// Raw owner failures carry prompt text and path detail; none of it
			// crosses the contract. An unreadable owner is treated as absent.
			return { kind: "absent" };
		}
	}

	private parseAgents(value: unknown): DesktopAgentEntry[] | undefined {
		if (!Array.isArray(value)) return undefined;
		const agents: DesktopAgentEntry[] = [];
		for (const entry of value) {
			const parsed = parseDesktopAgentEntry(entry);
			if (parsed === undefined) return undefined;
			agents.push(parsed);
		}
		return agents;
	}

	private list(service: DesktopAgentsService): DesktopRpcOutcome {
		const attempt = this.readOwner(service);
		if (attempt.kind === "ok") return { ok: true, data: { agents: attempt.read.agents, truncated: attempt.read.truncated } };
		// An owner that answered a shape the projection refuses is a different
		// fact from an absent owner, and the closed reason vocabulary says so.
		return {
			ok: false,
			error: agentsUnavailable(attempt.kind === "rejected"
				? DESKTOP_UNAVAILABLE_REASON.OWNER_ANSWER_REJECTED
				: DESKTOP_UNAVAILABLE_REASON.OWNER_UNAVAILABLE),
		};
	}

	private cancel(service: DesktopAgentsService, params: Record<string, unknown>): DesktopRpcOutcome {
		// Params were already validated before discovery; reparse defensively.
		const parsed = parseCancelSubagentParams(params);
		if ("error" in parsed) return { ok: false, error: parsed.error };
		let outcome: ReturnType<DesktopAgentsService["cancel"]>;
		try {
			outcome = service.cancel(parsed.id);
		} catch {
			// Raw owner failures carry prompt text and path detail; none of it crosses.
			return { ok: false, error: agentsUnavailable(DESKTOP_UNAVAILABLE_REASON.OWNER_UNAVAILABLE) };
		}
		if (!outcome || outcome.kind === "not_found") return { ok: false, error: AGENT_NOT_FOUND };
		// The owner's projected entry crosses the event bus: re-validate it.
		const agent = parseDesktopAgentEntry(outcome.agent);
		if (agent === undefined) return { ok: false, error: agentsUnavailable(DESKTOP_UNAVAILABLE_REASON.OWNER_ANSWER_REJECTED) };
		const data = { agent };
		// A no-op (already-terminal) cancellation changes nothing: answer the
		// terminal state and emit no event.
		if (outcome.changed !== true) return { ok: true, data };
		// Response-before-event: carry the event so the router publishes the
		// response line first, then one `agents_update` with the post-action list.
		const attempt = this.readOwner(service);
		const refreshed = attempt.kind === "ok" ? attempt.read : undefined;
		const agents = refreshed ? refreshed.agents : [agent];
		const truncated = refreshed ? refreshed.truncated : false;
		this.lastEmittedAgents = listKey(agents, truncated);
		return {
			ok: true,
			data,
			event: {
				name: DESKTOP_AGENTS_EVENT,
				data: { agents, truncated } satisfies DesktopAgentsUpdateEvent,
			},
		};
	}
}
