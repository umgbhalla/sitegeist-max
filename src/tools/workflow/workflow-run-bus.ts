import type { WorkflowNode, WorkflowRun, WorkflowRunsStore } from "../../storage/stores/workflow-runs-store.js";

/**
 * Single source of truth for a workflow run's live node status. The runtime
 * provider write-throughs every transition; the progress panel subscribes to
 * "update" and re-renders. Also persists each transition to IndexedDB (journal).
 */
export class WorkflowRunBus extends EventTarget {
	readonly run: WorkflowRun;
	private store?: WorkflowRunsStore;
	private currentPhase?: string;

	constructor(run: WorkflowRun, store?: WorkflowRunsStore) {
		super();
		this.run = run;
		this.store = store;
	}

	private emit(): void {
		this.dispatchEvent(new CustomEvent("update"));
		// Fire-and-forget persist; a journal write must never block the run.
		this.store?.save(this.run).catch((e) => console.warn("[workflow] journal write failed:", e));
	}

	phase(name: string): void {
		this.currentPhase = name;
		this.run.nodes.push({
			id: `phase-${this.run.nodes.length}`,
			kind: "phase",
			name,
			state: "done",
			startedAt: Date.now(),
		});
		this.emit();
	}

	log(msg: string, _data?: unknown): void {
		this.run.nodes.push({
			id: `log-${this.run.nodes.length}`,
			kind: "log",
			name: msg,
			state: "done",
			startedAt: Date.now(),
		});
		this.emit();
	}

	agentStart(id: string, label: string, tier?: string, model?: string): void {
		this.run.nodes.push({
			id,
			kind: "agent",
			name: label,
			phase: this.currentPhase,
			state: "running",
			tier,
			model,
			startedAt: Date.now(),
		});
		this.emit();
	}

	agentDone(id: string, output: string, usage?: unknown): void {
		const n = this.find(id);
		if (n) {
			n.state = "done";
			n.output = output.slice(0, 2000);
			n.usage = usage;
			n.endedAt = Date.now();
		}
		this.emit();
	}

	agentError(id: string, error: string): void {
		const n = this.find(id);
		if (n) {
			n.state = "error";
			n.output = error.slice(0, 2000);
			n.endedAt = Date.now();
		}
		this.emit();
	}

	finish(status: "done" | "error", summary?: string): void {
		this.run.status = status;
		this.run.summary = summary;
		this.emit();
	}

	private find(id: string): WorkflowNode | undefined {
		return this.run.nodes.find((n) => n.id === id);
	}
}

// Module-level registry so the tool renderer / progress panel can find the live
// bus for a run by id (the tool result only carries the runId). One workflow at
// a time in v1; the map also survives multiple historical runs in one session.
export const activeRuns = new Map<string, WorkflowRunBus>();
