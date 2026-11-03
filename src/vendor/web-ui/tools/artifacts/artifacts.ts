import { icon } from "@mariozechner/mini-lit";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import type { Agent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolCall } from "@earendil-works/pi-ai/compat";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { createRef, type Ref, ref } from "lit/directives/ref.js";
import { X } from "lucide";
import type { TSchema } from "typebox";
import type { ArtifactMessage } from "../../components/Messages.js";
import { ArtifactsRuntimeProvider } from "../../components/sandbox/ArtifactsRuntimeProvider.js";
import { AttachmentsRuntimeProvider } from "../../components/sandbox/AttachmentsRuntimeProvider.js";
import type { SandboxRuntimeProvider } from "../../components/sandbox/SandboxRuntimeProvider.js";
import {
	ARTIFACT_TOOL_DESCRIPTIONS,
	ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RO,
	ATTACHMENTS_RUNTIME_DESCRIPTION,
} from "../../prompts/prompts.js";
import type { Attachment } from "../../utils/attachment-utils.js";
import { i18n } from "../../utils/i18n.js";
import type { ArtifactElement } from "./ArtifactElement.js";
import {
	ARTIFACT_OPERATIONS,
	type ArtifactCall,
	ArtifactError,
	type ArtifactFiles,
	type ArtifactOperationArgs,
	type ArtifactOperationName,
	applyArtifactCall,
	isArtifactTool,
	toArtifactCall,
} from "./artifact-operations.js";
import { resolveArtifactViewer } from "./artifact-viewers.js";
import { HtmlArtifact } from "./HtmlArtifact.js";

// Simple artifact model
export interface Artifact {
	filename: string;
	content: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface ArtifactRunOptions {
	/** Skip waiting for HTML execution logs. */
	skipWait?: boolean;
	/** Do not switch the preview or notify listeners. */
	silent?: boolean;
}

@customElement("artifacts-panel")
export class ArtifactsPanel extends LitElement {
	@state() private _artifacts = new Map<string, Artifact>();
	@state() private _activeFilename: string | null = null;

	// Programmatically managed artifact elements
	private artifactElements = new Map<string, ArtifactElement>();
	private contentRef: Ref<HTMLDivElement> = createRef();

	// Agent reference (needed to get attachments for HTML artifacts)
	@property({ attribute: false }) agent?: Agent;
	// Sandbox URL provider for browser extensions (optional)
	@property({ attribute: false }) sandboxUrlProvider?: () => string;
	// Callbacks
	@property({ attribute: false }) onArtifactsChange?: () => void;
	@property({ attribute: false }) onClose?: () => void;
	@property({ attribute: false }) onOpen?: () => void;
	// Collapsed mode: hides panel content but can show a floating reopen pill
	@property({ type: Boolean }) collapsed = false;
	// Overlay mode: when true, panel renders full-screen overlay (mobile)
	@property({ type: Boolean }) overlay = false;

	// Public getter for artifacts
	get artifacts() {
		return this._artifacts;
	}

	// Get runtime providers for HTML artifacts (read-only: attachments + artifacts)
	private getHtmlArtifactRuntimeProviders(): SandboxRuntimeProvider[] {
		const providers: SandboxRuntimeProvider[] = [];

		// Get attachments from agent messages
		if (this.agent) {
			const attachments: Attachment[] = [];
			for (const message of this.agent.state.messages) {
				if (message.role === "user-with-attachments" && message.attachments) {
					attachments.push(...message.attachments);
				}
			}
			if (attachments.length > 0) {
				providers.push(new AttachmentsRuntimeProvider(attachments));
			}
		}

		// Add read-only artifacts provider
		providers.push(new ArtifactsRuntimeProvider(this, this.agent, false));

		return providers;
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this; // light DOM for shared styles
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		this.style.height = "100%";
		// Reattach existing artifact elements when panel is re-inserted into the DOM
		requestAnimationFrame(() => {
			const container = this.contentRef.value;
			if (!container) return;
			// Ensure we have an active filename
			if (!this._activeFilename && this._artifacts.size > 0) {
				this._activeFilename = Array.from(this._artifacts.keys())[0];
			}
			this.artifactElements.forEach((element, name) => {
				if (!element.parentElement) container.appendChild(element);
				element.style.display = name === this._activeFilename ? "block" : "none";
			});
		});
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		// Do not tear down artifact elements; keep them to restore on next mount
	}

