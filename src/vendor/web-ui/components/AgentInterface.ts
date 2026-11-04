import { clampThinkingLevel, streamSimple, type ToolResultMessage, type Usage } from "@earendil-works/pi-ai/compat";
import { icon } from "@mariozechner/mini-lit";
import { html, LitElement } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { ModelSelector } from "../dialogs/ModelSelector.js";
import type { MessageDelivery, MessageEditor } from "./MessageEditor.js";
import "./MessageEditor.js";
import "./MessageList.js";
import "./Messages.js"; // Import for side effects to register the custom elements
import { getAppStorage } from "../storage/app-storage.js";
import "./StreamingMessageContainer.js";
import type { Agent, AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Attachment } from "../utils/attachment-utils.js";
import { formatUsage } from "../utils/format.js";
import { i18n } from "../utils/i18n.js";
import { createStreamFn } from "../utils/proxy-utils.js";
import { ArrowUp, Pencil, X } from "lucide";
import type { UserMessageWithAttachments } from "./Messages.js";
import type { StreamingMessageContainer } from "./StreamingMessageContainer.js";

@customElement("agent-interface")
export class AgentInterface extends LitElement {
	// Optional external session: when provided, this component becomes a view over the session
	@property({ attribute: false }) session?: Agent;
	@property({ type: Boolean }) enableAttachments = true;
	@property({ type: Boolean }) enableModelSelector = true;
	@property({ type: Boolean }) enableThinkingSelector = true;
	@property({ type: Boolean }) showThemeToggle = false;
	// Optional custom API key prompt handler - if not provided, uses default dialog
	@property({ attribute: false }) onApiKeyRequired?: (provider: string) => Promise<boolean>;
	// Optional callback called before sending a message
	@property({ attribute: false }) onBeforeSend?: () => void | Promise<void>;
	// Optional callback called before executing a tool call - return false to prevent execution
	@property({ attribute: false }) onBeforeToolCall?: (toolName: string, args: any) => boolean | Promise<boolean>;
	// Optional callback called when cost display is clicked
	@property({ attribute: false }) onCostClick?: () => void;
	// Optional callback to override model selector behavior
	@property({ attribute: false }) onModelSelect?: () => void;

	// References
	@query("message-editor") private _messageEditor!: MessageEditor;
	@query("streaming-message-container") private _streamingContainer!: StreamingMessageContainer;

	private _autoScroll = true;
	private _lastScrollTop = 0;
	private _lastClientHeight = 0;
	private _scrollContainer?: HTMLElement;
	private _resizeObserver?: ResizeObserver;
	private _unsubscribeSession?: () => void;

	/**
	 * Messages sent while a run is busy. `steer` joins the run after the current
	 * tool round; `followUp` starts the next run once this one would stop. Entries
	 * leave when agent-core emits `message_start` for the same object.
	 */
	@state() private _queued: Array<{ message: AgentMessage; delivery: MessageDelivery; text: string }> = [];

	public setInput(text: string, attachments?: Attachment[]) {
		const update = () => {
			if (!this._messageEditor) requestAnimationFrame(update);
			else {
				this._messageEditor.value = text;
				this._messageEditor.attachments = attachments || [];
			}
		};
		update();
	}

