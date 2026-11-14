import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DESKTOP_MCP_METHOD,
	DESKTOP_MCP_METHODS,
	DesktopMcpBridge,
	type DesktopMcpSources,
	INVALID_MCP_PARAMS,
	MCP_HEALTH_UNKNOWN,
	MCP_UNAVAILABLE,
	mcpNamespaces,
	mcpStatusOutcome,
} from "../lib/desktop-rpc-mcp.ts";
import { readMcpServerNames, readMcpServerNamesDetailed } from "../lib/mcp-config.ts";
import { DESKTOP_RPC_SCHEMA, DesktopRpcRouter, type DesktopRpcOutcome } from "../lib/desktop-rpc.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// The MCP slice is inventory only: names of configured servers, names of
// extension registrations, and namespaces derived from tool names. `health` is
// the frozen `unknown` literal — configured counts and getAllTools() are not
// connection health (docs/mcp-status.md), and pi 1.4.0 exposes no status API.
// Every test here proves reads only: no probe, no network call, no write.

function sources(overrides: Partial<DesktopMcpSources> = {}) {
	const counts = { configured: 0, registered: 0, toolNames: 0 };
	const base: DesktopMcpSources = {
		configured: async () => {
			counts.configured += 1;
			return { status: "ok" as const, names: ["docs", "jira"] };
		},
		registered: () => {
			counts.registered += 1;
			return ["jira"];
		},
		toolNames: () => {
			counts.toolNames += 1;
			return ["read_file", "mcp__docs__search", "mcp__jira__create_issue", "mcp__docs__list"];
		},
	};
	return { counts, deps: { ...base, ...overrides } };
}

function dataOf(outcome: DesktopRpcOutcome | undefined): Record<string, unknown> {
	if (!outcome || !outcome.ok) throw new Error("expected a success outcome");
	return outcome.data;
}

function agentDir(t: { after(fn: () => void): void }, contents?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "gp-desktop-mcp-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	if (contents !== undefined) writeFileSync(join(dir, "mcp.json"), contents);
	return dir;
}

function fakePi(overrides: Partial<Record<"getMcpServers" | "getAllTools" | "registerMcpServer" | "unregisterMcpServer", unknown>> = {}) {
	const calls: Record<string, number> = { getMcpServers: 0, getAllTools: 0, registerMcpServer: 0, unregisterMcpServer: 0 };
	return {
		calls,
		pi: {
			getMcpServers: () => {
				calls.getMcpServers += 1;
				return [
					{ name: "jira", config: { url: "https://secret-endpoint.invalid/mcp", headers: { Authorization: "Bearer bearer-secret" } }, extensionPath: "/ext/jira.js" },
					{ name: "linear", config: { command: "linear-mcp", env: { LINEAR_TOKEN: "token-secret" } }, extensionPath: "/ext/linear.js" },
				];
			},
			getAllTools: () => {
				calls.getAllTools += 1;
				return [
					{ name: "read_file" },
					{ name: "mcp__docs__search", parameters: { properties: { query: { type: "string" } } } },
					{ name: "mcp__linear__create_issue" },
					{ name: "mcp__docs__list" },
				];
			},
			registerMcpServer: () => {
				calls.registerMcpServer += 1;
			},
			unregisterMcpServer: () => {
				calls.unregisterMcpServer += 1;
			},
			...overrides,
		} as unknown as Pick<ExtensionAPI, "getMcpServers" | "getAllTools">,
	};
}

// ---- Params: the method takes none, and rejection reads no owner ----

test("malformed params answer invalid_request before any owner is read", async () => {
	const { counts, deps } = sources({ configured: () => { throw new Error("must not read"); } });
	for (const params of [{ root: "/x" }, { a: 1 }, { health: "ready" }]) {
		assert.deepEqual(await mcpStatusOutcome(params, deps), { ok: false, error: INVALID_MCP_PARAMS });
	}
	assert.deepEqual(counts, { configured: 0, registered: 0, toolNames: 0 });
});