	// Get or create artifact element
	private getOrCreateArtifactElement(filename: string, content: string): ArtifactElement {
		let element = this.artifactElements.get(filename);

		if (!element) {
			element = resolveArtifactViewer(filename).create();
			if (element instanceof HtmlArtifact) {
				element.runtimeProviders = this.getHtmlArtifactRuntimeProviders();
				if (this.sandboxUrlProvider) element.sandboxUrlProvider = this.sandboxUrlProvider;
			}
			element.filename = filename;
			element.content = content;
			element.style.display = "none";
			element.style.height = "100%";

			// Store element
			this.artifactElements.set(filename, element);

			// Add to DOM - try immediately if container exists, otherwise schedule
			const newElement = element;
			if (this.contentRef.value) {
				this.contentRef.value.appendChild(newElement);
			} else {
				requestAnimationFrame(() => {
					if (this.contentRef.value && !newElement.parentElement) {
						this.contentRef.value.appendChild(newElement);
					}
				});
			}
		} else {
			// Just update content
			element.content = content;
			if (element instanceof HtmlArtifact) {
				element.runtimeProviders = this.getHtmlArtifactRuntimeProviders();
			}
		}

		return element;
	}

	// Show/hide artifact elements
	private showArtifact(filename: string) {
		// Ensure the active element is in the DOM
		requestAnimationFrame(() => {
			this.artifactElements.forEach((element, name) => {
				if (this.contentRef.value && !element.parentElement) {
					this.contentRef.value.appendChild(element);
				}
				element.style.display = name === filename ? "block" : "none";
			});
		});
		this._activeFilename = filename;
		this.requestUpdate(); // Only for tab bar update

		// Scroll the active tab into view after render
		requestAnimationFrame(() => {
			const activeButton = this.querySelector(`button[data-filename="${filename}"]`);
			if (activeButton) {
				activeButton.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
			}
		});
	}

	// Open panel and focus an artifact tab by filename
	public openArtifact(filename: string) {
		if (this._artifacts.has(filename)) {
			this.showArtifact(filename);
			// Ask host to open panel (AgentInterface demo listens to onOpen)
			this.onOpen?.();
		}
	}

	/** One model-facing tool per artifact operation. */
	public get tools(): AgentTool<TSchema, undefined>[] {
		const descriptions = ARTIFACT_TOOL_DESCRIPTIONS([
			ATTACHMENTS_RUNTIME_DESCRIPTION,
			ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RO,
		]);
		return ARTIFACT_OPERATIONS.map(
			(operation): AgentTool<TSchema, undefined> => ({
				label: operation.label,
				name: operation.tool,
				description: descriptions[operation.op],
				parameters: operation.parameters,
				// Calls on one store must not interleave (create then edit of the same file).
				executionMode: "sequential",
				execute: async (_toolCallId, args) => {
					const output = await this.run({ op: operation.op, args } as ArtifactCall);
					return { content: [{ type: "text", text: output }], details: undefined };
				},
			}),
		);
	}

	/**
	 * Execute one artifact operation against this panel. Throws `ArtifactError` on
	 * invalid input, so tool calls settle as error results.
	 */
	public async runOperation<K extends ArtifactOperationName>(
		op: K,
		args: ArtifactOperationArgs[K],
		options: ArtifactRunOptions = {},
	): Promise<string> {
		return this.run({ op, args } as ArtifactCall, options);
	}

