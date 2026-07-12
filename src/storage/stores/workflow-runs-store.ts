import { Store, type StoreConfig } from "@earendil-works/pi-web-ui";

export type WorkflowNodeState = "running" | "done" | "error";

export interface WorkflowNode {
	id: string;
	kind: "phase" | "agent" | "log";
	name: string;
	phase?: string;
	state: WorkflowNodeState;
	tier?: string;
	model?: string;
	output?: string;
	usage?: unknown;
	startedAt?: number;
	endedAt?: number;
}

export interface WorkflowRun {
	id: string;
	title: string;
	status: "running" | "done" | "error";
	summary?: string;
	nodes: WorkflowNode[];
	createdAt: number;
}

/**
 * Persists workflow runs (the journal) in IndexedDB. v1 stores for display/history;
 * skip-completed resume is a later phase.
 */
export class WorkflowRunsStore extends Store {
	getConfig(): StoreConfig {
		return { name: "workflow-runs" };
	}

	async get(id: string): Promise<WorkflowRun | null> {
		return this.getBackend().get<WorkflowRun>("workflow-runs", id);
	}

	async save(run: WorkflowRun): Promise<void> {
		await this.getBackend().set("workflow-runs", run.id, run);
	}

	async delete(id: string): Promise<void> {
		await this.getBackend().delete("workflow-runs", id);
	}

	async list(): Promise<WorkflowRun[]> {
		const keys = await this.getBackend().keys("workflow-runs");
		const runs = await Promise.all(keys.map((k) => this.getBackend().get<WorkflowRun>("workflow-runs", k)));
		return runs.filter((r): r is WorkflowRun => r !== null).sort((a, b) => b.createdAt - a.createdAt);
	}
}
