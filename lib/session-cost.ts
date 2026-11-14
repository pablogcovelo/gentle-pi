// The single owner of the session cost accumulator. The shell footer and any
// other reader that needs the session's cost sum both read here — there is no
// second counter anywhere else (this is the counter L10 found private inside
// `extensions/gentle-shell.ts`; it moved so `session_state_changed` could
// carry the same value without a shadow copy).

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface AssistantUsageEntry {
	type: string;
	message?: {
		role?: string;
		usage?: {
			cost?: { total?: number };
		};
	};
}

/**
 * The session cost as the session's own entries report it, summed the one way
 * the footer has always summed it. Returns a number — including an
 * owner-reported `0` for a session with no cost-bearing entries yet — whenever
 * the host exposes the session entries at all. Returns `undefined` only when
 * the owner has nothing to read (a host without a session-entries accessor, or
 * one that fails to answer): that is unavailability, never a zero, and every
 * caller must treat it as omitted rather than reported.
 */
export function readSessionCost(ctx: ExtensionContext): number | undefined {
	try {
		const manager = ctx.sessionManager as ExtensionContext["sessionManager"] & { getEntries?: () => unknown };
		const entries = manager.getEntries?.();
		if (!Array.isArray(entries)) return undefined;
		let total = 0;
		for (const entry of entries as AssistantUsageEntry[]) {
			if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
			total += entry.message.usage?.cost?.total ?? 0;
		}
		return total;
	} catch {
		return undefined;
	}
}

/**
 * The footer's read: the same owner, with the unavailable case reading `0`
 * exactly as the footer has always rendered a session the host cannot sum.
 */
export function sessionCost(ctx: ExtensionContext): number {
	return readSessionCost(ctx) ?? 0;
}
