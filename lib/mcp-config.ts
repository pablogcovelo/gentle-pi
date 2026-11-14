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
 * Configured server names, or an empty list when the file is absent,
 * unreadable or not the shape Pi itself loads. Total by design: the banner
 * renders a count on every start, and a rejection would leave it stale.
 */
export async function readMcpServerNames(agentDir?: string): Promise<string[]> {
	try {
		const raw = await readFile(mcpConfigPath(agentDir ?? getAgentDir()), "utf8");
		const config = JSON.parse(raw) as { mcpServers?: unknown } | null;
		const servers = config?.mcpServers ?? {};
		return Object.keys(servers as object);
	} catch {
		return [];
	}
}
