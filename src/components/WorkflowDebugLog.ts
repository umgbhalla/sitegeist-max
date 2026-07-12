import { html, LitElement, type PropertyValues } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
	clearWfDebugLog,
	getWfDebugLog,
	type WfDebugEntry,
	workflowDebugBus,
} from "../tools/workflow/workflow-debug-bus.js";

const LEVEL_CLASS: Record<string, string> = {
	info: "text-muted-foreground",
	warn: "text-yellow-500",
	error: "text-red-500",
};

function ts(t: number): string {
	// HH:MM:SS.mmm without Date-locale noise
	const d = new Date(t);
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * Live workflow event log, docked below the chat input. Subscribes to the
 * workflowDebugBus and tails events as they happen. Light DOM so Tailwind
 * classes apply and it matches the rest of the app.
 */
@customElement("workflow-debug-log")
export class WorkflowDebugLog extends LitElement {
	@state() private entries: WfDebugEntry[] = [...getWfDebugLog()];

	private readonly onLog = (e: Event) => {
		this.entries = [...this.entries, (e as CustomEvent<WfDebugEntry>).detail];
		if (this.entries.length > 300) this.entries = this.entries.slice(-300);
	};
	private readonly onClear = () => {
		this.entries = [];
	};

	protected createRenderRoot() {
		return this;
	}

	connectedCallback(): void {
		super.connectedCallback();
		this.entries = [...getWfDebugLog()];
		workflowDebugBus.addEventListener("log", this.onLog);
		workflowDebugBus.addEventListener("clear", this.onClear);
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		workflowDebugBus.removeEventListener("log", this.onLog);
		workflowDebugBus.removeEventListener("clear", this.onClear);
	}

	protected updated(_c: PropertyValues): void {
		// Auto-scroll to newest line.
		const box = this.querySelector("[data-log-scroll]");
		if (box) box.scrollTop = box.scrollHeight;
	}

	render() {
		return html`
			<div class="shrink-0 border-t border-border bg-background" style="height: 150px; display:flex; flex-direction:column;">
				<div class="flex items-center justify-between px-2 py-1 border-b border-border">
					<span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
						Workflow debug · ${this.entries.length}
					</span>
					<button
						class="text-[10px] text-muted-foreground hover:text-foreground px-1"
						@click=${() => clearWfDebugLog()}
						title="Clear log"
					>
						clear
					</button>
				</div>
				<div data-log-scroll class="flex-1 overflow-y-auto px-2 py-1 font-mono text-[10px] leading-tight">
					${
						this.entries.length === 0
							? html`<div class="text-muted-foreground italic">No workflow events yet. Run a workflow.</div>`
							: this.entries.map(
									(e) => html`<div class="whitespace-pre-wrap ${LEVEL_CLASS[e.level] ?? ""}">
										<span class="opacity-50">${ts(e.t)}</span> ${e.msg}
									</div>`,
								)
					}
				</div>
			</div>
		`;
	}
}
