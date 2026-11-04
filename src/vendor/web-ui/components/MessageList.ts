import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage as AssistantMessageType,
	ToolResultMessage as ToolResultMessageType,
} from "@earendil-works/pi-ai/compat";
import { html, LitElement, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { formatCost, formatUsage } from "../utils/format.js";
import { i18n } from "../utils/i18n.js";
import { renderMessage } from "./message-renderer-registry.js";

type Usage = NonNullable<AssistantMessageType["usage"]>;

/** Content parts that render as steps (thinking or tool calls) rather than prose. */
function stepParts(message: AssistantMessageType) {
	return message.content.filter(
		(part) =>
			part.type === "toolCall" ||
			(part.type === "thinking" && part.thinking.trim() !== "") ||
			(part.type === "text" && part.text.trim() !== ""),
	);
}
const isStep = (part: AssistantMessageType["content"][number] | undefined) =>
	part?.type === "toolCall" || part?.type === "thinking";

function addUsage(total: Usage, usage: Usage | undefined): Usage {
	if (!usage) return total;
	return {
		...total,
		input: total.input + usage.input,
		output: total.output + usage.output,
		cacheRead: total.cacheRead + usage.cacheRead,
		cacheWrite: total.cacheWrite + usage.cacheWrite,
		totalTokens: total.totalTokens + usage.totalTokens,
		cost: {
			...total.cost,
			input: total.cost.input + usage.cost.input,
			output: total.cost.output + usage.cost.output,
			cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
			cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
			total: total.cost.total + usage.cost.total,
		},
	};
}

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function formatDuration(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

/** Everything the agent did for one user message: consecutive assistant turns and their tool results. */
interface Run {
	key: string;
	messages: AssistantMessageType[];
	startedAt: number;
	endedAt: number;
	steps: number;
	usage: Usage;
}

export class MessageList extends LitElement {
	@property({ type: Array }) messages: AgentMessage[] = [];
	@property({ type: Array }) tools: AgentTool[] = [];
	@property({ type: Object }) pendingToolCalls?: ReadonlySet<string>;
	@property({ type: Boolean }) isStreaming: boolean = false;
	@property({ attribute: false }) onCostClick?: () => void;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	private buildRenderItems() {
		// Map tool results by call id for quick lookup
		const resultByCallId = new Map<string, ToolResultMessageType>();
		for (const message of this.messages) {
			if (message.role === "toolResult") {
				resultByCallId.set(message.toolCallId, message);
			}
		}

		const items: Array<{ key: string; template: TemplateResult }> = [];
		let index = 0;
		let run: Run | undefined;
		let lastUserAt = 0;
		const closeRun = () => {
			if (run) items.push({ key: run.key, template: this.renderRun(run, resultByCallId) });
			run = undefined;
		};
		for (const msg of this.messages) {
			// Skip artifact messages - they're for session persistence only, not UI display
			if (msg.role === "artifact") {
				continue;
			}
			if (msg.role === "toolResult") {
				if (run) run.endedAt = Math.max(run.endedAt, msg.timestamp ?? 0);
				continue;
			}
			if (msg.role === "assistant") {
				const amsg = msg as AssistantMessageType;
				const at = amsg.timestamp ?? 0;
				run ??= {
					key: `run:${index}`,
					messages: [],
					startedAt: lastUserAt || at,
					endedAt: at,
					steps: 0,
					usage: EMPTY_USAGE,
				};
				run.messages.push(amsg);
				run.endedAt = Math.max(run.endedAt, at);
				run.steps += amsg.content.filter((part) => part.type === "toolCall").length;
				run.usage = addUsage(run.usage, amsg.usage);
				index++;
				continue;
			}
			closeRun();

			// Try custom renderer first
			const customTemplate = renderMessage(msg);
			if (customTemplate) {
				items.push({ key: `msg:${index}`, template: customTemplate });
				index++;
				continue;
			}

			// Fall back to built-in renderers
			if (msg.role === "user" || msg.role === "user-with-attachments") {
				lastUserAt = (msg as { timestamp?: number }).timestamp ?? 0;
				items.push({
					key: `msg:${index}`,
					template: html`<user-message .message=${msg}></user-message>`,
				});
				index++;
			}
			// Skip unknown roles
		}
		closeRun();
		return items;
	}

	private renderRun(run: Run, resultByCallId: Map<string, ToolResultMessageType>) {
		const last = run.messages[run.messages.length - 1];
		// The final run of a streaming turn is still growing; its footer appears when it ends.
		let lastAssistant: AgentMessage | undefined;
		for (const message of this.messages) if (message.role === "assistant") lastAssistant = message;
		const live = this.isStreaming && last === lastAssistant;
		const summary = [
			i18n("Worked for {duration}").replace("{duration}", formatDuration(run.endedAt - run.startedAt)),
			run.steps > 0 ? (run.steps === 1 ? i18n("1 step") : i18n("{count} steps").replace("{count}", String(run.steps))) : "",
			run.usage.cost.total > 0 ? formatCost(run.usage.cost.total) : "",
		].filter(Boolean);
		return html`<div class="agent-run">
			${run.messages.map((amsg, i) => {
				const next = run.messages[i + 1];
				// Messages enter this list at message_end, so a running call here is executing
				// (not streaming) and must stay visible: hidePendingToolCalls stays off.
				const continues = !!next && isStep(stepParts(amsg).at(-1)) && isStep(stepParts(next)[0]);
				return html`<assistant-message
					.message=${amsg}
					.tools=${this.tools}
					.isStreaming=${false}
					.pendingToolCalls=${this.pendingToolCalls}
					.toolResultsById=${resultByCallId}
					.hideToolCalls=${false}
					.hidePendingToolCalls=${false}
					.hideUsage=${true}
					.continues=${continues}
				></assistant-message>`;
			})}
			${
				live
					? ""
					: html`<button
							type="button"
							class="run-footer"
							title=${formatUsage(run.usage)}
							@click=${() => this.onCostClick?.()}
						>
							${summary.join(" · ")}
						</button>`
			}
		</div>`;
	}

	override render() {
		const items = this.buildRenderItems();
		return html`<div class="flex flex-col gap-3">
			${repeat(
				items,
				(it) => it.key,
				(it) => it.template,
			)}
		</div>`;
	}
}

// Register custom element
if (!customElements.get("message-list")) {
	customElements.define("message-list", MessageList);
}
