// Gentle Desktop session-state slice: one push event, `session_state_changed`,
// so a Desktop client never polls during a run. Every value is read from the
// owner the shell footer already reads — `ctx.model` and `pi.getThinkingLevel()`
// for the effective model and thinking (the same reads `buildShellBarModel`
// performs in `extensions/gentle-shell.ts`) and pi's own `ctx.getContextUsage()`
// for context usage. The bridge keeps no counter, no sampler and no timer: it
// only re-reads those owners at pi's own settle points and emits at most one
// event when the projection differs from the last one it delivered.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { oddPhaseRegistry, type OddPhase } from "./odd-phase.ts";
import { readSessionCost } from "./session-cost.ts";

export const DESKTOP_SESSION_STATE_EVENT = "session_state_changed";
export const DESKTOP_SESSION_STATE_EVENTS = [DESKTOP_SESSION_STATE_EVENT] as const;

/** The projected context usage. Every field is present only when its owner
 * answered with a real number: pi's own `null` (unknown, e.g. right after
 * compaction) means the field is omitted, never sent as `0`. */
export interface DesktopSessionContextUsage {
	tokens?: number;
	percent?: number;
	contextWindow?: number;
}

/** The `session_state_changed` payload: the session's effective state, per
 * field, omitted when unavailable. A fixed construction order keeps the
 * canonical form stable for change detection. */
export interface DesktopSessionStateEvent {
	model?: string;
	thinkingLevel?: string;
	context?: DesktopSessionContextUsage;
	/** The session cost as `lib/session-cost.ts` reports it: present only when
	 * the owner answers a number, so a fresh session's own `0` survives while an
	 * unmeasurable session omits the field instead of claiming a zero. */
	cost?: number;
	/** The ODD phase `lib/odd-phase.ts` holds for this session: present only
	 * while the registry has one, omitted when it is unknown, so a client clears
	 * its label by omission instead of reading a stale phase. The value is the
	 * owner's phase token (`implementing`), never its display label, and it is
	 * never inferred from transcript text or from a tool name here. */
	oddPhase?: OddPhase;
}