// ---- The inventory: three name lists, one frozen health literal ----

test("the inventory reports configured, registered and namespace names beside the frozen health", async () => {
	const { deps } = sources();
	assert.deepEqual(await mcpStatusOutcome({}, deps), {
		ok: true,
		data: {
			health: MCP_HEALTH_UNKNOWN,
			configured: { status: "ok", names: ["docs", "jira"] },
			registered: ["jira"],
			namespaces: ["docs", "jira"],
		},
	});
});

test("namespaces come from mcp__<server>__<tool> tool names, unique and in first-seen order", () => {
	assert.deepEqual(
		mcpNamespaces(["read_file", "mcp__docs__search", "mcp__linear__create_issue", "mcp__docs__list", "mcp__lonely", "mcp__"]),
		["docs", "linear"],
	);
});

// ---- The absent/unusable distinction (R3-001): surfaced, never flattened ----

test("an absent mcp.json reads as absent, and the total reader keeps answering []", async (t) => {
	const dir = agentDir(t);
	assert.deepEqual(await readMcpServerNamesDetailed(dir), { status: "absent", names: [] });
	assert.deepEqual(await readMcpServerNames(dir), []);
});

test("an unparsable or wrong-shaped mcp.json reads as unusable, not as an empty ok", async (t) => {
	for (const contents of ["{ not json", JSON.stringify(["docs"]), JSON.stringify({ mcpServers: "docs" }), JSON.stringify({ mcpServers: null })]) {
		const dir = agentDir(t, contents);
		assert.deepEqual(await readMcpServerNamesDetailed(dir), { status: "unusable", names: [] }, contents);
		assert.deepEqual(await readMcpServerNames(dir), []);
	}
});

test("a readable file with no servers is ok with zero names, and the total reader keeps its legacy shapes", async (t) => {
	assert.deepEqual(await readMcpServerNamesDetailed(agentDir(t, JSON.stringify({ theme: "dark" }))), { status: "ok", names: [] });
	assert.deepEqual(await readMcpServerNamesDetailed(agentDir(t, JSON.stringify({ mcpServers: { docs: { url: "https://x" }, jira: {} } }))), { status: "ok", names: ["docs", "jira"] });
	assert.deepEqual(await readMcpServerNames(agentDir(t, JSON.stringify({ mcpServers: ["one", "two"] }))), ["0", "1"]);
});

test("the outcome surfaces the distinction instead of flattening it", async () => {
	const { deps } = sources({ configured: async () => ({ status: "absent" as const, names: [] }) });
	assert.deepEqual(dataOf(await mcpStatusOutcome({}, deps)), {
		health: MCP_HEALTH_UNKNOWN,
		configured: { status: "absent", names: [] },
		registered: ["jira"],
		namespaces: ["docs", "jira"],
	});
});

// ---- Honesty: no leak, health never implies a connection state ----

test("no URL, header, token, environment value, tool argument or raw error crosses the answer", async () => {
	// The registration configs below carry the secrets; only their names cross.
	const { deps } = sources({ registered: () => ["jira", "linear"], toolNames: () => ["read_file", "mcp__docs__search", "mcp__linear__create_issue"] });
	const data = dataOf(await mcpStatusOutcome({}, deps));
	const rendered = JSON.stringify(data);
	for (const secret of ["secret-endpoint", "bearer-secret", "token-secret", "Authorization", "query", "extensionPath"]) {
		assert.ok(!rendered.includes(secret), `leaked: ${secret}`);
	}
	assert.deepEqual(data, {
		health: MCP_HEALTH_UNKNOWN,
		configured: { status: "ok", names: ["docs", "jira"] },
		registered: ["jira", "linear"],
		namespaces: ["docs", "linear"],
	});
});

test("health is the frozen unknown for every inventory, present servers or not", async () => {
	const { deps } = sources();
	assert.equal(dataOf(await mcpStatusOutcome({}, deps)).health, MCP_HEALTH_UNKNOWN);
	assert.equal(MCP_HEALTH_UNKNOWN, "unknown");
});

