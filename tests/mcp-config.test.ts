import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMcpServerNames } from "../lib/mcp-config.ts";

// T0 of odd/tasks/desktop-rpc-client-gaps.md pins one invariant: the
// <agentDir>/mcp.json read has exactly one owner. A second reader would let
// the startup banner and the Desktop footer disagree without anyone noticing.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// One line is enough: the read builds a join(...) ending in mcp.json.
const MCP_PATH_CALL = /join\([^;\n]*["']mcp\.json["']/;
const BANNER_READER_IMPORT = /import\s*\{[^}]*\breadMcpServerNames\b[^}]*\}\s*from\s*["']\.\.\/lib\/mcp-config\.ts["']/;

/** Every shipped TypeScript module under lib/ and extensions/. */
function sourceFiles(): string[] {
	const files: string[] = [];
	const walk = (path: string) => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) walk(child);
			else if (entry.name.endsWith(".ts")) files.push(child);
		}
	};
	for (const dir of ["lib", "extensions"]) walk(join(repoRoot, dir));
	return files;
}

function agentDir(t: { after(fn: () => void): void }, contents?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "gp-mcp-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	if (contents !== undefined) writeFileSync(join(dir, "mcp.json"), contents);
	return dir;
}

test("the agent dir mcp.json path is built in exactly one module", () => {
	const builders = sourceFiles()
		.filter((file) => MCP_PATH_CALL.test(readFileSync(file, "utf8")))
		.map((file) => file.slice(repoRoot.length).split("\\").join("/").replace(/^\//, ""));
	assert.deepEqual(builders, ["lib/mcp-config.ts"], "exactly one module may build the mcp.json path");
});

test("the startup banner consumes the shared reader instead of reading mcp.json itself", () => {
	const source = readFileSync(join(repoRoot, "extensions", "startup-banner.ts"), "utf8");
	const buildsPath = MCP_PATH_CALL.test(source);
	assert.equal(buildsPath, false, "the banner must not build the mcp.json path itself");
	const usesReader = BANNER_READER_IMPORT.test(source);
	assert.equal(usesReader, true, "the banner must import readMcpServerNames from the shared reader");
});

test("configured servers are reported in file order", async (t) => {
	const dir = agentDir(t, JSON.stringify({ mcpServers: { docs: { url: "https://x" }, jira: {} } }));
	assert.deepEqual(await readMcpServerNames(dir), ["docs", "jira"]);
});

test("an absent mcp.json reports no servers instead of throwing", async (t) => {
	assert.deepEqual(await readMcpServerNames(agentDir(t)), []);
});

test("an unparsable mcp.json reports no servers instead of throwing", async (t) => {
	assert.deepEqual(await readMcpServerNames(agentDir(t, "{ not json")), []);
});

test("a document without mcpServers reports no servers", async (t) => {
	const dir = agentDir(t, JSON.stringify({ theme: "dark" }));
	assert.deepEqual(await readMcpServerNames(dir), []);
});

test("server names never carry the configured transport details", async (t) => {
	const dir = agentDir(t, JSON.stringify({
		mcpServers: { docs: { url: "https://user:secret@example.test/mcp", headers: { Authorization: "Bearer token" } } },
	}));
	assert.deepEqual(await readMcpServerNames(dir), ["docs"]);
});

test("the default agent dir follows PI_CODING_AGENT_DIR", async (t) => {
	const dir = agentDir(t, JSON.stringify({ mcpServers: { local: {} } }));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	assert.deepEqual(await readMcpServerNames(), ["local"]);
});

test("a non-object mcpServers keeps the legacy banner count", async (t) => {
	// The banner counted Object.keys(cfg.mcpServers) and still must: an array
	// of two entries reads as two configured servers before and after T0.
	const dir = agentDir(t, JSON.stringify({ mcpServers: ["one", "two"] }));
	assert.deepEqual(await readMcpServerNames(dir), ["0", "1"]);
});
