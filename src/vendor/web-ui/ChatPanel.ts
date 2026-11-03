import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import "./components/AgentInterface.js";
import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentInterface } from "./components/AgentInterface.js";
import { ArtifactsRuntimeProvider } from "./components/sandbox/ArtifactsRuntimeProvider.js";
import { AttachmentsRuntimeProvider } from "./components/sandbox/AttachmentsRuntimeProvider.js";
import type { SandboxRuntimeProvider } from "./components/sandbox/SandboxRuntimeProvider.js";
import { ARTIFACT_OPERATIONS, LEGACY_ARTIFACTS_TOOL } from "./tools/artifacts/artifact-operations.js";
import { ArtifactsPanel, ArtifactsToolRenderer } from "./tools/artifacts/index.js";
import { registerToolRenderer } from "./tools/renderer-registry.js";
import type { Attachment } from "./utils/attachment-utils.js";

const BREAKPOINT = 800; // px - switch between stacked and side-by-side previews

@customElement("pi-chat-panel")
export class ChatPanel extends LitElement {
	@state() public agent?: Agent;
	@state() public agentInterface?: AgentInterface;
	@state() public artifactsPanel?: ArtifactsPanel;
	@state() private hasArtifacts = false;
	@state() private artifactCount = 0;
	@state() private showArtifactsPanel = false;
	@state() private windowWidth = 0;

	private resizeHandler = () => {
		this.windowWidth = window.innerWidth;
		this.requestUpdate();
	};

	createRenderRoot() {
		return this;
	}

	override connectedCallback() {
		super.connectedCallback();
		this.windowWidth = window.innerWidth; // Set initial width after connection
		window.addEventListener("resize", this.resizeHandler);
		this.style.display = "flex";
		this.style.flexDirection = "column";
		this.style.height = "100%";
		this.style.minHeight = "0";
		// Update width after initial render
		requestAnimationFrame(() => {
			this.windowWidth = window.innerWidth;
			this.requestUpdate();
		});
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		window.removeEventListener("resize", this.resizeHandler);
	}

