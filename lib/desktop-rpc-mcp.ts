// Gentle Desktop MCP inventory slice: names only, through the existing owners.
//
// Nothing here connects, probes, or mutates (spec S8). Configured server names
// come from the single `<agentDir>/mcp.json` reader (`lib/mcp-config.ts`, the
// one the startup banner consumes), extension registrations from
// `pi.getMcpServers()`, and tool namespaces from the `mcp__<server>__<tool>`
// names `pi.getAllTools()` already exposes. `health` is the frozen `unknown`
// literal: the pi builds this repository resolves expose no status API, and
// configured counts and getAllTools() are not connection health
// (docs/mcp-status.md). No server URL, header, token, environment value, tool
// argument or raw error crosses this module — names only.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import type { McpServerNameRead } from "./mcp-config.ts";

export const DESKTOP_MCP_METHODS = ["mcp_status"] as const;
export const DESKTOP_MCP_METHOD = DESKTOP_MCP_METHODS[0];

export const INVALID_MCP_PARAMS = { code: "invalid_request", message: "Invalid mcp_status parameters" } as const;
export const MCP_UNAVAILABLE = { code: "mcp_unavailable", message: "MCP inventory unavailable for this session" } as const;

/**
 * The only health value this contract reports. It is the frozen literal — not
 * a guess, not a per-server state — because inventory is not connection health.
 */
export const MCP_HEALTH_UNKNOWN = "unknown" as const;

/** `mcp_status` takes no params; anything else is a typed `invalid_request`
 * before any owner is read. */
export function invalidMcpParams(params: Record<string, unknown>): boolean {
	return Object.keys(params).length !== 0;
}

// The same non-greedy split pi's own MCP extension uses to derive a namespace
// (`dist/extensions/mcp/index.js`), so a tool whose own name contains `__` still
// resolves to its server instead of swallowing part of the tool name.
const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;

/**
 * The server namespace of one `mcp__<server>__<tool>` tool name — the spelling
 * the shipped MCP extension produces — or undefined for any other tool name.
 */
export function mcpToolNamespace(name: string): string | undefined {
	return MCP_TOOL_NAME.exec(name)?.[1];
}

/** Unique namespaces in first-seen tool order. */
export function mcpNamespaces(toolNames: readonly string[]): string[] {
	const namespaces: string[] = [];
	for (const name of toolNames) {
		const namespace = mcpToolNamespace(name);
		if (namespace !== undefined && !namespaces.includes(namespace)) namespaces.push(namespace);
	}
	return namespaces;
}

/**
 * The three owners `mcp_status` reads, injected for testability. Each answers
 * names only: the configured reader's own `{ status, names }` (its `status` is
 * the mcp.json file-read outcome — ok/absent/unusable, never connectivity),
 * the names of servers registered by extensions, and every configured tool
 * name for namespace derivation.
 */
export interface DesktopMcpSources {
	configured(): Promise<McpServerNameRead>;
	registered(): string[];
	toolNames(): string[];
}

/** One `mcp_status` request: the three name lists beside the frozen health. */
export async function mcpStatusOutcome(params: Record<string, unknown>, sources: DesktopMcpSources): Promise<DesktopRpcOutcome> {
	if (invalidMcpParams(params)) return { ok: false, error: INVALID_MCP_PARAMS };
	const configured = await sources.configured();
	return {
		ok: true,
		data: {
			health: MCP_HEALTH_UNKNOWN,
			configured: { status: configured.status, names: configured.names },
			registered: sources.registered(),
			namespaces: mcpNamespaces(sources.toolNames()),
		},
	};
}

/**
 * The Desktop domain slice for `mcp_status`. Configured names come from the
 * caller-provided single reader (the banner's own `lib/mcp-config.ts` read) and
 * registration and tool names from the session's real `pi` accessors — getters
 * only, so the slice can never register, unregister or connect anything.
 */
export class DesktopMcpBridge {
	private host: ExtensionContext | undefined;
	private readonly readConfigured: (agentDir?: string) => Promise<McpServerNameRead>;
	private readonly pi: Pick<ExtensionAPI, "getMcpServers" | "getAllTools">;

	constructor(readConfigured: (agentDir?: string) => Promise<McpServerNameRead>, pi: Pick<ExtensionAPI, "getMcpServers" | "getAllTools">) {
		this.readConfigured = readConfigured;
		this.pi = pi;
	}

	attach(context: ExtensionContext): void { this.host = context; }

	reset(): void { this.host = undefined; }

	handle(method: string, params: Record<string, unknown>): Promise<DesktopRpcOutcome | undefined> {
		if (method !== DESKTOP_MCP_METHOD) return Promise.resolve(undefined);
		if (!this.host) return Promise.resolve({ ok: false, error: MCP_UNAVAILABLE });
		return mcpStatusOutcome(params, {
			configured: () => this.readConfigured(),
			registered: () => this.pi.getMcpServers().map((server) => server.name),
			toolNames: () => this.pi.getAllTools().map((tool) => tool.name),
		});
	}
}
