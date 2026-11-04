import type { SandboxRuntimeProvider } from "@earendil-works/pi-web-ui";
export class JobRuntimeProvider implements SandboxRuntimeProvider {
	constructor(private id: string) {}
	getData() {
		return { __automationJobId: this.id, __automationOwner: crypto.randomUUID() };
	}
	getDescription() {
		return "job.step(key, async function, {idempotent:false,retries:0}) checkpoints a step. Only explicitly idempotent steps retry. job.progress(value) persists progress.";
	}
	getRuntime() {
		return () => {
			const scope = window as unknown as {
				__automationJobId: string;
				__automationOwner: string;
				browser: { automation: { call(op: string, args: object): Promise<unknown> } };
				job: unknown;
			};
			const call = (op: string, args: object) =>
				scope.browser.automation.call(op, {
					...args,
					jobId: scope.__automationJobId,
					owner: scope.__automationOwner,
				});
			scope.job = {
				progress: (progress: unknown) => call("jobs.progress", { progress }),
				step: async (
					key: string,
					fn: () => Promise<unknown>,
					options: { idempotent?: boolean; retries?: number } = {},
				) => {
					const retries = options.idempotent ? Math.min(Math.max(options.retries ?? 2, 0), 5) : 0;
					for (let attempt = 0; ; attempt++) {
						const state = (await call("jobs.stepBegin", { key, idempotent: options.idempotent === true })) as {
							done: boolean;
							result?: unknown;
						};
						if (state.done) return state.result;
						try {
							const result = await fn();
							await call("jobs.stepEnd", { key, result });
							return result;
						} catch (error) {
							await call("jobs.stepEnd", { key, error: error instanceof Error ? error.message : String(error) });
							if (attempt >= retries) throw error;
							await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 10000)));
						}
					}
				},
			};
		};
	}
}