/** The effective model as `ctx.model` exposes it (the footer's `modelId` read). */
interface EffectiveModel {
	id?: unknown;
	reasoning?: unknown;
	contextWindow?: unknown;
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Per-field availability projection. `model` is the effective id the session
 * runs; `thinkingLevel` is read only for a reasoning-capable effective model —
 * the footer's own `model?.reasoning ? pi.getThinkingLevel() : undefined` rule —
 * so a non-reasoning model never reports a level. An absent owner answer omits
 * the field; a real `0` from the owner (e.g. a fresh context) is kept.
 */
export function projectSessionState(
	model: EffectiveModel | undefined,
	thinkingLevel: unknown,
	usage: { tokens?: unknown; percent?: unknown; contextWindow?: unknown } | undefined,
	cost?: unknown,
	oddPhase?: OddPhase,
): DesktopSessionStateEvent {
	const state: DesktopSessionStateEvent = {};
	if (model && typeof model.id === "string" && model.id.length > 0) state.model = model.id;
	if (model?.reasoning === true && typeof thinkingLevel === "string" && thinkingLevel.length > 0) {
		state.thinkingLevel = thinkingLevel;
	}
	const context: DesktopSessionContextUsage = {};
	if (usage && finiteNumber(usage.tokens)) context.tokens = usage.tokens;
	if (usage && finiteNumber(usage.percent)) context.percent = usage.percent;
	if (usage && finiteNumber(usage.contextWindow)) context.contextWindow = usage.contextWindow;
	else if (finiteNumber(model?.contextWindow) && (model?.contextWindow as number) > 0) context.contextWindow = model?.contextWindow as number;
	if (Object.keys(context).length > 0) state.context = context;
	// The cost owner answers `undefined` when it cannot measure, and that is
	// unavailability: the field is omitted, never zeroed. A real `0` is a fact.
	if (finiteNumber(cost)) state.cost = cost;
	// The ODD phase owner answers `undefined` for a session with no phase, and
	// clearing it is exactly that omission: the client drops its label.
	if (oddPhase !== undefined) state.oddPhase = oddPhase;
	return state;
}

export type DesktopSessionStateEmit = (event: string, data: Record<string, unknown>) => void;

/** The pi settle points the bridge observes. Nothing inside a turn is sampled:
 * context usage and thinking settle at the end of a turn, a model or thinking
 * change reports itself, and compaction and branch switches reset the leaf. */
const SESSION_STATE_TRIGGERS = ["turn_end", "model_select", "thinking_level_select", "session_compact", "session_tree"] as const;

/**
 * The push-only slice for `session_state_changed`. It subscribes to pi's own
 * settle events, re-reads the owners, and emits at most one event per settle —
 * and only when at least one field differs from the last delivered projection.
 * A reset (session replacement or shutdown) disconnects the observers and
 * drops the baseline, so the next wired settle re-delivers the fresh state.
 */
export class DesktopSessionStateBridge {
	private readonly pi: ExtensionAPI;
	private emit: DesktopSessionStateEmit | undefined;
	private disposers: Array<() => void> = [];
	/** Canonical form of the last delivered projection; `undefined` marks never delivered. */
	private lastEmitted: string | undefined;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	/** Route settled session-state changes through the router's sequencer. */
	wire(emit: DesktopSessionStateEmit): void {
		this.disposeObservers();
		this.emit = emit;
		// SAFETY: pi's `on` overloads are per-event-name; one generic signature
		// over all five settle events is exactly the contract those overloads
		// share — every handler is `(event, ctx) => void` and every unsubscribe
		// is a function, which is all this bridge relies on.
		const subscribe = this.pi.on as unknown as (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => (() => void) | undefined;
		for (const name of SESSION_STATE_TRIGGERS) {
			try {
				const dispose = subscribe.call(this.pi, name, (_event, ctx) => this.settle(ctx));
				if (typeof dispose === "function") this.disposers.push(dispose);
			} catch {
				/* a host without this settle event simply never reports it */
			}
		}
	}

	/** Session start/shutdown: the previous session's baseline is invalid. */
	reset(): void {
		this.disposeObservers();
		this.emit = undefined;
		this.lastEmitted = undefined;
	}

	private disposeObservers(): void {
		for (const dispose of this.disposers) {
			try {
				dispose();
			} catch {
				/* owner teardown */
			}
		}
		this.disposers = [];
	}

	/**
	 * The ODD phase the single owner in `lib/odd-phase.ts` holds for this
	 * session right now. The registry is the process-wide singleton both
	 * extensions read (the shell's own working label uses the same one), so this
	 * is a read of that owner, not a second store; an unreadable session answers
	 * no phase and the field is omitted.
	 */
	private oddPhase(ctx: ExtensionContext): OddPhase | undefined {
		try {
			return oddPhaseRegistry.get(ctx.sessionManager?.getSessionId?.());
		} catch {
			return undefined;
		}
	}

	/**
	 * Read the owners once, synchronously, and emit at most one event. Every
	 * read happens inside a single synchronous dispatch — pi delivers one event
	 * at a time on the same thread — so the payload cannot be torn by an
	 * interleaved agent mutation between the reads.
	 */
	settle(ctx: ExtensionContext): void {
		if (!this.emit) return;
		const model = ctx.model as EffectiveModel | undefined;
		let thinkingLevel: string | undefined;
		if (model?.reasoning === true) {
			try {
				// SAFETY: the host may predate `getThinkingLevel` (older pi builds);
				// the narrowed shape only checks presence, never bypasses a real
				// member, and the footer's reader makes the same defensive call.
				const level = (this.pi as unknown as { getThinkingLevel?: () => unknown }).getThinkingLevel?.();
				thinkingLevel = typeof level === "string" ? level : undefined;
			} catch {
				thinkingLevel = undefined;
			}
		}
		const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
		const state = projectSessionState(model, thinkingLevel, usage, readSessionCost(ctx), this.oddPhase(ctx));
		const canonical = JSON.stringify(state);
		if (canonical === this.lastEmitted) return;
		// Never open with an all-unavailable event: there is nothing to tell yet.
		if (Object.keys(state).length === 0 && this.lastEmitted === undefined) {
			this.lastEmitted = canonical;
			return;
		}
		this.lastEmitted = canonical;
		this.emit(DESKTOP_SESSION_STATE_EVENT, state as Record<string, unknown>);
	}
}
