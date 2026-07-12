import type { SandboxRuntimeProvider } from "@earendil-works/pi-web-ui";
import type { SpawnSubagent, SubagentSpec } from "./subagent-runner.js";
import type { WorkflowRunBus } from "./workflow-run-bus.js";

// Long-poll window: each sandbox->host round-trip must stay under the bridge's
// timeout (RuntimeMessageBridge injects 30s), so agent() polls in <=15s slices.
const POLL_WINDOW_MS = 15_000;
// Concurrency cap for parallel() sub-agents.
const DEFAULT_CONCURRENCY = 3;

/**
 * Exposes the workflow script API (agent/parallel/phase/log/args) inside the
 * SandboxIframe and dispatches its messages to real pi sub-agents on the host.
 *
 * agent() is NON-BLOCKING at the transport layer: wf:agent-start returns a runId
 * immediately, then the script long-polls wf:agent-poll (each <30s) until done.
 * This sidesteps the 30s per-message bridge timeout for multi-minute sub-agent
 * runs without blocking a single round-trip. The overall run is bounded only by
 * the SandboxIframe execute() timeout, which the workflow tool raises.
 */
export class WorkflowRuntimeProvider implements SandboxRuntimeProvider {
	private counter = 0;
	private running = new Map<string, Promise<{ result?: string; error?: string }>>();
	private active = 0;
	private waiters: Array<() => void> = [];

	constructor(
		private spawn: SpawnSubagent,
		private bus: WorkflowRunBus,
		private args: unknown,
		private concurrency = DEFAULT_CONCURRENCY,
	) {}

	getData(): Record<string, any> {
		return { workflowArgs: this.args ?? null };
	}

	getRuntime(): (sandboxId: string) => void {
		// Stringified + injected — must not reference outer scope.
		return (_sandboxId: string) => {
			const send = (window as any).sendRuntimeMessage as (m: any) => Promise<any>;
			(window as any).args = (window as any).workflowArgs ?? null;
			(window as any).log = (msg: any, data?: any) =>
				send({ type: "wf:log", msg: String(msg), data: data === undefined ? null : data });
			(window as any).phase = (name: any) => send({ type: "wf:phase", name: String(name) });
			(window as any).agent = async (prompt: any, opts?: any) => {
				const spec = typeof prompt === "string" ? { prompt, ...(opts || {}) } : prompt;
				const started = await send({ type: "wf:agent-start", spec });
				const runId = started.runId;
				while (true) {
					const r = await send({ type: "wf:agent-poll", runId });
					if (r.done) {
						if (r.error) throw new Error(r.error);
						return r.result;
					}
				}
			};
			(window as any).parallel = (thunks: Array<() => Promise<any>>) => Promise.all((thunks || []).map((t) => t()));
		};
	}

	async handleMessage(message: any, respond: (response: any) => void): Promise<void> {
		switch (message?.type) {
			case "wf:log":
				this.bus.log(message.msg, message.data);
				respond({ success: true });
				return;
			case "wf:phase":
				this.bus.phase(message.name);
				respond({ success: true });
				return;
			case "wf:agent-start": {
				const runId = `a${++this.counter}`;
				const spec = message.spec as SubagentSpec;
				const label = (spec?.prompt || "agent").slice(0, 80);
				this.bus.agentStart(runId, label, spec?.tier, spec?.model?.id);
				const p = this.withLimit(async () => {
					try {
						const res = await this.spawn(spec);
						this.bus.agentDone(runId, res.text, res.usage);
						return { result: res.text };
					} catch (e) {
						const err = e instanceof Error ? e.message : String(e);
						this.bus.agentError(runId, err);
						return { error: err };
					}
				});
				this.running.set(runId, p);
				respond({ success: true, runId });
				return;
			}
			case "wf:agent-poll": {
				const p = this.running.get(message.runId);
				if (!p) {
					respond({ success: true, done: true, error: "unknown runId" });
					return;
				}
				const PENDING = Symbol("pending");
				const winner = await Promise.race([
					p,
					new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), POLL_WINDOW_MS)),
				]);
				if (winner === PENDING) {
					respond({ success: true, done: false });
				} else {
					this.running.delete(message.runId);
					respond({ success: true, done: true, result: (winner as any).result, error: (winner as any).error });
				}
				return;
			}
			// Non-wf messages belong to other providers; do not respond.
		}
	}

	getDescription(): string {
		return "";
	}

	// Counting semaphore so parallel() cannot spawn unbounded sub-agents.
	private async withLimit<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.concurrency) {
			await new Promise<void>((r) => this.waiters.push(r));
		}
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			this.waiters.shift()?.();
		}
	}
}
