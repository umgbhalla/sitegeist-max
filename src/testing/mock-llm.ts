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
// Queue-empty falls back to a fixed stop turn so every agent always terminates.

import type { AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export const isE2E = () => process.env.SITEGEIST_E2E === "1";

type MockTurn = { text?: string; tool?: { name: string; args?: Record<string, unknown> } };

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

const usage = () => ({
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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
		timestamp: 0,
	};
}

export const mockStreamFn = ((model: Model<any>) => {
	if (!queue) queue = plan();
	const turn: MockTurn = queue.shift() ?? { text: "[mock] done" };
	const stream = createAssistantMessageEventStream();

	// Synchronous push is fine: EventStream queues events until the agent drains
	// them. Each event carries its OWN snapshot of `partial`.
	stream.push({ type: "start", partial: msg(model, [], "stop") });

	if (turn.tool) {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "mock-tool-1",
			name: turn.tool.name,
			arguments: turn.tool.args ?? {},
		};
		stream.push({ type: "toolcall_start", contentIndex: 0, partial: msg(model, [toolCall], "toolUse") });
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: msg(model, [toolCall], "toolUse") });
		stream.push({ type: "done", reason: "toolUse", message: msg(model, [toolCall], "toolUse") });
	} else {
		const text = String(turn.text ?? "[mock] done");
		stream.push({ type: "text_start", contentIndex: 0, partial: msg(model, [{ type: "text", text: "" }], "stop") });
		let acc = "";
		for (const chunk of text.match(/[\s\S]{1,8}/g) ?? [text]) {
			acc += chunk;
			stream.push({
				type: "text_delta",
				contentIndex: 0,
				delta: chunk,
				partial: msg(model, [{ type: "text", text: acc }], "stop"),
			});
		}
		stream.push({
			type: "text_end",
			contentIndex: 0,
			content: text,
			partial: msg(model, [{ type: "text", text }], "stop"),
		});
		stream.push({ type: "done", reason: "stop", message: msg(model, [{ type: "text", text }], "stop") });
	}

	return stream;
	// Cast: matches the StreamFunction generic shape expected by Agent.streamFn.
}) as any;

export const mockGetApiKey = async (): Promise<string> => "mock-key";
