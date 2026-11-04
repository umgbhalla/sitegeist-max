import { SandboxIframe } from "@earendil-works/pi-web-ui";
import { BrowserRuntimeProvider } from "../tools/repl/browser/BrowserRuntimeProvider.js";
import { JobRuntimeProvider } from "./job-runtime.js";
import type { Job } from "./jobs.js";

const running = new Map<string, AbortController>();
const pending = new Set<string>();
let tail = Promise.resolve();
const update = (id: string, args: object) =>
	chrome.runtime.sendMessage({ type: "automation", op: "jobs.update", args: { id, ...args } });
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
	if (message.type === "automation-host-run") {
		const job = message.job as Job;
		if (!running.has(job.id) && !pending.has(job.id)) {
			pending.add(job.id);
			tail = tail
				.then(() => run(job))
				.catch((error) => update(job.id, { status: "error", error: String(error) }).then(() => undefined));
		}
		respond({ accepted: true });
	} else if (message.type === "automation-host-cancel") {
		running.get(message.id)?.abort();
		respond({ cancelled: true });
	}
});
async function run(job: Job) {
	pending.delete(job.id);
	const latest = await chrome.runtime.sendMessage({ type: "automation", op: "jobs.get", args: { id: job.id } });
	if (latest.value?.status === "cancelled" || latest.value?.status === "done") return;
	const controller = new AbortController();
	running.set(job.id, controller);
	const sandbox = new SandboxIframe();
	sandbox.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");
	document.body.appendChild(sandbox);
	try {
		await update(job.id, { status: "running" });
		const code = `return await (${job.tool.source})(${JSON.stringify(job.args ?? null)}, browser, job);`;
		const result = await sandbox.execute(
			`job-${job.id}`,
			code,
			[new BrowserRuntimeProvider(true), new JobRuntimeProvider(job.id)],
			[],
			controller.signal,
			false,
			24 * 60 * 60 * 1000,
		);
		await update(
			job.id,
			result.success
				? { status: "done", result: result.returnValue }
				: { status: "error", error: result.error?.message ?? "Background script failed" },
		);
	} finally {
		sandbox.remove();
		running.delete(job.id);
	}
}
