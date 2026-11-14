// Gentle Desktop tool-vocabulary slice: `tool_vocabulary` publishes the native
// action classification as data, straight from lib/tool-vocabulary.ts — the
// same single projection the quiet-tools, gentle-agents and gentle-ai render
// modules consume. There is no second classification and no render module
// behind the published payload: the bridge holds no host and no state, it is a
// pure read of the vocabulary owner.

import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import { classifyTool, TOOL_VOCABULARY, TOOL_VOCABULARY_CATEGORIES, type ToolVocabularyEntry } from "./tool-vocabulary.ts";

export const DESKTOP_TOOLS_METHODS = ["tool_vocabulary"] as const;
export const DESKTOP_TOOLS_METHOD = DESKTOP_TOOLS_METHODS[0];

export const INVALID_TOOLS_PARAMS = { code: "invalid_request", message: "Invalid tool_vocabulary parameters" } as const;

const MAX_TOOL_NAME_LENGTH = 256;

/** `tool_vocabulary` takes no params besides the optional `tool` name; anything else is a typed `invalid_request` before anything is read. */
export function invalidToolsParams(params: Record<string, unknown>): boolean {
	for (const key of Object.keys(params)) {
		if (key !== "tool") return true;
	}
	const tool = params.tool;
	return tool !== undefined && (typeof tool !== "string" || tool.length === 0 || tool.length > MAX_TOOL_NAME_LENGTH);
}

function publishedEntry(entry: ToolVocabularyEntry): Record<string, unknown> {
	return {
		category: entry.category,
		glyph: entry.glyph,
		...(entry.tools ? { tools: [...entry.tools] } : {}),
		...(entry.patterns ? { patterns: [...entry.patterns] } : {}),
		...(entry.heading ? { heading: entry.heading } : {}),
	};
}

/** One `tool_vocabulary` request. Without `tool` the whole vocabulary is published; with it, one classification — an unknown name answers `matched: false`, never an invented family. */
export function toolVocabularyOutcome(params: Record<string, unknown>): DesktopRpcOutcome {
	if (invalidToolsParams(params)) return { ok: false, error: INVALID_TOOLS_PARAMS };
	const tool = params.tool;
	if (typeof tool === "string") {
		const entry = classifyTool(tool);
		return {
			ok: true,
			data: entry
				? { tool, matched: true, category: entry.category, glyph: entry.glyph, ...(entry.heading ? { heading: entry.heading } : {}) }
				: { tool, matched: false },
		};
	}
	return { ok: true, data: { categories: [...TOOL_VOCABULARY_CATEGORIES], entries: TOOL_VOCABULARY.map(publishedEntry) } };
}

/** The Desktop domain slice for `tool_vocabulary`: a pure data read with no host to attach and no state to reset. */
export class DesktopToolsBridge {
	handle(method: string, params: Record<string, unknown>): DesktopRpcOutcome | undefined {
		if (method !== DESKTOP_TOOLS_METHOD) return undefined;
		return toolVocabularyOutcome(params);
	}
}
