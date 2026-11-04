import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { Job } from "../automation/jobs.js";

@customElement("automation-jobs-panel")
export class AutomationJobsPanel extends LitElement {
	@state() private jobs: Job[] = [];
	@state() private error = "";
	private timer?: ReturnType<typeof setInterval>;
	private refreshing = false;
	createRenderRoot() {
		return this;
	}
	connectedCallback() {
		super.connectedCallback();
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), 2000);
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		clearInterval(this.timer);
	}
	private async refresh() {
		if (this.refreshing || !this.isConnected) return;
		this.refreshing = true;
		try {
			const response = await chrome.runtime.sendMessage({ type: "automation", op: "jobs.list", args: {} });
			if (!response?.ok) throw new Error(response?.error ?? "Cannot load background jobs");
			if (this.isConnected)
				this.jobs = (response.value as Job[]).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
		} catch (error) {
			this.error = String(error);
		} finally {
			this.refreshing = false;
		}
	}
	private async control(id: string, action: "cancel" | "resume") {
		try {
			const response = await chrome.runtime.sendMessage({ type: "automation", op: `jobs.${action}`, args: { id } });
			if (!response.ok) throw new Error(response.error);
			this.error = "";
			await this.refresh();
		} catch (error) {
			this.error = String(error);
		}
	}
	render() {
		if (!this.jobs.length) return html``;
		return html`<details class="mx-3 my-1 text-xs text-muted-foreground"><summary>Background jobs (${this.jobs.filter((job) => job.status === "running" || job.status === "queued").length} active)</summary>
			${this.jobs.map(
				(job) => html`<div class="py-1" data-job-id=${job.id}>
				<span>${job.tool.name}: ${job.status}</span>
				${job.progress ? html`<span> - ${JSON.stringify(job.progress)}</span>` : ""}
				${job.error ? html`<div role="alert">${job.error}</div>` : ""}
				${job.status === "running" || job.status === "queued" ? html`<button class="ml-2 underline" @click=${() => this.control(job.id, "cancel")}>Cancel</button>` : job.status !== "done" ? html`<button class="ml-2 underline" @click=${() => this.control(job.id, "resume")}>Resume</button>` : ""}
			</div>`,
			)}${this.error ? html`<div role="alert">${this.error}</div>` : ""}
		</details>`;
	}
}
