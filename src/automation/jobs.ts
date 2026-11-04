import { hash } from "./packets.js";
import { all, mutate, put, required } from "./store.js";

export interface SavedTool {
	id: string;
	name: string;
	description: string;
	source: string;
	version: string;
	updatedAt: number;
}
export interface Job {
	id: string;
	tool: SavedTool;
	args: unknown;
	status: "queued" | "running" | "done" | "error" | "cancelled";
	createdAt: number;
	updatedAt: number;
	progress?: unknown;
	result?: unknown;
	error?: string;
}
interface Step {
	id: string;
	jobId: string;
	key: string;
	status: "running" | "done" | "error";
	idempotent: boolean;
	attempts: number;
	owner: string;
	result?: unknown;
	error?: string;
}
export async function saveTool(options: { name: string; description: string; source: string }) {
	if (!/^[a-zA-Z][\w.-]{0,79}$/.test(options.name) || !options.source || options.source.length > 100000)
		throw new Error("Tool needs a valid name and function source (maximum 100 KB)");
	const version = await hash(new TextEncoder().encode(options.source));
	const tool: SavedTool = {
		name: options.name,
		description: options.description,
		source: options.source,
		id: options.name,
		version,
		updatedAt: Date.now(),
	};
	await put("tools", { ...tool, id: `${tool.name}@${version}` });
	return put("tools", tool);
}
export async function listTools() {
	return (await all<SavedTool>("tools")).filter((tool) => tool.id === tool.name).map(({ source: _, ...tool }) => tool);
}
export async function startJob(options: { tool: string; args: unknown }) {
	const tool = await required<SavedTool>("tools", options.tool);
	const job: Job = {
		id: crypto.randomUUID(),
		tool,
		args: options.args,
		status: "queued",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	await put("jobs", job);
	await schedule();
	return job;
}
let hostPromise: Promise<void> | undefined;
async function ensureHost() {
	hostPromise ??= (async () => {
		if (!(await chrome.offscreen.hasDocument()))
			await chrome.offscreen.createDocument({
				url: "automation-host.html",
				reasons: [chrome.offscreen.Reason.IFRAME_SCRIPTING],
				justification: "Run resumable browser automation in a sandbox while the side panel is closed",
			});
	})();
	try {
		await hostPromise;
	} finally {
		hostPromise = undefined;
	}
}
let scheduling = false;
export async function schedule() {
	if (scheduling) return;
	scheduling = true;
	try {
		const jobs = (await all<Job>("jobs")).filter((job) => job.status === "queued" || job.status === "running");
		if (!jobs.length) return;
		await ensureHost();
		for (const job of jobs) {
			const reply = await chrome.runtime.sendMessage({ type: "automation-host-run", job });
			if (!reply?.accepted) throw new Error("Automation host did not accept job");
		}
	} finally {
		scheduling = false;
	}
}
export async function updateJob(id: string, update: Partial<Pick<Job, "status" | "progress" | "result" | "error">>) {
	return mutate<Job>("jobs", id, (job) => {
		if (!job) throw new Error(`Job not found: ${id}`);
		if (job.status === "cancelled" && update.status !== "queued") return job;
		return { ...job, ...update, updatedAt: Date.now() };
	});
}
export async function cancelJob(id: string) {
	const job = await updateJob(id, { status: "cancelled" });
	await chrome.runtime.sendMessage({ type: "automation-host-cancel", id }).catch(() => undefined);
	return job;
}
export async function resumeJob(id: string) {
	const job = await required<Job>("jobs", id);
	if (job.status === "done") return job;
	await updateJob(id, { status: "queued", error: undefined });
	await schedule();
	return required<Job>("jobs", id);
}
export async function stepBegin(jobId: string, key: string, idempotent: boolean, owner: string) {
	const job = await required<Job>("jobs", jobId);
	if (job.status === "cancelled") throw new Error("Job cancelled");
	if (!key || key.length > 200 || !owner) throw new Error("Checkpoint key and execution owner are required");
	const id = `${jobId}:${key}`;
	const step = await mutate<Step>("steps", id, (previous) => {
		if (previous?.status === "done") return previous;
		if (previous?.status === "running" && previous.owner === owner)
			throw new Error(`Step ${key} is already running in this execution`);
		if (previous && (!previous.idempotent || !idempotent))
			throw new Error(
				`Step ${key} has an uncertain outcome; inspect it before using a new checkpoint key. It will not be repeated automatically.`,
			);
		return { id, jobId, key, status: "running", idempotent, attempts: (previous?.attempts ?? 0) + 1, owner };
	});
	if (step.status === "done") return { done: true, result: step.result };
	await updateJob(jobId, { progress: { step: key, state: "running", attempts: step.attempts } });
	return { done: false };
}
export async function stepEnd(jobId: string, key: string, result: unknown, error?: string, owner?: string) {
	const step = await required<Step>("steps", `${jobId}:${key}`);
	if (JSON.stringify(result ?? null).length > 2_000_000)
		throw new Error("Checkpoint result too large; save data into a packet and return file references");
	await mutate<Step>("steps", step.id, (current) => {
		if (!current || current.owner !== owner) throw new Error("Checkpoint execution owner changed");
		if (current.status === "done") return current;
		return { ...current, status: error ? "error" : "done", result, error };
	});
	await updateJob(jobId, { progress: { step: key, state: error ? "error" : "done" } });
	return { saved: true };
}
