import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DESKTOP_WORKTREE_METHOD,
	DESKTOP_WORKTREE_METHODS,
	DesktopWorktreeBridge,
	INVALID_WORKTREE_PARAMS,
	UNMEASURED_COUNTS,
	WORKTREE_ROOT_UNKNOWN,
	WORKTREE_UNAVAILABLE,
	worktreeChangesOutcome,
} from "../lib/desktop-rpc-worktree.ts";
import { DESKTOP_RPC_SCHEMA, DesktopRpcRouter } from "../lib/desktop-rpc.ts";
import { SESSION_WORKTREE_ENTRY } from "../lib/session-worktree-registry.ts";
import { CHANGE_STATUS, changesDigest, emptyChanges, type ChangedFile, type GitRunner } from "../lib/shell-changes.ts";

// The read-only proof fakes BOTH runners the owner tracker takes: discovery
// (`worktree list --porcelain -z`) and the per-root factory (HEAD verify,
// `status --porcelain`, `diff --numstat`). No git process ever runs here.

type FakeResponse = { code: number; stdout: string };

function fakeGit(handlers: Record<string, FakeResponse | Error> = {}) {
	const calls: string[][] = [];
	const runner: GitRunner = (args) => {
		calls.push(args);
		const handler = handlers[args.join(" ")];
		if (handler instanceof Error) return Promise.reject(handler);
		return Promise.resolve(handler ?? { code: 0, stdout: "" });
	};
	return { calls, runner };
}

const DISCOVERY = "worktree list --porcelain -z";
const HEAD = "rev-parse --verify -q HEAD";
const STATUS = "status --porcelain=v1 --untracked-files=all -z";
const DIFF = "diff --numstat HEAD";

const worktreeList = (root: string, branch?: string) =>
	`${["worktree " + root, ...(branch ? ["branch refs/heads/" + branch] : []), ""].join("\0")}\0`;

const ROOT = "/repo";
const happyHandlers = (): Record<string, FakeResponse> => ({
	[DISCOVERY]: { code: 0, stdout: worktreeList(ROOT, "main") },
	[HEAD]: { code: 0, stdout: "abc123\n" },
	[STATUS]: { code: 0, stdout: " M src/index.ts\0?? notes.txt\0" },
	[DIFF]: { code: 0, stdout: "12\t3\tsrc/index.ts\n" },
});
const owner = () => ({ knownRoots: () => [ROOT] });
const run = (handlers: Record<string, FakeResponse | Error>, root: string = ROOT) => {
	const { calls, runner } = fakeGit(handlers);
	return { calls, outcome: worktreeChangesOutcome({ root }, { discover: runner, gitForRoot: () => runner }, owner()) };
};

// ---- Params and the unknown-root gate: no Git work happens for either ----

test("malformed params answer invalid_request and run no Git", async () => {
	const badParams: Array<Record<string, unknown>> = [{}, { root: 7 }, { root: "" }, { root: "src" }, { root: "/r", mode: "x" }, { root: "/r\0" }];
	const { calls, runner } = fakeGit(happyHandlers());
	for (const params of badParams) {
		assert.deepEqual(await worktreeChangesOutcome(params, { discover: runner, gitForRoot: () => runner }, owner()), { ok: false, error: INVALID_WORKTREE_PARAMS });
	}
	assert.equal(calls.length, 0);
});

test("a root outside the session's own answers unknown_root and runs no Git", async () => {
	const { calls, outcome } = run(happyHandlers(), "/elsewhere");
	assert.deepEqual(await outcome, { ok: false, error: WORKTREE_ROOT_UNKNOWN });
	assert.equal(calls.length, 0);
});

// ---- The projection: the tracker's real shapes, labeled roots included ----

test("a scanned root answers its branch and the owner's ChangesModel", async () => {
	// Without a line counter nothing measured the untracked file, so its silent
	// zero is labeled instead (lib/shell-changes.ts:119 would answer added: 0).
	const files: ChangedFile[] = [
		{ path: "notes.txt", added: 0, deleted: 0, status: CHANGE_STATUS.UNTRACKED, countsUnavailable: UNMEASURED_COUNTS },
		{ path: "src/index.ts", added: 12, deleted: 3, status: CHANGE_STATUS.MODIFIED },
	];
	const { outcome } = run(happyHandlers());
	assert.deepEqual(await outcome, {
		ok: true,
		data: {
			root: ROOT,
			branch: "main",
			model: { files, added: 12, deleted: 3, digest: changesDigest({ files, added: 0, deleted: 0 }) },
		},
	});
});

test("a measured untracked file counts its lines and carries no label", async () => {
	const files: ChangedFile[] = [
		{ path: "notes.txt", added: 7, deleted: 0, status: CHANGE_STATUS.UNTRACKED },
		{ path: "src/index.ts", added: 12, deleted: 3, status: CHANGE_STATUS.MODIFIED },
	];
	const { runner } = fakeGit(happyHandlers());
	assert.deepEqual(
		await worktreeChangesOutcome({ root: ROOT }, { discover: runner, gitForRoot: () => runner, linesForRoot: () => async () => 7 }, owner()),
		{ ok: true, data: { root: ROOT, branch: "main", model: { files, added: 19, deleted: 3, digest: changesDigest({ files, added: 0, deleted: 0 }) } } },
	);
});

test("a failed root is labeled, never rendered as zero files or zero lines", async () => {
	const { outcome } = run({ ...happyHandlers(), [STATUS]: { code: 128, stdout: "" } });
	assert.deepEqual(await outcome, { ok: true, data: { root: ROOT, failed: true } });
});

