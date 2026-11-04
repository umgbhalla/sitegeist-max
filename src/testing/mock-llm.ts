// Deterministic in-process fake LLM for e2e UI verification.
//
// Bundled always but INERT unless the build sets SITEGEIST_E2E=1 (see
// scripts/build.mjs define + `npm run build:e2e`). When active, createAgent()
// in sidepanel.ts swaps the real streamFn/getApiKey for the mocks below, so the
// whole UI (chat shell + workflow progress panel + spawned sub-agents) can be
// driven with ZERO real network calls.
//
// Scripted turns come from the `?mockresponses=` URL param on sidepanel.html:
//   JSON array, FIFO, one entry consumed per streamFn call (incl. each sub-agent).
//   entry = { "text": "..." }  |  { "tool": { "name": "...", "args": {...} } }
//   Either may carry "thinking": "..." (a reasoning block before the text or call)
//   and "delayMs" (time before the turn finishes, for live-run views).
// Queue-empty falls back to a fixed stop turn so every agent always terminates.

import type { AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export const isE2E = () => process.env.SITEGEIST_E2E === "1";

type MockTurn = {
	text?: string;
	tool?: { name: string; args?: Record<string, unknown> };
	thinking?: string;
	delayMs?: number;
};

let callCounter = 0;

let queue: MockTurn[] | null = null;
function plan(): MockTurn[] {
	try {
		const raw = new URLSearchParams(location.search).get("mockresponses");
		if (!raw) return [];
		const parsed = JSON.parse(decodeURIComponent(raw));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

// Plausible per-turn numbers so run footers show real-looking totals.
const usage = () => ({
	input: 2400,
	output: 120,
	cacheRead: 18000,
	cacheWrite: 0,
	totalTokens: 20520,
	cost: { input: 0.006, output: 0.0018, cacheRead: 0.0045, cacheWrite: 0, total: 0.0123 },
});

// Fresh AssistantMessage so intermediate `partial` snapshots never share a
// mutated content array with the final `done.message`.
function msg(
	model: Model<any>,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: (model as any).api,
		provider: (model as any).provider,
		model: (model as any).id,
		usage: usage(),
		stopReason,
		timestamp: Date.now(),
	};
}

export const mockStreamFn = ((model: Model<any>) => {
	if (!queue) queue = plan();
	const turn: MockTurn = queue.shift() ?? { text: "[mock] done" };
	const stream = createAssistantMessageEventStream();

	const thinking: AssistantMessage["content"] = turn.thinking ? [{ type: "thinking", thinking: turn.thinking }] : [];
	const offset = thinking.length;
	const emit = () => {
		stream.push({ type: "start", partial: msg(model, thinking, "stop") });
		if (turn.tool) {
			const toolCall: ToolCall = {
				type: "toolCall",
				id: `mock-tool-${++callCounter}`,
				name: turn.tool.name,
				arguments: turn.tool.args ?? {},
			};
			const content = [...thinking, toolCall];
			stream.push({ type: "toolcall_start", contentIndex: offset, partial: msg(model, content, "toolUse") });
			stream.push({ type: "toolcall_end", contentIndex: offset, toolCall, partial: msg(model, content, "toolUse") });
			stream.push({ type: "done", reason: "toolUse", message: msg(model, content, "toolUse") });
			return;
		}
		const text = String(turn.text ?? "[mock] done");
		stream.push({
			type: "text_start",
			contentIndex: offset,
			partial: msg(model, [...thinking, { type: "text", text: "" }], "stop"),
		});
		let acc = "";
		for (const chunk of text.match(/[\s\S]{1,8}/g) ?? [text]) {
			acc += chunk;
			stream.push({
				type: "text_delta",
				contentIndex: offset,
				delta: chunk,
				partial: msg(model, [...thinking, { type: "text", text: acc }], "stop"),
			});
		}
		const content = [...thinking, { type: "text" as const, text }];
		stream.push({ type: "text_end", contentIndex: offset, content: text, partial: msg(model, content, "stop") });
		stream.push({ type: "done", reason: "stop", message: msg(model, content, "stop") });
	};
	// Synchronous push is fine: EventStream queues events until the agent drains
	// them. Each event carries its OWN snapshot of `partial`.
	if (turn.delayMs) setTimeout(emit, turn.delayMs);
	else emit();

	return stream;
	// Cast: matches the StreamFunction generic shape expected by Agent.streamFn.
}) as any;

export const mockGetApiKey = async (): Promise<string> => "mock-key";
