import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The single owner of the `<agentDir>/mcp.json` read (spec S4 of
 * odd/tasks/desktop-rpc-client-gaps.md). The startup banner counts these
 * servers and the Desktop RPC inventory names them; a second reader would
 * let the two disagree without anyone noticing.
 *
 * Only the configured server names cross this boundary. The file also holds
 * URLs, headers and environment expansions, and no caller needs them.
 */
export function mcpConfigPath(agentDir: string): string {
	return join(agentDir, "mcp.json");
}

/**
 * The file-read outcome of one `<agentDir>/mcp.json` read: `ok` is a readable
 * config (zero names when none are configured), `absent` is a missing file, and
 * `unusable` is a file that exists but cannot be read as the shape Pi loads
 * (unparsable JSON or a wrong-shaped `mcpServers`). This is the state of one
 * local JSON read — never a connection state; health is reported separately as
 * the frozen `unknown` literal.
 */
export interface McpServerNameRead {
	status: "ok" | "absent" | "unusable";
	names: string[];
}

/**
 * The same read as `readMcpServerNames`, but telling a missing file apart from
 * an unusable one (advisory R3-001 of T0): both answer zero names, so a caller
 * that must not render "no servers" for a broken config can see why.
 */
export async function readMcpServerNamesDetailed(agentDir?: string): Promise<McpServerNameRead> {
	let raw: string;
	try {
		raw = await readFile(mcpConfigPath(agentDir ?? getAgentDir()), "utf8");
	} catch (error) {
		const absent = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
		return { status: absent ? "absent" : "unusable", names: [] };
	}
	let config: unknown;
	try {
		config = JSON.parse(raw);
	} catch {
		return { status: "unusable", names: [] };
	}
	if (!config || typeof config !== "object" || Array.isArray(config)) return { status: "unusable", names: [] };
	const servers = (config as { mcpServers?: unknown }).mcpServers;
	if (servers === undefined) return { status: "ok", names: [] };
	if (servers === null || typeof servers !== "object") return { status: "unusable", names: [] };
	return { status: "ok", names: Object.keys(servers) };
}

/**
 * Configured server names, or an empty list when the file is absent,
 * unreadable or not the shape Pi itself loads. Total by design: the banner
 * renders a count on every start, and a rejection would leave it stale.
 */
export async function readMcpServerNames(agentDir?: string): Promise<string[]> {
	return (await readMcpServerNamesDetailed(agentDir)).names;
}
