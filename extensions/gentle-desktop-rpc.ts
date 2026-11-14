import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DESKTOP_RPC_COMMAND,
	DESKTOP_RPC_WIDGET,
	DesktopRpcRouter,
	type DesktopRpcDomain,
	type DesktopRpcPublish,
} from "../lib/desktop-rpc.ts";
import {
	DESKTOP_CONFIG_EVENTS,
	DESKTOP_CONFIG_METHODS,
	DesktopConfigBridge,
} from "../lib/desktop-rpc-config.ts";
import {
	DESKTOP_PERMISSION_EVENT,
	DESKTOP_PERMISSION_METHODS,
	DesktopPermissionBridge,
} from "../lib/desktop-rpc-permissions.ts";
import { DESKTOP_USAGE_EVENTS, DESKTOP_USAGE_METHODS } from "../lib/desktop-rpc-usage.ts";
import { DesktopUsageBridge } from "../lib/desktop-usage-service.ts";
import { DESKTOP_DESIGN_EVENTS, DESKTOP_DESIGN_METHODS } from "../lib/desktop-rpc-design.ts";
import { DesktopDesignBridge } from "../lib/desktop-design-service.ts";
import { DESKTOP_JOBS_EVENTS, DESKTOP_JOBS_METHODS } from "../lib/desktop-rpc-jobs.ts";
import { DesktopJobsBridge } from "../lib/desktop-jobs-service.ts";
import { DESKTOP_AGENTS_EVENTS, DESKTOP_AGENTS_METHODS } from "../lib/desktop-rpc-agents.ts";
import { DesktopAgentsBridge } from "../lib/desktop-agents-service.ts";
import { DESKTOP_PROFILES_EVENTS, DESKTOP_PROFILES_METHODS, DesktopProfilesBridge } from "../lib/desktop-rpc-profiles.ts";
import { DESKTOP_WORKTREE_METHODS, DesktopWorktreeBridge } from "../lib/desktop-rpc-worktree.ts";
import { DESKTOP_MCP_METHODS, DesktopMcpBridge } from "../lib/desktop-rpc-mcp.ts";
import { DESKTOP_PROFILE_METHODS, DesktopProfileBridge } from "../lib/desktop-rpc-profile.ts";
import { readMcpServerNamesDetailed } from "../lib/mcp-config.ts";
import { shellGitRunner } from "./gentle-shell.ts";
import { isInteractiveRpcHost } from "../lib/rpc-host.ts";

function publisher(ctx: ExtensionContext): DesktopRpcPublish {
	return (line) => {
		try {
			ctx.ui.setWidget(DESKTOP_RPC_WIDGET, [line]);
		} catch {
			throw new Error("Desktop RPC transport unavailable");
		}
	};
}