	async setAgent(
		agent: Agent,
		config?: {
			onApiKeyRequired?: (provider: string) => Promise<boolean>;
			onBeforeSend?: () => void | Promise<void>;
			onCostClick?: () => void;
			onModelSelect?: () => void;
			sandboxUrlProvider?: () => string;
			toolsFactory?: (
				agent: Agent,
				agentInterface: AgentInterface,
				artifactsPanel: ArtifactsPanel,
				runtimeProvidersFactory: () => SandboxRuntimeProvider[],
			) => AgentTool<any>[];
		},
	) {
		this.agent = agent;
		this.showArtifactsPanel = false;

		// Create AgentInterface
		this.agentInterface = document.createElement("agent-interface") as AgentInterface;
		this.agentInterface.session = agent;
		this.agentInterface.enableAttachments = true;
		this.agentInterface.enableModelSelector = true;
		this.agentInterface.enableThinkingSelector = true;
		this.agentInterface.showThemeToggle = false;
		this.agentInterface.onApiKeyRequired = config?.onApiKeyRequired;
		this.agentInterface.onModelSelect = config?.onModelSelect;
		this.agentInterface.onBeforeSend = config?.onBeforeSend;
		this.agentInterface.onCostClick = config?.onCostClick;

		// Set up artifacts panel
		this.artifactsPanel = new ArtifactsPanel();
		this.artifactsPanel.agent = agent; // Pass agent for HTML artifact runtime providers
		if (config?.sandboxUrlProvider) {
			this.artifactsPanel.sandboxUrlProvider = config.sandboxUrlProvider;
		}
		// Register the standalone tool renderer (not the panel itself)
		// The legacy name keeps tool calls in sessions saved before the split rendering.
		for (const name of [...ARTIFACT_OPERATIONS.map((operation) => operation.tool), LEGACY_ARTIFACTS_TOOL]) {
			registerToolRenderer(name, new ArtifactsToolRenderer(this.artifactsPanel, name));
		}

		// Runtime providers factory for REPL tools (read-write access)
		const runtimeProvidersFactory = () => {
			const attachments: Attachment[] = [];
			for (const message of this.agent!.state.messages) {
				if (message.role === "user-with-attachments") {
					message.attachments?.forEach((a) => {
						attachments.push(a);
					});
				}
			}
			const providers: SandboxRuntimeProvider[] = [];

			// Add attachments provider if there are attachments
			if (attachments.length > 0) {
				providers.push(new AttachmentsRuntimeProvider(attachments));
			}

			// Add artifacts provider with read-write access (for REPL)
			providers.push(new ArtifactsRuntimeProvider(this.artifactsPanel!, this.agent!, true));

			return providers;
		};

		this.artifactsPanel.onArtifactsChange = () => {
			const count = this.artifactsPanel?.artifacts?.size ?? 0;
			this.hasArtifacts = count > 0;
			this.artifactCount = count;
			if (!this.hasArtifacts) this.showArtifactsPanel = false;
			this.requestUpdate();
		};

		this.artifactsPanel.onClose = () => {
			this.showArtifactsPanel = false;
			this.requestUpdate();
		};

		this.artifactsPanel.onOpen = () => {
			this.showArtifactsPanel = true;
			this.requestUpdate();
		};

		// Set tools on the agent
		// Pass runtimeProvidersFactory so consumers can configure their own REPL tools
		const additionalTools =
			config?.toolsFactory?.(agent, this.agentInterface, this.artifactsPanel, runtimeProvidersFactory) || [];
		const tools = [...this.artifactsPanel.tools, ...additionalTools];
		this.agent.state.tools = tools;

		// Reconstruct artifacts from existing messages
		// Temporarily disable the onArtifactsChange callback to prevent auto-opening on load
		const originalCallback = this.artifactsPanel.onArtifactsChange;
		this.artifactsPanel.onArtifactsChange = undefined;
		await this.artifactsPanel.reconstructFromMessages(this.agent.state.messages);
		this.artifactsPanel.onArtifactsChange = originalCallback;

		this.hasArtifacts = this.artifactsPanel.artifacts.size > 0;
		this.artifactCount = this.artifactsPanel.artifacts.size;

		this.requestUpdate();
	}

	render() {
		if (!this.agent || !this.agentInterface) {
			return html`<div class="flex items-center justify-center h-full">
				<div class="text-muted-foreground">No agent set</div>
			</div>`;
		}

		const isMobile = this.windowWidth < BREAKPOINT;

		// Set panel props
		if (this.artifactsPanel) {
			this.artifactsPanel.collapsed = !this.showArtifactsPanel;
			this.artifactsPanel.overlay = false;
		}

		const previewOpen = this.hasArtifacts && this.showArtifactsPanel;
		return html`
			<div class="chat-workspace">
				${this.hasArtifacts ? html`
					<div class="chat-files-bar">
						<span class="chat-files-caption">Created in this chat</span>
						<button class="chat-files-toggle" aria-expanded=${previewOpen}
							aria-controls="chat-file-preview"
							@click=${() => { this.showArtifactsPanel = !this.showArtifactsPanel; }}>
							Files <span class="chat-files-count">${this.artifactCount}</span>
							<span aria-hidden="true">${previewOpen ? "−" : "+"}</span>
						</button>
					</div>
				` : ""}
				<div class="chat-workspace-body ${previewOpen ? "preview-open" : ""} ${isMobile ? "compact" : "wide"}">
					<div class="chat-conversation">${this.agentInterface}</div>
					<section id="chat-file-preview" class="chat-file-preview" aria-label="File preview"
						?hidden=${!previewOpen}
						@keydown=${(event: KeyboardEvent) => {
							if (event.key === "Escape") {
								this.showArtifactsPanel = false;
								this.querySelector<HTMLButtonElement>(".chat-files-toggle")?.focus();
							}
						}}>${this.artifactsPanel}</section>
				</div>
			</div>
		`;
	}
}