	public setAutoScroll(enabled: boolean) {
		this._autoScroll = enabled;
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override willUpdate(changedProperties: Map<string, any>) {
		super.willUpdate(changedProperties);
		if (this.session?.state.model) {
			this.session.state.thinkingLevel = clampThinkingLevel(this.session.state.model, this.session.state.thinkingLevel);
		}

		// Re-subscribe when session property changes
		if (changedProperties.has("session")) {
			this.setupSessionSubscription();
		}
	}

	override async connectedCallback() {
		super.connectedCallback();

		this.style.display = "flex";
		this.style.flexDirection = "column";
		this.style.height = "100%";
		this.style.minHeight = "0";

		// Wait for first render to get scroll container
		await this.updateComplete;
		this._scrollContainer = this.querySelector(".overflow-y-auto") as HTMLElement;

		if (this._scrollContainer) {
			// Set up ResizeObserver to detect content changes
			this._resizeObserver = new ResizeObserver(() => {
				if (this._autoScroll && this._scrollContainer) {
					this._scrollContainer.scrollTop = this._scrollContainer.scrollHeight;
				}
			});

			// Observe the content container inside the scroll container
			const contentContainer = this._scrollContainer.querySelector(".max-w-3xl");
			if (contentContainer) {
				this._resizeObserver.observe(contentContainer);
			}

			// Set up scroll listener with better detection
			this._scrollContainer.addEventListener("scroll", this._handleScroll);
		}

		// Subscribe to external session if provided
		this.setupSessionSubscription();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();

		// Clean up observers and listeners
		if (this._resizeObserver) {
			this._resizeObserver.disconnect();
			this._resizeObserver = undefined;
		}

		if (this._scrollContainer) {
			this._scrollContainer.removeEventListener("scroll", this._handleScroll);
		}

		if (this._unsubscribeSession) {
			this._unsubscribeSession();
			this._unsubscribeSession = undefined;
		}
	}

	private setupSessionSubscription() {
		if (this._unsubscribeSession) {
			this._unsubscribeSession();
			this._unsubscribeSession = undefined;
		}
		if (!this.session) return;

		// Set default streamFn with proxy support if not already set
		if (this.session.streamFn === streamSimple) {
			this.session.streamFn = createStreamFn(async () => {
				const enabled = await getAppStorage().settings.get<boolean>("proxy.enabled");
				return enabled ? (await getAppStorage().settings.get<string>("proxy.url")) || undefined : undefined;
			});
		}

		// Set default getApiKey if not already set
		if (!this.session.getApiKey) {
			this.session.getApiKey = async (provider: string) => {
				const key = await getAppStorage().providerKeys.get(provider);
				return key ?? undefined;
			};
		}

		this._unsubscribeSession = this.session.subscribe(async (ev: AgentEvent) => {
			switch (ev.type) {
				case "message_start":
					if (this._queued.some((item) => item.message === ev.message)) {
						this._queued = this._queued.filter((item) => item.message !== ev.message);
					}
					this.requestUpdate();
					break;
				case "turn_start":
				case "turn_end":
				case "agent_start":
					this.requestUpdate();
					break;
				case "message_end":
					// Clear streaming container when a message completes
					// to prevent duplicate rendering (stable list now has this message)
					if (this._streamingContainer) {
						this._streamingContainer.setMessage(null, true);
					}
					this.requestUpdate();
					break;
				case "agent_end":
					// Clear streaming container when agent finishes
					if (this._streamingContainer) {
						this._streamingContainer.isStreaming = false;
						this._streamingContainer.setMessage(null, true);
					}
					this.settleQueue(ev.messages);
					this.requestUpdate();
					break;
				case "message_update":
					if (this._streamingContainer) {
						const isStreaming = this.session?.state.isStreaming || false;
						this._streamingContainer.isStreaming = isStreaming;
						this._streamingContainer.setMessage(ev.message, !isStreaming);
					}
					this.requestUpdate();
					break;
			}
		});
	}

	private _handleScroll = (_ev: any) => {
		if (!this._scrollContainer) return;

		const currentScrollTop = this._scrollContainer.scrollTop;
		const scrollHeight = this._scrollContainer.scrollHeight;
		const clientHeight = this._scrollContainer.clientHeight;
		const distanceFromBottom = scrollHeight - currentScrollTop - clientHeight;

		// Ignore relayout due to message editor getting pushed up by stats
		if (clientHeight < this._lastClientHeight) {
			this._lastClientHeight = clientHeight;
			return;
		}

		// Only disable auto-scroll if user scrolled UP or is far from bottom
		if (currentScrollTop !== 0 && currentScrollTop < this._lastScrollTop && distanceFromBottom > 50) {
			this._autoScroll = false;
		} else if (distanceFromBottom < 10) {
			// Re-enable if very close to bottom
			this._autoScroll = true;
		}

		this._lastScrollTop = currentScrollTop;
		this._lastClientHeight = clientHeight;
	};

	/**
	 * A run can end between agent-core's last queue poll and `agent_end`, leaving
	 * queued messages unsent. Aborted runs drop the queue; otherwise continue with it.
	 */
	private settleQueue(messages: AgentMessage[]) {
		const session = this.session;
		if (!session || this._queued.length === 0) return;
		const last = messages[messages.length - 1];
		if (last?.role === "assistant" && (last.stopReason === "aborted" || last.stopReason === "error")) {
			this.clearQueue();
			return;
		}
		void session.waitForIdle().then(() => {
			if (session !== this.session || session.state.isStreaming || !session.hasQueuedMessages()) return;
			session.continue().catch((error: unknown) => console.error("Failed to send queued messages", error));
		});
	}

	public clearQueue() {
		this.session?.clearAllQueues();
		this._queued = [];
	}

	/**
	 * agent-core queues only append and clear, so any edit to the queue clears
	 * both queues and re-enqueues the remaining items in display order.
	 */
	private requeue(items: typeof this._queued) {
		const session = this.session;
		if (!session) return;
		session.clearAllQueues();
		for (const item of items) {
			if (item.delivery === "steer") session.steer(item.message);
			else session.followUp(item.message);
		}
		this._queued = items;
	}

	private removeQueued(index: number) {
		this.requeue(this._queued.filter((_, i) => i !== index));
	}

	/** Pull a queued message back into the composer. */
	private editQueued(index: number) {
		const item = this._queued[index];
		if (!item) return;
		this.removeQueued(index);
		const content = (item.message as { content?: unknown }).content;
		this._messageEditor.value = typeof content === "string" ? content : item.text;
		if (item.message.role === "user-with-attachments") {
			this._messageEditor.attachments = (item.message as UserMessageWithAttachments).attachments ?? [];
		}
		this._messageEditor.querySelector("textarea")?.focus();
	}

	private toggleQueuedDelivery(index: number) {
		this.requeue(
			this._queued.map((item, i) =>
				i === index ? { ...item, delivery: item.delivery === "steer" ? "followUp" : "steer" } : item,
			),
		);
	}

	private moveQueuedUp(index: number) {
		if (index <= 0) return;
		const items = [...this._queued];
		[items[index - 1], items[index]] = [items[index], items[index - 1]];
		this.requeue(items);
	}

	public async sendMessage(input: string, attachments?: Attachment[], delivery: MessageDelivery = "steer") {
		if (!input.trim() && (attachments?.length ?? 0) === 0) return;
		if (this.session?.state.isStreaming) {
			this.queueMessage(input, attachments, delivery);
			return;
		}
		const session = this.session;
		if (!session) throw new Error("No session set on AgentInterface");
		if (!session.state.model) throw new Error("No model set on AgentInterface");
		session.state.thinkingLevel = clampThinkingLevel(session.state.model, session.state.thinkingLevel);

		// Check if API key exists for the provider (only needed in direct mode)
		const provider = session.state.model.provider;
		const apiKey = await getAppStorage().providerKeys.get(provider);

		// If no API key, prompt for it
		if (!apiKey) {
			if (!this.onApiKeyRequired) {
				console.error("No API key configured and no onApiKeyRequired handler set");
				return;
			}

			const success = await this.onApiKeyRequired(provider);

			// If still no API key, abort the send
			if (!success) {
				return;
			}
		}

		// Call onBeforeSend hook before sending
		if (this.onBeforeSend) {
			await this.onBeforeSend();
		}

		// Only clear editor after we know we can send
		this._messageEditor.value = "";
		this._messageEditor.attachments = [];
		this._autoScroll = true; // Enable auto-scroll when sending a message

		// Compose message with attachments if any
		if (attachments && attachments.length > 0) {
			const message: UserMessageWithAttachments = {
				role: "user-with-attachments",
				content: input,
				attachments,
				timestamp: Date.now(),
			};
			await this.session?.prompt(message);
		} else {
			await this.session?.prompt(input);
		}
	}

	private queueMessage(input: string, attachments: Attachment[] | undefined, delivery: MessageDelivery) {
		const session = this.session;
		if (!session) return;
		const message: AgentMessage =
			attachments && attachments.length > 0
				? ({
						role: "user-with-attachments",
						content: input,
						attachments,
						timestamp: Date.now(),
					} satisfies UserMessageWithAttachments)
				: { role: "user", content: input, timestamp: Date.now() };
		if (delivery === "steer") session.steer(message);
		else session.followUp(message);
		this._queued = [...this._queued, { message, delivery, text: input.trim() || i18n("Attachments") }];
		this._messageEditor.value = "";
		this._messageEditor.attachments = [];
		this._autoScroll = true;
	}

	private renderQueue() {
		if (this._queued.length === 0) return "";
		return html`
			<div class="message-queue" role="status" aria-live="polite">
				<div class="message-queue-header">
					<span>${i18n("Queued")} <span class="message-queue-count">${this._queued.length}</span></span>
					<button type="button" class="message-queue-clear" @click=${() => this.clearQueue()}>${i18n("Clear")}</button>
				</div>
				${this._queued.map(
					(item, index) => html`
						<div class="message-queue-item">
							<button
								type="button"
								class="message-queue-mode"
								title=${i18n("Switch between steering this run and running next")}
								@click=${() => this.toggleQueuedDelivery(index)}
							>
								${item.delivery === "steer" ? i18n("Steer") : i18n("Next")}
							</button>
							<span class="message-queue-text">${item.text}</span>
							<span class="message-queue-actions">
								${
									index > 0
										? html`<button type="button" title=${i18n("Move up")} @click=${() => this.moveQueuedUp(index)}>
												${icon(ArrowUp, "xs")}
											</button>`
										: ""
								}
								<button type="button" title=${i18n("Edit")} @click=${() => this.editQueued(index)}>
									${icon(Pencil, "xs")}
								</button>
								<button type="button" title=${i18n("Remove")} @click=${() => this.removeQueued(index)}>
									${icon(X, "xs")}
								</button>
							</span>
						</div>
					`,
				)}
			</div>
		`;
	}

	private renderMessages() {
		if (!this.session)
			return html`<div class="p-4 text-center text-muted-foreground">${i18n("No session available")}</div>`;
		const state = this.session.state;
		// Build a map of tool results to allow inline rendering in assistant messages
		const toolResultsById = new Map<string, ToolResultMessage<any>>();
		for (const message of state.messages) {
			if (message.role === "toolResult") {
				toolResultsById.set(message.toolCallId, message);
			}
		}
		return html`
			<div class="flex flex-col gap-3">
				<!-- Stable messages list - won't re-render during streaming -->
				<message-list
					.messages=${this.session.state.messages}
					.tools=${state.tools}
					.pendingToolCalls=${this.session ? this.session.state.pendingToolCalls : new Set<string>()}
					.isStreaming=${state.isStreaming}
					.onCostClick=${this.onCostClick}
				></message-list>

				<!-- Streaming message container - manages its own updates -->
				<streaming-message-container
					class="${state.isStreaming ? "" : "hidden"}"
					.tools=${state.tools}
					.isStreaming=${state.isStreaming}
					.pendingToolCalls=${state.pendingToolCalls}
					.toolResultsById=${toolResultsById}
					.onCostClick=${this.onCostClick}
				></streaming-message-container>
			</div>
		`;
	}

	private renderStats() {
		if (!this.session) return html`<div class="text-xs h-5"></div>`;

		const state = this.session.state;
		const totals = state.messages
			.filter((m) => m.role === "assistant")
			.reduce(
				(acc, msg: any) => {
					const usage = msg.usage;
					if (usage) {
						acc.input += usage.input;
						acc.output += usage.output;
						acc.cacheRead += usage.cacheRead;
						acc.cacheWrite += usage.cacheWrite;
						acc.cost.total += usage.cost.total;
					}
					return acc;
				},
				{
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				} satisfies Usage,
			);

		const hasTotals = totals.input || totals.output || totals.cacheRead || totals.cacheWrite;
		const totalsText = hasTotals ? formatUsage(totals) : "";

		return html`
			<div class="text-xs text-muted-foreground flex justify-between items-center h-5">
				<div class="flex items-center gap-1">
					${this.showThemeToggle ? html`<theme-toggle></theme-toggle>` : html``}
				</div>
				<div class="flex ml-auto items-center gap-3">
					${
						totalsText
							? this.onCostClick
								? html`<span class="cursor-pointer hover:text-foreground transition-colors" @click=${this.onCostClick}>${totalsText}</span>`
								: html`<span>${totalsText}</span>`
							: ""
					}
				</div>
			</div>
		`;
	}

	override render() {
		if (!this.session)
			return html`<div class="p-4 text-center text-muted-foreground">${i18n("No session set")}</div>`;

		const session = this.session;
		const state = this.session.state;
		return html`
			<div class="flex flex-col h-full bg-background text-foreground">
				<!-- Messages Area -->
				<div class="flex-1 overflow-y-auto">
					<div class="max-w-3xl mx-auto p-4 pb-0">${this.renderMessages()}</div>
				</div>

				<!-- Input Area -->
				<div class="shrink-0">
					<div class="max-w-3xl mx-auto px-2">
						${this.renderQueue()}
						<message-editor
							.isStreaming=${state.isStreaming}
							.currentModel=${state.model}
							.thinkingLevel=${state.thinkingLevel}
							.showAttachmentButton=${this.enableAttachments}
							.showModelSelector=${this.enableModelSelector}
							.showThinkingSelector=${this.enableThinkingSelector}
							.onSend=${(input: string, attachments: Attachment[], delivery?: MessageDelivery) => {
								this.sendMessage(input, attachments, delivery);
							}}
							.onAbort=${() => {
								this.clearQueue();
								session.abort();
							}}
							.onModelSelect=${() => {
								if (this.onModelSelect) {
									this.onModelSelect();
								} else {
									ModelSelector.open(state.model, (model) => {
										session.state.model = model;
									});
								}
							}}
							.onThinkingChange=${
								this.enableThinkingSelector
									? (level: ThinkingLevel) => {
											session.state.thinkingLevel = level;
										}
									: undefined
							}
						></message-editor>
						${this.renderStats()}
					</div>
				</div>
			</div>
		`;
	}
}

// Register custom element with guard
if (!customElements.get("agent-interface")) {
	customElements.define("agent-interface", AgentInterface);
}