export default function desktopRpc(pi: ExtensionAPI) {
	// Permission control always delegates to the existing Gentle AI session owner;
	// config reads and writes delegate to the existing store owners; subscription
	// usage delegates to the existing usage owner; design canvas reads delegate
	// to the existing design owner; background jobs list/cancel delegate to the
	// existing parent-session job registry and monitor controller; subagents
	// list/cancel delegate to the existing parent-session TaskStore and
	// AgentRunner; profile applies delegate to the existing `/gentle:profiles`
	// owner and its own apply actions; the active-profile read resolves the
	// session-effective label through the same single session-profile precedence
	// rule and spelling the footer's reader applies, beside the global `active`
	// name from the profiles store owner; worktree changes delegate to the existing
	// Gentle Shell changes tracker through the same runner factory every shell
	// scan uses; MCP inventory reads the single mcp.json reader, extension
	// registrations and tool names. None has a store of its own.
	const permissions = new DesktopPermissionBridge(pi);
	const config = new DesktopConfigBridge();
	const usage = new DesktopUsageBridge(pi);
	const design = new DesktopDesignBridge(pi);
	const jobs = new DesktopJobsBridge(pi);
	const agents = new DesktopAgentsBridge(pi);
	const profiles = new DesktopProfilesBridge(pi);
	const worktree = new DesktopWorktreeBridge(shellGitRunner);
	const mcp = new DesktopMcpBridge(readMcpServerNamesDetailed, pi);
	const profile = new DesktopProfileBridge();
	const domain: DesktopRpcDomain = (method, params) => {
		// Config is the only synchronous bridge; permission, usage, design, jobs,
		// profiles, agents, mcp, profile, and worktree answers are awaited in
		// fall-through order, so an unknown method still resolves to the router's
		// `unsupported_method` instead of an early `undefined`.
		const configOutcome = config.handle(method, params);
		if (configOutcome !== undefined) return configOutcome;
		return (async () => {
			const permissionOutcome = await permissions.handle(method, params);
			if (permissionOutcome !== undefined) return permissionOutcome;
			const usageOutcome = await usage.handle(method, params);
			if (usageOutcome !== undefined) return usageOutcome;
			const designOutcome = await design.handle(method, params);
			if (designOutcome !== undefined) return designOutcome;
			const jobsOutcome = await jobs.handle(method, params);
			if (jobsOutcome !== undefined) return jobsOutcome;
			const profilesOutcome = await profiles.handle(method, params);
			if (profilesOutcome !== undefined) return profilesOutcome;
			const agentsOutcome = await agents.handle(method, params);
			if (agentsOutcome !== undefined) return agentsOutcome;
			const worktreeOutcome = await worktree.handle(method, params);
			if (worktreeOutcome !== undefined) return worktreeOutcome;
			const profileOutcome = await profile.handle(method, params);
			if (profileOutcome !== undefined) return profileOutcome;
			return mcp.handle(method, params);
		})();
	};
	const router = new DesktopRpcRouter(
		["capabilities", "get_snapshot", ...DESKTOP_CONFIG_METHODS, ...DESKTOP_PERMISSION_METHODS, ...DESKTOP_USAGE_METHODS, ...DESKTOP_DESIGN_METHODS, ...DESKTOP_JOBS_METHODS, ...DESKTOP_PROFILES_METHODS, ...DESKTOP_AGENTS_METHODS, ...DESKTOP_WORKTREE_METHODS, ...DESKTOP_MCP_METHODS, ...DESKTOP_PROFILE_METHODS],
		// Method order is the documented contract; keep the capabilities arrays in
		// `docs/desktop-rpc.md` and `tests/maintainer/desktop-rpc.maintest.ts` identical.
		[...DESKTOP_CONFIG_EVENTS, DESKTOP_PERMISSION_EVENT, ...DESKTOP_USAGE_EVENTS, ...DESKTOP_DESIGN_EVENTS, ...DESKTOP_JOBS_EVENTS, ...DESKTOP_PROFILES_EVENTS, ...DESKTOP_AGENTS_EVENTS],
		() => config.snapshotState(),
		domain,
	);

	pi.on("session_start", (_event, ctx) => {
		permissions.reset();
		config.reset();
		usage.reset();
		design.reset();
		jobs.reset();
		profiles.reset();
		agents.reset();
		mcp.reset();
		profile.reset();
		worktree.reset();
		router.stop();
		if (!isInteractiveRpcHost(ctx.mode)) return;
		design.attach(ctx);
		jobs.attach(ctx);
		agents.attach(ctx);
		router.start(publisher(ctx));
		// Header-driven usage snapshots (Claude's 5h/7d windows, Codex SSE
		// headers) become ordered `rate_limit` events through the router.
		usage.wire((event, data) => router.emit(event, data));
		// Agent-driven canvas transitions become ordered `design_canvas` events;
		// subscribe eagerly so canvas work that happens before any Desktop
		// request still reaches the app.
		design.wire((event, data) => router.emit(event, data));
		void design.start();
		// Agent-driven background-job registry changes become ordered `jobs_update`
		// events; subscribe eagerly so a job started or stopped before any Desktop
		// request still reaches the app.
		jobs.wire((event, data) => router.emit(event, data));
		void jobs.start();
		// Agent-driven TaskStore transitions become ordered `agents_update` events;
		// subscribe eagerly so a subagent started or settled before any Desktop
		// request still reaches the app.
		agents.wire((event, data) => router.emit(event, data));
		void agents.start();
	});

	pi.on("session_shutdown", () => {
		permissions.reset();
		config.reset();
		usage.reset();
		design.reset();
		jobs.reset();
		profiles.reset();
		agents.reset();
		profile.reset();
		worktree.reset();
		router.stop();
	});

	pi.registerCommand(DESKTOP_RPC_COMMAND, {
		description: "Handle a versioned Gentle Desktop RPC request",
		async handler(args, ctx) {
			if (!isInteractiveRpcHost(ctx.mode)) return;
			permissions.attach(ctx);
			config.attach(ctx);
			usage.attach(ctx);
			design.attach(ctx);
			jobs.attach(ctx);
			profiles.attach(ctx);
			agents.attach(ctx);
			mcp.attach(ctx);
			worktree.attach(ctx);
			profile.attach(ctx);
			await router.handle(args);
		},
	});
}
