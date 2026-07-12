import { html, LitElement, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { WorkflowNode, WorkflowRun } from "../storage/stores/workflow-runs-store.js";
import { activeRuns, type WorkflowRunBus } from "../tools/workflow/workflow-run-bus.js";

const STATE_ICON: Record<string, string> = { running: "◐", done: "✓", error: "✗" };

/**
 * Live progress panel for a workflow run. Subscribes to the WorkflowRunBus and
 * renders the phase/agent/log tree. Light DOM (createRenderRoot=this) to match
 * the rest of the app and keep Tailwind + e2e locators working.
 */
@customElement("workflow-progress-panel")
export class WorkflowProgressPanel extends LitElement {
	@property({ type: String }) runId = "";
	@state() private run?: WorkflowRun;
	private bus?: WorkflowRunBus;
	private readonly onUpdate = () => {
		if (this.bus) this.run = { ...this.bus.run, nodes: [...this.bus.run.nodes] };
		this.requestUpdate();
	};

	protected createRenderRoot() {
		return this;
	}

	connectedCallback(): void {
		super.connectedCallback();
		this.attach();
	}

	protected updated(changed: PropertyValues): void {
		if (changed.has("runId")) this.attach();
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		this.bus?.removeEventListener("update", this.onUpdate);
	}

	private attach(): void {
		const bus = activeRuns.get(this.runId);
		if (bus && bus !== this.bus) {
			this.bus?.removeEventListener("update", this.onUpdate);
			this.bus = bus;
			this.run = { ...bus.run, nodes: [...bus.run.nodes] };
			bus.addEventListener("update", this.onUpdate);
		}
	}

	render() {
		const run = this.run ?? this.bus?.run;
		if (!run) {
			return html`<div data-testid="workflow-panel" class="text-sm text-muted-foreground">Workflow run not found.</div>`;
		}
		return html`
			<div data-testid="workflow-panel" data-status=${run.status} class="text-sm border border-border rounded-md p-2 space-y-1">
				<div class="font-medium flex items-center gap-2">
					<span>${run.title}</span>
					<span class="text-xs text-muted-foreground">${run.status}</span>
				</div>
				${run.nodes.map((n) => this.renderNode(n))}
				${run.summary ? html`<div class="text-xs text-muted-foreground pt-1 border-t border-border">${run.summary}</div>` : ""}
			</div>
		`;
	}

	private renderNode(n: WorkflowNode) {
		if (n.kind === "phase") {
			return html`<div data-testid="workflow-phase" data-state=${n.state} class="font-semibold mt-1">▮ ${n.name}</div>`;
		}
		if (n.kind === "agent") {
			return html`
				<div data-testid="workflow-agent" data-state=${n.state} class="ml-3 flex gap-2">
					<span>${STATE_ICON[n.state] ?? "•"}</span>
					<span>${n.name}</span>
					${n.model ? html`<span class="text-xs text-muted-foreground">${n.model}</span>` : ""}
					${n.output ? html`<span class="text-xs text-muted-foreground truncate">— ${n.output.slice(0, 80)}</span>` : ""}
				</div>
			`;
		}
		return html`<div data-testid="workflow-log" class="ml-3 text-muted-foreground">· ${n.name}</div>`;
	}
}
