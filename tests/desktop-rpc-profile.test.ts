import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DESKTOP_PROFILE_METHOD,
	DESKTOP_PROFILE_METHODS,
	DesktopProfileBridge,
	INVALID_PROFILE_PARAMS,
	PROFILE_UNAVAILABLE,
	activeProfileOutcome,
	type DesktopActiveProfileInput,
} from "../lib/desktop-rpc-profile.ts";
import { profilesFilePath } from "../lib/agent-profiles.ts";
import { localProfilePinPath, repoProfileDeclarationPath, writeProfilePinSync } from "../lib/agent-profile-pin.ts";
import { bindSessionProfile, readSessionProfileBinding, resetSessionProfileBindingsForTesting } from "../lib/session-profile-binding.ts";
import { createActiveProfileReader } from "../extensions/gentle-shell.ts";
import type { WorktreeIdentity } from "../lib/session-worktree-registry.ts";
import { DESKTOP_RPC_SCHEMA, DesktopRpcRouter, type DesktopRpcOutcome } from "../lib/desktop-rpc.ts";

// The active-profile slice reports the session-effective label the footer
// already shows (`sessionProfileLabel` over `resolveSessionProfile`, the single
// precedence rule) beside the global `active` name from the profiles store
// owner. The acceptance test that decides whether the method exists at all
// (S5): with a profile bound to the session, the response must differ from
// `get_config{store:"profiles"}.active` — the bare global name that store read
// reports. If it could not differ, this slice would be a decorative duplicate
// and must be deleted instead of delivered.

const FOLLOW_ENV = { GENTLE_PI_PROFILE_FOLLOW: "1" } as NodeJS.ProcessEnv;

const PROFILES_FIXTURE = {
	kind: "gentle-pi.agent_model_profiles",
	version: 1,
	active: "team",
	profiles: {
		team: { explore: { model: "anthropic/claude-team" } },
		solo: { explore: { model: "openai/gpt-solo" } },
	},
};