test("an unborn root is labeled and never scanned for changes", async () => {
	const { calls, outcome } = run({ ...happyHandlers(), [HEAD]: { code: 1, stdout: "" } });
	assert.deepEqual(await outcome, { ok: true, data: { root: ROOT, unborn: true } });
	assert.ok(calls.every((args) => args[0] === "worktree" || args[0] === "rev-parse"), `status or diff ran: ${JSON.stringify(calls)}`);
});

test("a clean root answers the empty model with no branch claim", async () => {
	const { outcome } = run({ ...happyHandlers(), [STATUS]: { code: 0, stdout: "" } });
	assert.deepEqual(await outcome, { ok: true, data: { root: ROOT, model: emptyChanges() } });
});

test("a foreign root whose own HEAD cannot be read is labeled unknown, not dropped", async () => {
	const { calls, outcome } = run({
		[DISCOVERY]: { code: 0, stdout: worktreeList("/other") },
		[HEAD]: { code: 0, stdout: "abc\n" },
		[STATUS]: { code: 0, stdout: " M a.txt\0" },
		[DIFF]: { code: 0, stdout: "1\t0\ta.txt\n" },
		["symbolic-ref --quiet --short HEAD"]: new Error("git gone"),
	});
	assert.deepEqual(await outcome, {
		ok: true,
		data: {
			root: ROOT,
			branch: "unknown",
			model: { files: [{ path: "a.txt", added: 1, deleted: 0, status: CHANGE_STATUS.MODIFIED }], added: 1, deleted: 0, digest: changesDigest({ files: [{ path: "a.txt", added: 1, deleted: 0, status: CHANGE_STATUS.MODIFIED }], added: 0, deleted: 0 }) },
		},
	});
	// The fifth vector is the read-only branch probe for that foreign root, so the
	// proof pins it instead of letting it hide behind the parenthetical in the docs.
	assert.deepEqual(calls.map((args) => args.join(" ")).sort(), [DIFF, DISCOVERY, HEAD, STATUS, "symbolic-ref --quiet --short HEAD"].sort());
});

// ---- The read-only proof: both faked runners see only the four read-only ----
// ---- vectors, so no mutating git command and no extra call can hide.   ----

test("the scan runs exactly the four read-only git vectors and nothing else", async () => {
	const { calls, outcome } = run(happyHandlers());
	await outcome;
	assert.deepEqual(calls.map((args) => args.join(" ")).sort(), [DIFF, DISCOVERY, HEAD, STATUS].sort());
});

// ---- The bridge: session-owned roots and the extension's runner factory ----

test("the bridge gates on the session's own roots and answers truthfully without one", async () => {
	const { runner } = fakeGit({ [DISCOVERY]: { code: 0, stdout: worktreeList("/repo2") }, [HEAD]: { code: 0, stdout: "a\n" }, [STATUS]: { code: 0, stdout: "" }, [DIFF]: { code: 0, stdout: "" } });
	const bridge = new DesktopWorktreeBridge(() => runner);
	assert.deepEqual(await bridge.handle("get_config", {}), undefined);
	const context = {
		cwd: ROOT,
		sessionManager: {
			getSessionId: () => "session-a",
			getEntries: () => [
				{ type: "custom", customType: SESSION_WORKTREE_ENTRY, data: { sessionId: "session-a", root: "/repo2", evidence: "explicit" } },
				{ type: "custom", customType: "gentle-pi.session-change/v1", data: { sessionId: "session-a", evidence: { id: "e", root: "relative", path: "x", before: { kind: "absent" }, after: { kind: "absent" } } } },
			],
		},
	} as unknown as ExtensionContext;
	bridge.attach(context);
	assert.deepEqual(await bridge.handle(DESKTOP_WORKTREE_METHOD, { root: "/nope" }), { ok: false, error: WORKTREE_ROOT_UNKNOWN });
	assert.deepEqual(await bridge.handle(DESKTOP_WORKTREE_METHOD, { root: "/repo2" }), { ok: true, data: { root: "/repo2", model: emptyChanges() } });
	bridge.reset();
	assert.deepEqual(await bridge.handle(DESKTOP_WORKTREE_METHOD, { root: ROOT }), { ok: false, error: WORKTREE_UNAVAILABLE });
});

// ---- Capabilities: the per-domain exact array, like every other slice ----

test("the worktree slice advertises exactly its one method beside the core methods", async () => {
	const lines: string[] = [];
	const router = new DesktopRpcRouter(["capabilities", "get_snapshot", ...DESKTOP_WORKTREE_METHODS], [], undefined, () => undefined);
	router.start((line) => lines.push(line));
	await router.handle(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "caps", method: "capabilities", params: {} }));
	assert.deepEqual(JSON.parse(lines[0]!).data.methods, ["capabilities", "get_snapshot", ...DESKTOP_WORKTREE_METHODS]);
});

test("get_worktree_changes answers through the real router with a labeled failed root", async () => {
	const { runner } = fakeGit({ ...happyHandlers(), [STATUS]: { code: 128, stdout: "" } });
	const bridge = new DesktopWorktreeBridge(() => runner);
	bridge.attach({ cwd: ROOT, sessionManager: { getSessionId: () => "s", getEntries: () => [] } } as unknown as ExtensionContext);
	const lines: string[] = [];
	const router = new DesktopRpcRouter(["capabilities", "get_snapshot", ...DESKTOP_WORKTREE_METHODS], [], undefined, (method, params) => bridge.handle(method, params));
	router.start((line) => lines.push(line));
	await router.handle(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "wt-1", method: "get_worktree_changes", params: { root: ROOT } }));
	assert.deepEqual(JSON.parse(lines[0]!), { schema: DESKTOP_RPC_SCHEMA, kind: "response", requestId: "wt-1", ok: true, data: { root: ROOT, failed: true } });
	assert.equal(lines.length, 1);
});
