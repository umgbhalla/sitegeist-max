import { icon } from "@mariozechner/mini-lit";
import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Brain, ChevronDown } from "lucide";

@customElement("thinking-block")
export class ThinkingBlock extends LitElement {
	@property() content!: string;
	@property({ type: Boolean }) isStreaming = false;
	@state() private isExpanded = false;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		this.classList.add("agent-step");
	}

	private toggleExpanded() {
		this.isExpanded = !this.isExpanded;
	}

	override render() {
		return html`
			<div class="thinking-block">
				<button type="button" class="tool-header w-full text-left cursor-pointer select-none" @click=${this.toggleExpanded}>
					<span class="tool-header-icon">${icon(Brain, "sm")}</span>
					<span class="tool-header-label ${this.isStreaming ? "shimmer-text" : ""}">Thinking</span>
					<span class="tool-header-chevron transition-transform ${this.isExpanded ? "rotate-180" : ""}">${icon(ChevronDown, "sm")}</span>
				</button>
				${this.isExpanded ? html`<div class="thinking-content"><markdown-block .content=${this.content} .isThinking=${true}></markdown-block></div>` : ""}
			</div>
		`;
	}
}
