// Gentle Desktop active-profile slice: the session-effective agent-model
// profile label the footer already shows, beside the global `active` name.
//
// The spelling authority is `sessionProfileLabel` and the resolution is the
// single precedence rule `resolveSessionProfile` — the exact owner call the
// shell's `createActiveProfileReader` makes in its `refresh()`
// (`extensions/gentle-shell.ts`). There is no second resolution
// implementation and no second reader instance: this slice keeps no bind
// state and no file-identity cache, it resolves once per request and reads
// the global `active` name from the profiles store owner
// (`lib/agent-profiles.ts`, the same read the reader's `global()` performs).
//
// A bound session answers `name (session)`, a local pin `name (local)`, a
// repository declaration `name (repo)`, and a session on the global default
// the bare global name — so a client can always tell the session-effective
// label apart from the global `active` name. The label never identifies an
// account.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import { profilesFilePath, readProfilesFileResult } from "./agent-profiles.ts";
import { gentlePiConfigHome } from "./agent-home.ts";
import { resolveSessionWorktree, type WorktreeIdentity, type WorktreeResolver } from "./session-worktree-registry.ts";
import { resolveSessionProfile, sessionProfileLabel } from "./session-profile-freeze.ts";

export const DESKTOP_PROFILE_METHODS = ["get_active_profile"] as const;
export const DESKTOP_PROFILE_METHOD = DESKTOP_PROFILE_METHODS[0];

export const INVALID_PROFILE_PARAMS = { code: "invalid_request", message: "Invalid get_active_profile parameters" } as const;
export const PROFILE_UNAVAILABLE = { code: "profile_unavailable", message: "Active profile unavailable for this session" } as const;

/** `get_active_profile` takes no params; anything else is a typed `invalid_request` before any owner is read. */
export function invalidProfileParams(params: Record<string, unknown>): boolean {
	return Object.keys(params).length !== 0;
}

export interface DesktopActiveProfileInput {
	sessionId: string | undefined;
	cwd: string | undefined;
	configHome: string;
	env?: NodeJS.ProcessEnv;
	resolveWorktree?: WorktreeResolver;
}

/** The bare global `active` name, from the profiles store owner; `undefined` when the store has none. */
export function globalActiveName(configHome: string): string | undefined {
	try {
		const result = readProfilesFileResult(profilesFilePath(configHome));
		return result.status === "valid" ? result.file.active : undefined;
	} catch {
		return undefined;
	}
}

/**
 * One `get_active_profile` request. The reader's own rule: an unbound read
 * (`cwd` absent) answers only the global `active`; a bound read resolves the
 * session once and labels it. A label the resolution does not yield is
 * omitted, never fabricated; the same holds for the global name. Both fields
 * omitted means no layer has a profile at all.
 */
export function activeProfileOutcome(params: Record<string, unknown>, input: DesktopActiveProfileInput): DesktopRpcOutcome {
	if (invalidProfileParams(params)) return { ok: false, error: INVALID_PROFILE_PARAMS };
	const active = globalActiveName(input.configHome);
	let label: string | undefined;
	if (input.cwd === undefined) {
		label = active;
	} else {
		let identity: WorktreeIdentity | undefined;
		try {
			// The resolver's second argument is the repository cwd, not a session id
			// (`WorktreeResolver = (path, cwd)`): the session root is both, and this is
			// the same pair the shell binds (extensions/gentle-shell.ts:277). The
			// session id reaches the profile owner through resolveSessionProfile below.
			identity = input.resolveWorktree?.(input.cwd, input.cwd);
		} catch {
			identity = undefined;
		}
		label = sessionProfileLabel(resolveSessionProfile({
			sessionId: input.sessionId,
			cwd: input.cwd,
			configHome: input.configHome,
			resolveWorktree: () => identity,
			env: input.env,
		}));
	}
	return { ok: true, data: { ...(label !== undefined ? { label } : {}), ...(active !== undefined ? { active } : {}) } };
}

/**
 * The Desktop domain slice for `get_active_profile`. The session identity
 * (cwd, session id) comes from the request's own command context; the
 * worktree identity comes from the same session-worktree resolver the shell
 * wires, resolved once per request like the reader's `bind` does.
 */
export class DesktopProfileBridge {
	private host: ExtensionContext | undefined;
	private readonly resolveWorktree: WorktreeResolver;

	constructor(resolveWorktree: WorktreeResolver = resolveSessionWorktree) {
		this.resolveWorktree = resolveWorktree;
	}

	attach(context: ExtensionContext): void { this.host = context; }

	reset(): void { this.host = undefined; }

	handle(method: string, params: Record<string, unknown>): DesktopRpcOutcome | undefined {
		if (method !== DESKTOP_PROFILE_METHOD) return undefined;
		const context = this.host;
		if (!context) return { ok: false, error: PROFILE_UNAVAILABLE };
		let sessionId: string | undefined;
		try {
			sessionId = context.sessionManager.getSessionId();
		} catch {
			sessionId = undefined;
		}
		return activeProfileOutcome(params, {
			sessionId,
			cwd: context.cwd,
			configHome: gentlePiConfigHome(),
			resolveWorktree: this.resolveWorktree,
		});
	}
}
