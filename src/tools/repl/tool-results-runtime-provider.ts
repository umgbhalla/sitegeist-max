import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SandboxRuntimeProvider } from "@earendil-works/pi-web-ui";

type ToolResultSnapshot = {
	id: string;
	toolCallId: string;
	toolName: string;
	index: number;
	isError: boolean;
	contentText: string;
	content: unknown;
	details: unknown;
};

type AgentLike = {
	state: { messages: AgentMessage[] };
};

function contentToText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item) {
				return String(item.text);
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

export class ToolResultsRuntimeProvider implements SandboxRuntimeProvider {
	constructor(private agent: AgentLike) {}

	getData(): Record<string, unknown> {
		const toolResults: ToolResultSnapshot[] = this.agent.state.messages
			.filter((message) => message.role === "toolResult")
			.map((message, index) => {
				const toolResult = message as AgentMessage & {
					toolCallId?: string;
					toolName?: string;
					isError?: boolean;
					content?: unknown;
					details?: unknown;
				};
				const toolCallId = toolResult.toolCallId || `tool-result-${index}`;
				const toolName = toolResult.toolName || "unknown";
				return {
					id: toolCallId,
					toolCallId,
					toolName,
					index,
					isError: Boolean(toolResult.isError),
					contentText: contentToText(toolResult.content),
					content: toolResult.content,
					details: toolResult.details,
				};
			});

		return { toolResults };
	}

	getRuntime(): (sandboxId: string) => void {
		return (_sandboxId: string) => {
			const clone = (value: unknown) => {
				if (typeof structuredClone === "function") return structuredClone(value);
				return JSON.parse(JSON.stringify(value));
			};

			const results = () => ((window as any).toolResults || []) as any[];

			(window as any).listToolResults = () =>
				results().map(({ id, toolCallId, toolName, index, isError, contentText, details }) => ({
					id,
					toolCallId,
					toolName,
					index,
					isError,
					contentText,
					hasDetails: details !== undefined,
				}));

			(window as any).getToolResult = (idOrIndex: string | number) => {
				const match =
					typeof idOrIndex === "number"
						? results().find((result) => result.index === idOrIndex)
						: results().find((result) => result.id === idOrIndex || result.toolCallId === idOrIndex);
				if (!match) throw new Error(`Tool result not found: ${idOrIndex}`);
				return clone(match);
			};

			(window as any).getToolResults = (toolName?: string) => {
				const matches = toolName ? results().filter((result) => result.toolName === toolName) : results();
				return clone(matches);
			};

			(window as any).getLastToolResult = (toolName?: string) => {
				const matches = toolName ? results().filter((result) => result.toolName === toolName) : results();
				const match = matches[matches.length - 1];
				if (!match) throw new Error(toolName ? `No tool result found for ${toolName}` : "No tool results found");
				return clone(match);
			};
		};
	}

	getDescription(): string {
		return `
### Tool Results

Read structured output from previous tool calls and compose it with normal JavaScript.

Functions:
- listToolResults() lists prior tool results with id, toolName, index, isError, contentText, and hasDetails
- getToolResult(idOrIndex) gets one full tool result by tool call id or result index
- getToolResults(toolName?) gets all full tool results, optionally filtered by tool name
- getLastToolResult(toolName?) gets the latest full tool result, optionally filtered by tool name

Example:
const tabs = getLastToolResult("navigate").details.tabs;
const docsTabs = tabs.filter((tab) => tab.url.includes("docs"));
console.log(docsTabs);
`;
	}
}
