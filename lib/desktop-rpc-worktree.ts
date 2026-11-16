// Gentle Desktop worktree slice: a read-only projection of the working-tree
// state Gentle Shell already computes, for one requested root, through the
// existing `WorktreeChangesTracker` in `lib/shell-changes.ts`.
//
// Nothing here spawns Git, parses its output, or stores anything. Runners are
// injected by the extension (the same `shellGitRunner` factory every shell scan
// uses); the tracker owns discovery (`worktree list --porcelain -z`) and the
// per-root scan (HEAD verify, `status --porcelain=v1 ... -z`,
// `diff --numstat HEAD`); this module only validates params, keeps the
// requested root inside the session's own roots, classifies the tracker's own
// labels (`failedRoots`, `unbornRoots`, `UNKNOWN_BRANCH`), and shapes the
// outcome. There is no second scanner, cache, watcher, or git writer.

import { isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import { sessionChangeRoots } from "./session-changes.ts";
import {
	CHANGE_STATUS,
	WorktreeChangesTracker,
	changesDigest,
	emptyChanges,
	type ChangesModel,
	type ChangedFile,
	type FileRevision,
	type GitRunner,
	type LineCounter,
} from "./shell-changes.ts";

export const DESKTOP_WORKTREE_METHODS = ["get_worktree_changes"] as const;
export const DESKTOP_WORKTREE_METHOD = DESKTOP_WORKTREE_METHODS[0];

/**
 * Upper bound on the files one answer carries. A root with more changed files
 * than this answers the first `DESKTOP_WORKTREE_FILES_LIMIT` paths beside
 * `truncated: true`; `model.added`, `model.deleted` and `model.digest` keep
 * describing every file the tracker scanned, so a clipped list never
 * understates the totals.
 */
export const DESKTOP_WORKTREE_FILES_LIMIT = 200;
/** Freeform bound on the branch label; a longer one is clipped, never refused. */
const BRANCH_FIELD_LIMIT = 200;

export const INVALID_WORKTREE_PARAMS = { code: "invalid_request", message: "Invalid get_worktree_changes parameters" } as const;
export const WORKTREE_ROOT_UNKNOWN = { code: "unknown_root", message: "Not a worktree root of this session" } as const;
export const WORKTREE_UNAVAILABLE = { code: "worktree_unavailable", message: "Worktree state unavailable for this session" } as const;
/**
 * Untracked files never appear in `diff --numstat` (`lib/shell-changes.ts:118`
 * answers `added: 0` for them), and only the shell's private line counter
 * measures their lines — so without one, a bare `added: 0` would claim a
 * measured zero. This label replaces it on every unmeasured untracked file.
 */
export const UNMEASURED_COUNTS = "Untracked file; line count not measured.";

/**
 * Params are exactly `{ root: <absolute path> }`. Anything else is a typed
 * `invalid_request` before any Git work happens.
 */
export function parseWorktreeParams(params: Record<string, unknown>): { root: string } | { error: typeof INVALID_WORKTREE_PARAMS } {
	const keys = Object.keys(params);
	const root = params.root;
	if (
		keys.length !== 1 || keys[0] !== "root" ||
		typeof root !== "string" || root.length === 0 || root.length > 4096 ||
		!isAbsolute(root) || /[\0\r\n]/.test(root)
	) {
		return { error: INVALID_WORKTREE_PARAMS };
	}
	return { root };
}

export interface DesktopWorktreeRunners {
	/** Discovery runner: `worktree list --porcelain -z`, as the shell runs it. */
	discover: GitRunner;
	/** One runner per root: HEAD verify, `status --porcelain`, `diff --numstat`. */
	gitForRoot(root: string): GitRunner;
	/** Optional owner seams the shell wires; absent falls back to the tracker's default. */
	linesForRoot?(root: string): LineCounter;
	revisionForRoot?(root: string): FileRevision | undefined;
}

export interface DesktopWorktreeOwner {
	/** The session's own roots: its project cwd plus the roots Changes already scans. */
	knownRoots(): readonly string[];
}

/**
 * One `get_worktree_changes` request. The only Git work is the tracker's own;
 * a failed or unborn root is labeled (`failed` / `unborn`) and carries no
 * model — never zero files or zero lines. A scanned root answers the owner's
 * real shape: `branch?` beside `model` (`files`, `added`, `deleted`, `digest`,
 * and the per-file `countsUnavailable`). A clean root is scanned and answered
 * with the empty model; the tracker keeps no group for it, so no `branch` is
 * claimed.
 */
export async function worktreeChangesOutcome(params: Record<string, unknown>, runners: DesktopWorktreeRunners, owner: DesktopWorktreeOwner): Promise<DesktopRpcOutcome> {
	const parsed = parseWorktreeParams(params);
	if ("error" in parsed) return { ok: false, error: parsed.error };
	const root = parsed.root;
	if (!owner.knownRoots().includes(root)) return { ok: false, error: WORKTREE_ROOT_UNKNOWN };
	const tracker = new WorktreeChangesTracker(
		runners.discover,
		runners.gitForRoot,
		runners.linesForRoot,
		() => [root],
		runners.revisionForRoot,
	);
	await tracker.refresh();
	if (tracker.unbornRoots.includes(root)) return { ok: true, data: { root, unborn: true } };
	if (tracker.failedRoots.includes(root)) return { ok: true, data: { root, failed: true } };
	const tree = tracker.worktrees.find((entry) => entry.root === root);
	if (!tree) return { ok: true, data: { root, model: boundFiles(emptyChanges()).model, truncated: false } };
	const bounded = boundFiles(labelUnmeasuredCounts(tree.model, runners.linesForRoot !== undefined));
	return {
		ok: true,
		data: {
			root,
			...(tree.branch ? { branch: tree.branch.length <= BRANCH_FIELD_LIMIT ? tree.branch : `${tree.branch.slice(0, BRANCH_FIELD_LIMIT - 1)}…` } : {}),
			model: bounded.model,
			truncated: bounded.truncated,
		},
	};
}

/**
 * The bounded file window. The tracked totals and the digest are the tracker's
 * own facts about the whole scan, so only the published list is clipped — a
 * `truncated: true` beside it is the client's signal that the panel is
 * incomplete rather than the root having exactly this many files.
 */
function boundFiles(model: ChangesModel): { model: ChangesModel; truncated: boolean } {
	if (model.files.length <= DESKTOP_WORKTREE_FILES_LIMIT) return { model, truncated: false };
	return { model: { ...model, files: model.files.slice(0, DESKTOP_WORKTREE_FILES_LIMIT) }, truncated: true };
}

/**
 * Without a line counter, untracked files were never measured, so the label
 * replaces their silent zero and the digest is recomputed over the labeled
 * files. `model.added`/`model.deleted` stay the tracker's own sums of measured
 * line counts (tracked files) — the same numbers the footer renders with its
 * partial-counts note. With a counter wired, measured untracked files answer
 * with their real count and no label.
 */
function labelUnmeasuredCounts(model: ChangesModel, measured: boolean): ChangesModel {
	if (measured) return model;
	let labeled = false;
	const files = model.files.map((file): ChangedFile => {
		if (file.status !== CHANGE_STATUS.UNTRACKED || file.countsUnavailable) return file;
		labeled = true;
		return { ...file, countsUnavailable: UNMEASURED_COUNTS };
	});
	if (!labeled) return model;
	return { ...model, files, digest: changesDigest({ files, added: 0, deleted: 0 }) };
}

/** The known-root set: the session's cwd plus its registered change roots. */
function knownWorktreeRoots(context: ExtensionContext): string[] {
	const roots = new Set<string>([context.cwd]);
	try {
		for (const root of sessionChangeRoots(context.sessionManager.getSessionId(), context.sessionManager.getEntries())) roots.add(root);
	} catch {
		// The cwd root still answers when entries cannot be read.
	}
	return [...roots];
}

/**
 * The Desktop domain slice for `get_worktree_changes`. Git runners come from
 * the extension's one factory — the shell's own `shellGitRunner` — so there is
 * no second spawn path, and the known-root gate keeps a Desktop request from
 * ever aiming this read at an arbitrary path.
 */
export class DesktopWorktreeBridge {
	private host: ExtensionContext | undefined;
	private readonly runner: (cwd: string) => GitRunner;

	constructor(runner: (cwd: string) => GitRunner) {
		this.runner = runner;
	}

	attach(context: ExtensionContext): void { this.host = context; }

	reset(): void { this.host = undefined; }

	handle(method: string, params: Record<string, unknown>): Promise<DesktopRpcOutcome | undefined> {
		if (method !== DESKTOP_WORKTREE_METHOD) return Promise.resolve(undefined);
		const context = this.host;
		if (!context) return Promise.resolve({ ok: false, error: WORKTREE_UNAVAILABLE });
		return worktreeChangesOutcome(
			params,
			{ discover: this.runner(context.cwd), gitForRoot: (root) => this.runner(root) },
			{ knownRoots: () => knownWorktreeRoots(context) },
		);
	}
}