	private async run(call: ArtifactCall, options: ArtifactRunOptions = {}): Promise<string> {
		const { filename } = call.args;
		switch (call.op) {
			case "read": {
				const artifact = this._artifacts.get(filename);
				if (!artifact) throw this.notFound(filename);
				return artifact.content;
			}
			case "logs": {
				const element = this.artifactElements.get(filename);
				if (!element) throw this.notFound(filename);
				if (!(element instanceof HtmlArtifact)) {
					throw new ArtifactError(`File ${filename} is not an HTML file. Logs are only available for HTML files.`);
				}
				return element.getLogs();
			}
			default: {
				const files = this.fileMap();
				applyArtifactCall(files, call);
				this.commitFile(filename, files.get(filename), options);
				const verb = { create: "Created", edit: "Updated", write: "Rewrote", delete: "Deleted" }[call.op];
				let output = `${verb} file ${filename}`;
				if (call.op !== "delete" && resolveArtifactViewer(filename).id === "html" && !options.skipWait) {
					const logs = await this.waitForHtmlExecution(filename);
					if (logs) output += `\n${logs}`;
				}
				return output;
			}
		}
	}

	private fileMap(): ArtifactFiles {
		return new Map(Array.from(this._artifacts, ([name, artifact]) => [name, artifact.content]));
	}

	private notFound(filename: string): ArtifactError {
		const names = Array.from(this._artifacts.keys());
		return new ArtifactError(
			names.length === 0
				? `File ${filename} not found. No files have been created yet.`
				: `File ${filename} not found. Available files: ${names.join(", ")}`,
		);
	}

	/** Sync one file's stored content (undefined = deleted) into the store, its element, and the preview. */
	private commitFile(filename: string, content: string | undefined, options: ArtifactRunOptions): void {
		const now = new Date();
		const next = new Map(this._artifacts);
		if (content === undefined) {
			next.delete(filename);
			this.artifactElements.get(filename)?.remove();
			this.artifactElements.delete(filename);
		} else {
			const existing = next.get(filename);
			next.set(filename, { filename, content, createdAt: existing?.createdAt ?? now, updatedAt: now });
			this.getOrCreateArtifactElement(filename, content);
		}
		this._artifacts = next;

		if (!options.silent) {
			if (content === undefined) {
				if (this._activeFilename === filename) {
					const remaining = Array.from(next.keys());
					if (remaining.length > 0) this.showArtifact(remaining[0]);
					else this._activeFilename = null;
				}
			} else if (!this._activeFilename || this._activeFilename === filename) {
				// A background change keeps the file the user is looking at.
				this.showArtifact(filename);
			}
			this.onArtifactsChange?.();
			this.requestUpdate();
		}

		// HTML artifacts can read other artifacts, so any change reloads them.
		this.reloadAllHtmlArtifacts();
	}

