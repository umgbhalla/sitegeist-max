import { icon } from "@mariozechner/mini-lit";
import { html, type TemplateResult } from "lit";
import type { Ref } from "lit/directives/ref.js";
import { ref } from "lit/directives/ref.js";
import { ChevronDown, ChevronUp } from "lucide";
import type { ToolRenderer } from "./types.js";

// Registry of tool renderers
export const toolRenderers = new Map<string, ToolRenderer>();

/**
 * Register a custom tool renderer
 */
export function registerToolRenderer(toolName: string, renderer: ToolRenderer): void {
	toolRenderers.set(toolName, renderer);
}

/**
 * Get a tool renderer by name
 */
export function getToolRenderer(toolName: string): ToolRenderer | undefined {
	return toolRenderers.get(toolName);
}

type ToolState = "inprogress" | "complete" | "error";

export interface StepSource {
	url: string;
	title?: string;
	favicon?: string;
}

const hostOf = (url: string) => {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
};

/**
 * Sources a step touched, as chips under its label (FF ThinkingStepSources).
 * Each chip opens its page in a new tab; past `limit` the rest collapse to "+N".
 */
export function renderSources(sources: StepSource[], limit = 4): TemplateResult {
	const shown = sources.slice(0, limit);
	const rest = sources.length - shown.length;
	return html`<div class="step-sources">
		${shown.map(
			(source) => html`<button
				type="button"
				class="source-chip"
				title=${source.title ? `${source.title}\n${source.url}` : source.url}
				@click=${() => chrome.tabs.create({ url: source.url })}
			>
				${source.favicon ? html`<img src=${source.favicon} alt="" />` : ""}
				<span>${source.title && sources.length === 1 ? source.title : hostOf(source.url)}</span>
			</button>`,
		)}
		${rest > 0 ? html`<span class="source-chip source-chip-more">+${rest}</span>` : ""}
	</div>`;
}

/** Icon in the step gutter (see `.agent-step` in app.css): muted, destructive on error. */
const stepIcon = (state: ToolState, toolIcon: any) =>
	html`<span class="tool-header-icon ${state === "error" ? "text-destructive" : ""}">${icon(toolIcon, "sm")}</span>`;

/** Label of a step; shimmers while the call runs. */
const stepLabel = (state: ToolState, text: string | TemplateResult) =>
	html`<span class="tool-header-label ${state === "inprogress" ? "shimmer-text" : ""}">${text}</span>`;

/**
 * Helper to render a header for tool renderers: one step row, icon in the
 * gutter, label shimmering while in progress.
 */
export function renderHeader(state: ToolState, toolIcon: any, text: string | TemplateResult): TemplateResult {
	return html`<div class="tool-header">${stepIcon(state, toolIcon)}${stepLabel(state, text)}</div>`;
}

/**
 * Helper to render a collapsible header for tool renderers
 * Same as renderHeader but with a chevron button that toggles visibility of content
 */
export function renderCollapsibleHeader(
	state: ToolState,
	toolIcon: any,
	text: string | TemplateResult,
	contentRef: Ref<HTMLElement>,
	chevronRef: Ref<HTMLElement>,
	defaultExpanded = false,
): TemplateResult {
	const toggleContent = (e: Event) => {
		e.preventDefault();
		const content = contentRef.value;
		const chevron = chevronRef.value;
		if (content && chevron) {
			const isCollapsed = content.classList.contains("max-h-0");
			if (isCollapsed) {
				content.classList.remove("max-h-0");
				content.classList.add("max-h-[2000px]", "mt-3");
				// Show ChevronUp, hide ChevronsUpDown
				const upIcon = chevron.querySelector(".chevron-up");
				const downIcon = chevron.querySelector(".chevrons-up-down");
				if (upIcon && downIcon) {
					upIcon.classList.remove("hidden");
					downIcon.classList.add("hidden");
				}
			} else {
				content.classList.remove("max-h-[2000px]", "mt-3");
				content.classList.add("max-h-0");
				// Show ChevronsUpDown, hide ChevronUp
				const upIcon = chevron.querySelector(".chevron-up");
				const downIcon = chevron.querySelector(".chevrons-up-down");
				if (upIcon && downIcon) {
					upIcon.classList.add("hidden");
					downIcon.classList.remove("hidden");
				}
			}
		}
	};

	return html`
		<button @click=${toggleContent} class="tool-header w-full text-left cursor-pointer">
			${stepIcon(state, toolIcon)}${stepLabel(state, text)}
			<span class="tool-header-chevron" ${ref(chevronRef)}>
				<span class="chevron-up ${defaultExpanded ? "" : "hidden"}">${icon(ChevronUp, "sm")}</span>
				<span class="chevrons-up-down ${defaultExpanded ? "hidden" : ""}">${icon(ChevronDown, "sm")}</span>
			</span>
		</button>
	`;
}