// ---- The read-only proof: only reads happen, nothing is registered or written ----

test("the inventory only reads: no write, no register, no unregister, no network", async (t) => {
	const contents = JSON.stringify({ mcpServers: { docs: { url: "https://secret-endpoint.invalid/mcp" } } });
	const dir = agentDir(t, contents);
	// The bridge reads through the shared reader's default agent dir, so the
	// isolated proof pins PI_CODING_AGENT_DIR to the disposable directory.
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	const before = readdirSync(dir).map((name) => ({ name, body: readFileSync(join(dir, name), "utf8") }));
	const { pi, calls } = fakePi();
	const bridge = new DesktopMcpBridge(readMcpServerNamesDetailed, pi);
	bridge.attach({ cwd: dir } as unknown as ExtensionContext);
	const data = dataOf(await bridge.handle(DESKTOP_MCP_METHOD, {}));
	assert.deepEqual(calls, { getMcpServers: 1, getAllTools: 1, registerMcpServer: 0, unregisterMcpServer: 0 });
	const after = readdirSync(dir).map((name) => ({ name, body: readFileSync(join(dir, name), "utf8") }));
	assert.deepEqual(after, before);
	assert.deepEqual(data.configured, { status: "ok", names: ["docs"] });
});

// ---- The bridge: session gate, single method, real-router answer ----

test("the bridge answers unavailable without a session and handles only its own method", async () => {
	const { pi } = fakePi();
	const bridge = new DesktopMcpBridge(readMcpServerNamesDetailed, pi);
	assert.equal(await bridge.handle("get_config", {}), undefined);
	assert.deepEqual(await bridge.handle(DESKTOP_MCP_METHOD, {}), { ok: false, error: MCP_UNAVAILABLE });
	bridge.attach({ cwd: "/repo" } as unknown as ExtensionContext);
	dataOf(await bridge.handle(DESKTOP_MCP_METHOD, {}));
	bridge.reset();
	assert.deepEqual(await bridge.handle(DESKTOP_MCP_METHOD, {}), { ok: false, error: MCP_UNAVAILABLE });
});

test("the MCP slice advertises exactly its one method beside the core methods", async () => {
	const lines: string[] = [];
	const router = new DesktopRpcRouter(["capabilities", "get_snapshot", ...DESKTOP_MCP_METHODS], [], undefined, () => undefined);
	router.start((line) => lines.push(line));
	await router.handle(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "caps", method: "capabilities", params: {} }));
	assert.deepEqual(JSON.parse(lines[0]!).data.methods, ["capabilities", "get_snapshot", ...DESKTOP_MCP_METHODS]);
});

test("mcp_status answers through the real router with the frozen health", async () => {
	const { deps } = sources();
	const lines: string[] = [];
	const router = new DesktopRpcRouter(["capabilities", "get_snapshot", ...DESKTOP_MCP_METHODS], [], undefined, (method, params) => mcpStatusOutcome(method === DESKTOP_MCP_METHOD ? params : {}, deps));
	router.start((line) => lines.push(line));
	await router.handle(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "mcp-1", method: DESKTOP_MCP_METHOD, params: {} }));
	assert.deepEqual(JSON.parse(lines[0]!), {
		schema: DESKTOP_RPC_SCHEMA,
		kind: "response",
		requestId: "mcp-1",
		ok: true,
		data: { health: MCP_HEALTH_UNKNOWN, configured: { status: "ok", names: ["docs", "jira"] }, registered: ["jira"], namespaces: ["docs", "jira"] },
	});
	assert.equal(lines.length, 1);
});

test("a tool name that itself contains a double underscore keeps its server namespace", () => {
	// pi's own parser is non-greedy (`/^mcp__(.+?)__(.+)$/`); a greedy split
	// would answer "srv__get" here and hand the client a namespace pi never made.
	assert.deepEqual(mcpNamespaces(["mcp__srv__get__thing", "mcp__srv__other"]), ["srv"]);
});