	/** Rebuild artifacts by replaying every recorded artifact change in `messages`. */
	public async reconstructFromMessages(
		messages: Array<AgentMessage | { role: "aborted" } | { role: "artifact" }>,
	): Promise<void> {
		const calls = new Map<string, ToolCall>();
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type === "toolCall" && isArtifactTool(block.name)) calls.set(block.id, block);
			}
		}

		const files: ArtifactFiles = new Map();
		const replay = (call: ArtifactCall | undefined) => {
			if (!call) return;
			try {
				applyArtifactCall(files, call);
			} catch {
				// A call that failed live fails the same way here; skip it.
			}
		};
		for (const message of messages) {
			if (message.role === "artifact") {
				replay(fromArtifactMessage(message as ArtifactMessage));
			} else if (message.role === "toolResult" && !message.isError) {
				const call = calls.get(message.toolCallId);
				if (call) replay(toArtifactCall(call.name, call.arguments));
			}
		}

		this.artifactElements.forEach((el) => {
			el.remove();
		});
		this.artifactElements.clear();
		this._activeFilename = null;
		const now = new Date();
		this._artifacts = new Map(
			Array.from(files, ([filename, content]) => [filename, { filename, content, createdAt: now, updatedAt: now }]),
		);
		for (const [filename, content] of files) this.getOrCreateArtifactElement(filename, content);

		if (this._artifacts.size > 0) this.showArtifact(Array.from(this._artifacts.keys())[0]);
		this.onArtifactsChange?.();
		this.requestUpdate();
	}

	// Wait for HTML artifact execution and get logs
	private async waitForHtmlExecution(filename: string): Promise<string> {
		const element = this.artifactElements.get(filename);
		if (!(element instanceof HtmlArtifact)) {
			return "";
		}

		return new Promise((resolve) => {
			// Fallback timeout - just get logs after execution should complete
			setTimeout(() => {
				resolve(element.getLogs());
			}, 1500);
		});
	}

	// Reload all HTML artifacts (called when any artifact changes)
	private reloadAllHtmlArtifacts() {
		this.artifactElements.forEach((element) => {
			if (element instanceof HtmlArtifact && element.sandboxIframeRef.value) {
				// Update runtime providers with latest artifact state
				element.runtimeProviders = this.getHtmlArtifactRuntimeProviders();
				// Re-execute the HTML content
				element.executeContent(element.content);
			}
		});
	}

	override render(): TemplateResult {
		const artifacts = Array.from(this._artifacts.values());

		// Panel is hidden when collapsed OR when there are no artifacts
		const showPanel = artifacts.length > 0 && !this.collapsed;

		return html`
			<div
				class="${showPanel ? "" : "hidden"} ${
					this.overlay ? "fixed inset-0 z-40 pointer-events-auto backdrop-blur-sm bg-background/95" : "relative"
				} h-full flex flex-col bg-background text-card-foreground ${
					!this.overlay ? "border-l border-border" : ""
				} overflow-hidden shadow-xl"
			>
				<!-- Tab bar (always shown when there are artifacts) -->
				<div class="artifact-preview-toolbar flex items-center justify-between border-b border-border bg-background">
					<div class="min-w-0 flex overflow-x-auto">
						${artifacts.map((a) => {
							const isActive = a.filename === this._activeFilename;
							const activeClass = isActive
								? "border-primary text-primary"
								: "border-transparent text-muted-foreground hover:text-foreground";
							return html`
								<button
									class="px-3 py-2 whitespace-nowrap border-b-2 ${activeClass}"
									data-filename="${a.filename}"
									@click=${() => this.showArtifact(a.filename)}
								>
									<span class="font-mono text-xs">${a.filename}</span>
								</button>
							`;
						})}
					</div>
					<div class="flex shrink-0 items-center gap-1 px-2">
						${(() => {
							const active = this._activeFilename ? this.artifactElements.get(this._activeFilename) : undefined;
							return active ? active.getHeaderButtons() : "";
						})()}
						${Button({
							variant: "ghost",
							size: "sm",
							onClick: () => this.onClose?.(),
							title: i18n("Close artifacts"),
							children: icon(X, "sm"),
						})}
					</div>
				</div>

				<!-- Content area where artifact elements are added programmatically -->
				<div class="flex-1 overflow-hidden" ${ref(this.contentRef)}></div>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"artifacts-panel": ArtifactsPanel;
	}
}

/** Runtime-provider writes (`createOrUpdateArtifact`, `deleteArtifact` in the REPL) are recorded as artifact messages. */
function fromArtifactMessage(message: ArtifactMessage): ArtifactCall | undefined {
	switch (message.action) {
		case "create":
			return { op: "create", args: { filename: message.filename, content: message.content ?? "" } };
		case "update":
			return { op: "write", args: { filename: message.filename, content: message.content ?? "" } };
		case "delete":
			return { op: "delete", args: { filename: message.filename } };
	}
}