function tempHome(t: test.TestContext): { configHome: string; workspace: string } {
	const root = mkdtempSync(join(tmpdir(), "gp-desktop-profile-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const configHome = join(root, "config");
	const workspace = join(root, "workspace");
	mkdirSync(configHome, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	return { configHome, workspace };
}

function writeProfiles(configHome: string, file: unknown): void {
	writeFileSync(profilesFilePath(configHome), `${JSON.stringify(file)}\n`);
}

function input(configHome: string, workspace: string, overrides: Partial<DesktopActiveProfileInput> = {}): DesktopActiveProfileInput {
	return {
		sessionId: "s-1",
		cwd: workspace,
		configHome,
		env: FOLLOW_ENV,
		resolveWorktree: (): WorktreeIdentity => ({ root: workspace, commonDir: workspace }),
		...overrides,
	};
}

/** The whole outcome for one param-less read over one environment. */
function read(configHome: string, workspace: string, overrides: Partial<DesktopActiveProfileInput> = {}): Record<string, unknown> {
	const outcome: DesktopRpcOutcome | undefined = activeProfileOutcome({}, input(configHome, workspace, overrides));
	if (!outcome || !outcome.ok) throw new Error("expected a success outcome");
	return outcome.data;
}

function useConfigHome(t: test.TestContext, configHome: string): void {
	const previous = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	t.after(() => {
		if (previous === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previous;
	});
}

function resetBindings(t: test.TestContext): void {
	resetSessionProfileBindingsForTesting();
	t.after(() => resetSessionProfileBindingsForTesting());
}

function fileFingerprints(paths: string[]): string {
	return paths
		.filter((path) => { try { statSync(path); return true; } catch { return false; } })
		.map((path) => `${readFileSync(path, "utf8")}:${statSync(path, { bigint: true }).mtimeNs}`)
		.join("|");
}

// ---- Params: the method takes none, and rejection resolves nothing ----

test("malformed params answer invalid_request before any owner is read", (t) => {
	const { configHome, workspace } = tempHome(t);
	let resolves = 0;
	const rejecting = input(configHome, workspace, { resolveWorktree: () => { resolves += 1; return { root: workspace, commonDir: workspace }; } });
	for (const params of [{ store: "profiles" }, { label: "x" }, { a: 1 }]) {
		assert.deepEqual(activeProfileOutcome(params, rejecting), { ok: false, error: INVALID_PROFILE_PARAMS }, JSON.stringify(params));
	}
	assert.equal(resolves, 0, "a rejected request never resolves the worktree identity");
});

// ---- Unbound session: the bare global name, distinguishable from a binding ----

test("an unbound session answers the bare global name beside the global active name", (t) => {
	const { configHome, workspace } = tempHome(t);
	writeProfiles(configHome, PROFILES_FIXTURE);
	assert.deepEqual(read(configHome, workspace), { label: "team", active: "team" });
});

// ---- Truthful absence: no profile anywhere, or a stale active marker ----

test("no profile configured anywhere answers no label and no active", (t) => {
	const { configHome, workspace } = tempHome(t);
	assert.deepEqual(read(configHome, workspace), {}, "an absent store answers nothing");
	writeProfiles(configHome, { ...PROFILES_FIXTURE, active: undefined, profiles: {} });
	assert.deepEqual(read(configHome, workspace), {}, "a store without an active marker answers nothing");
	// The owner's own normalizer drops a stale `active` marker, so it reads as
	// absent — the same Truthful normalization `get_config` documents.
	writeProfiles(configHome, { ...PROFILES_FIXTURE, active: "ghost", profiles: {} });
	assert.deepEqual(read(configHome, workspace), {}, "a stale active marker answers nothing");
});

// ---- THE acceptance test (S5): bound label differs from the global active ----

test("with a profile bound to the session, the response differs from the global active name", (t) => {
	resetBindings(t);
	const { configHome, workspace } = tempHome(t);
	writeProfiles(configHome, PROFILES_FIXTURE);
	// get_config{store:"profiles"} reports this same bare global name; the
	// session-effective answer must be able to differ from it.
	bindSessionProfile("s-1", "solo", {});
	assert.deepEqual(read(configHome, workspace), { label: "solo (session)", active: "team" });
	assert.notEqual(read(configHome, workspace).label, read(configHome, workspace).active);
	// Even binding the same name stays distinguishable: the spelling carries the origin.
	bindSessionProfile("s-1", "team", {});
	assert.deepEqual(read(configHome, workspace), { label: "team (session)", active: "team" });
	assert.notEqual(read(configHome, workspace).label, read(configHome, workspace).active);
});

// ---- Parity with the footer: one session, one label, whichever channel asks ----

test("the desktop label is the label the footer's own reader shows for that session", (t) => {
	resetBindings(t);
	const { configHome, workspace } = tempHome(t);
	writeProfiles(configHome, PROFILES_FIXTURE);
	bindSessionProfile("s-1", "solo", {});
	// The footer's reader binds the same cwd, the same worktree resolver and the
	// same session id, and resolves through the same owner the projection uses.
	const footer = createActiveProfileReader({ GENTLE_PI_CONFIG_HOME: configHome, ...FOLLOW_ENV });
	footer.bind(workspace, () => ({ root: workspace, commonDir: workspace }), "s-1");
	footer.refresh();
	assert.equal(
		read(configHome, workspace).label,
		footer(),
		"the Desktop label must be the label the footer shows, not a parallel resolution",
	);
});

// ---- The exact footer spellings, through the real resolution owner ----

test("a local pin answers the (local) spelling and a repository declaration the (repo) spelling", (t) => {
	const { configHome, workspace } = tempHome(t);
	writeProfiles(configHome, PROFILES_FIXTURE);
	writeProfilePinSync(localProfilePinPath(workspace), "solo");
	assert.deepEqual(read(configHome, workspace), { label: "solo (local)", active: "team" });
	rmSync(localProfilePinPath(workspace), { force: true });
	writeProfilePinSync(repoProfileDeclarationPath(workspace), "solo");
	assert.deepEqual(read(configHome, workspace), { label: "solo (repo)", active: "team" });
});

// ---- Read-only: a read writes no store, no pin, no binding ----

test("a read changes no file and no binding", (t) => {
	resetBindings(t);
	const { configHome, workspace } = tempHome(t);
	writeProfiles(configHome, PROFILES_FIXTURE);
	writeProfilePinSync(localProfilePinPath(workspace), "solo");
	bindSessionProfile("s-1", "solo", {});
	const before = fileFingerprints([profilesFilePath(configHome), localProfilePinPath(workspace)]);
	const bindingBefore = readSessionProfileBinding("s-1");
	for (let index = 0; index < 3; index += 1) assert.equal(activeProfileOutcome({}, input(configHome, workspace)).ok, true);
	assert.equal(fileFingerprints([profilesFilePath(configHome), localProfilePinPath(workspace)]), before, "no store or pin byte or mtime moved");
	assert.deepEqual(readSessionProfileBinding("s-1"), bindingBefore, "the binding store is untouched");
});

// ---- The bridge: session context comes from the host, absence is typed ----

test("the bridge answers profile_unavailable without a host, passes other methods through, and reset drops the host", (t) => {
	const { workspace } = tempHome(t);
	const unavailable = { ok: false, error: PROFILE_UNAVAILABLE };
	const bridge = new DesktopProfileBridge(() => { throw new Error("must not resolve"); });
	assert.deepEqual(bridge.handle("get_active_profile", {}), unavailable);
	bridge.attach({ cwd: workspace } as unknown as ExtensionContext);
	bridge.reset();
	assert.deepEqual(bridge.handle("get_active_profile", {}), unavailable, "a reset drops the host");
	assert.equal(bridge.handle("apply_profile", { profile: "team", mode: "session" }), undefined, "other methods are not this slice's");
});

test("the bridge reads the session's own cwd, session id and config home through the real owners", (t) => {
	resetBindings(t);
	const { configHome, workspace } = tempHome(t);
	useConfigHome(t, configHome);
	writeProfiles(configHome, PROFILES_FIXTURE);
	bindSessionProfile("s-1", "solo", {});
	const identity = () => ({ root: workspace, commonDir: workspace });
	const bridge = new DesktopProfileBridge(identity);
	bridge.attach({ cwd: workspace, sessionManager: { getSessionId: () => "s-1" } } as unknown as ExtensionContext);
	assert.deepEqual(bridge.handle("get_active_profile", {}), { ok: true, data: { label: "solo (session)", active: "team" } });
	const detached = new DesktopProfileBridge(identity);
	detached.attach({ cwd: workspace, sessionManager: { getSessionId: () => undefined } } as unknown as ExtensionContext);
	assert.deepEqual(detached.handle("get_active_profile", {}), { ok: true, data: { label: "team", active: "team" } }, "an unbound session id falls back to the bare global name");
});

// ---- The advertised array: exactly this slice's one method beside the core ----

test("the profile slice advertises exactly its one method beside the core methods", async () => {
	const lines: string[] = [];
	const router = new DesktopRpcRouter(["capabilities", "get_snapshot", ...DESKTOP_PROFILE_METHODS], [], undefined, () => undefined);
	router.start((line) => lines.push(line));
	await router.handle(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "caps", method: "capabilities", params: {} }));
	assert.deepEqual(JSON.parse(lines[0]!).data.methods, ["capabilities", "get_snapshot", ...DESKTOP_PROFILE_METHODS]);
});

test("get_active_profile answers through the real router and takes no params", async (t) => {
	resetBindings(t);
	const { configHome, workspace } = tempHome(t);
	useConfigHome(t, configHome);
	writeProfiles(configHome, PROFILES_FIXTURE);
	bindSessionProfile("s-1", "solo", {});
	const bridge = new DesktopProfileBridge(() => ({ root: workspace, commonDir: workspace }));
	bridge.attach({ cwd: workspace, sessionManager: { getSessionId: () => "s-1" } } as unknown as ExtensionContext);
	const lines: string[] = [];
	const router = new DesktopRpcRouter(["capabilities", "get_snapshot", ...DESKTOP_PROFILE_METHODS], [], undefined, (method, params) => bridge.handle(method, params));
	router.start((line) => lines.push(line));
	await router.handle(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "p-1", method: DESKTOP_PROFILE_METHOD, params: {} }));
	assert.deepEqual(JSON.parse(lines[0]!), {
		schema: DESKTOP_RPC_SCHEMA,
		kind: "response",
		requestId: "p-1",
		ok: true,
		data: { label: "solo (session)", active: "team" },
	});
	assert.equal(lines.length, 1, "the method has no event");
});
