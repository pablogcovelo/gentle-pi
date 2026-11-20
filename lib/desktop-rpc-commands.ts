// Gentle Desktop commands slice: the pure contract for `run_command`, the
// execution half of the session's command catalog (`lib/desktop-feed.ts`
// declares `runnable` per item).
//
// Nothing here touches pi. The answer set is closed —
// `{ executed: true }` or `{ executed: false, reason: "terminal_only" }` —
// and a catalog name never throws: only malformed parameters answer the
// transport's `invalid_request`.

export const DESKTOP_COMMANDS_METHODS = ["run_command"] as const;
/** `run_command` is an execution, not a read: this slice advertises no event. */
export const DESKTOP_COMMANDS_EVENTS = [] as const;

export const INVALID_COMMAND_PARAMS = { code: "invalid_request", message: "Invalid run_command parameters" } as const;

/** Why `run_command` refused a catalog name. A closed set of two values. */
export type DesktopRunCommandReason = "terminal_only" | "unknown_command";

/**
 * The `run_command` answer. `terminal_only`: the command exists but its
 * execution lives in pi's TUI (or the host lacks the capability this catalog
 * name needs). `unknown_command`: the name is not in the host's catalog.
 */
export type DesktopRunCommandResult = { executed: true } | { executed: false; reason: DesktopRunCommandReason };

export interface DesktopRunCommandParams {
	name: string;
	args: string | undefined;
}

/** Longest command name the wire compares; the feed clips catalog names to this too. */
export const DESKTOP_COMMANDS_NAME_LIMIT = 128;

/** `run_command` params: a required catalog `name`, plus optional string `args`. */
export function parseRunCommandParams(params: Record<string, unknown>): DesktopRunCommandParams | { error: { code: string; message: string } } {
	const keys = Object.keys(params ?? {});
	if (keys.some((key) => key !== "name" && key !== "args")) return { error: INVALID_COMMAND_PARAMS };
	const name = params.name;
	if (typeof name !== "string" || name.trim().length === 0 || name.length > DESKTOP_COMMANDS_NAME_LIMIT) return { error: INVALID_COMMAND_PARAMS };
	const args = params.args;
	if (args !== undefined && typeof args !== "string") return { error: INVALID_COMMAND_PARAMS };
	return { name, args: args as string | undefined };
}
