import { fetchDownload } from "./downloads.js";
import {
	cancelJob,
	type Job,
	listTools,
	resumeJob,
	saveTool,
	schedule,
	startJob,
	stepBegin,
	stepEnd,
	updateJob,
} from "./jobs.js";
import {
	type Capture,
	listResponses,
	networkEvent,
	replayResponse,
	responseBody,
	saveResponse,
	startCapture,
	stopCapture,
} from "./network.js";
import { exportPacket, fileInfo, listFiles, readFile, saveFile, validatePacket } from "./packets.js";
import { evaluate, navigate, pageContexts, request } from "./page.js";
import { screenshot } from "./screenshots.js";
import { appendSheetTabs, sheetsIdentity, startSheetsConnection } from "./sheets.js";
import { all, errorText, put, required } from "./store.js";

// Internal extension-only RPC. Page/user-script messages never enter this API.
export async function automationCall(op: string, args: Record<string, unknown>): Promise<unknown> {
	switch (op) {
		case "page.contexts":
			return pageContexts(Number(args.tabId));
		case "page.evaluate":
			return evaluate(args as unknown as Parameters<typeof evaluate>[0]);
		case "page.request":
			return request(args as unknown as Parameters<typeof request>[0]);
		case "page.navigate":
			return navigate(Number(args.tabId), String(args.url));
		case "net.start":
			return startCapture(args as unknown as Parameters<typeof startCapture>[0]);
		case "net.stop":
			return stopCapture(String(args.id));
		case "net.status":
			return required<Capture>("captures", String(args.id));
		case "net.list":
			return listResponses(String(args.id));
		case "net.body":
			return responseBody(String(args.id));
		case "net.save":
			return saveResponse(String(args.id), String(args.packet), String(args.name));
		case "net.replay":
			return replayResponse(String(args.id));
		case "files.write":
			return saveFile(
				String(args.packet),
				String(args.name),
				String(args.data),
				typeof args.mime === "string" ? args.mime : undefined,
				args.encoding === "base64" ? "base64" : "text",
			);
		case "files.list":
			return listFiles(String(args.packet));
		case "files.read":
			return readFile(String(args.packet), String(args.name));
		case "files.validate":
			return validatePacket(String(args.packet), args.expected as string[]);
		case "files.export":
			return exportPacket(String(args.packet), args.expected as string[]);
		case "screenshot":
			return screenshot(args as unknown as Parameters<typeof screenshot>[0]);
		case "downloads.fetch":
			return fetchDownload(args as unknown as Parameters<typeof fetchDownload>[0]);
		case "downloads.status": {
			const [download] = await chrome.downloads.search({ id: Number(args.id) });
			if (!download) throw new Error("Download not found");
			return {
				id: download.id,
				state: download.state,
				error: download.error,
				filename: download.filename,
				bytesReceived: download.bytesReceived,
				totalBytes: download.totalBytes,
			};
		}
		case "downloads.save": {
			const file = await readFile(String(args.packet), String(args.name));
			const id = await chrome.downloads.download({
				url: `data:${file.mime};base64,${file.base64}`,
				filename: file.name,
				saveAs: false,
				conflictAction: "uniquify",
			});
			return { downloadId: id, file: fileInfo(file) };
		}
		case "tools.save":
			return saveTool(args as unknown as Parameters<typeof saveTool>[0]);
		case "tools.list":
			return listTools();
		case "tools.get":
			return required("tools", String(args.name));
		case "jobs.start":
			return startJob({ tool: String(args.tool), args: args.args });
		case "jobs.get":
			return required<Job>("jobs", String(args.id));
		case "jobs.list":
			return (await all<Job>("jobs")).map(({ args: _, result: _result, tool, ...job }) => ({
				...job,
				tool: { name: tool.name, version: tool.version },
			}));
		case "jobs.steps":
			return (await all<{ id: string; jobId: string }>("steps")).filter((step) => step.jobId === args.id);
		case "jobs.cancel":
			return cancelJob(String(args.id));
		case "jobs.resume":
			return resumeJob(String(args.id));
		case "jobs.update":
			return updateJob(String(args.id), {
				...(typeof args.status === "string" &&
				["queued", "running", "done", "error", "cancelled"].includes(args.status)
					? { status: args.status as Job["status"] }
					: {}),
				...(Object.hasOwn(args, "progress") ? { progress: args.progress } : {}),
				...(Object.hasOwn(args, "result") ? { result: args.result } : {}),
				...(typeof args.error === "string" ? { error: args.error } : {}),
			});
		case "jobs.progress":
			return updateJob(String(args.jobId), { progress: args.progress });
		case "jobs.stepBegin":
			return stepBegin(String(args.jobId), String(args.key), args.idempotent === true, String(args.owner ?? ""));
		case "jobs.stepEnd":
			return stepEnd(
				String(args.jobId),
				String(args.key),
				args.result,
				typeof args.error === "string" ? args.error : undefined,
				String(args.owner ?? ""),
			);
		case "sheets.connect":
			return startSheetsConnection(String(args.clientId), String(args.expectedEmail));
		case "sheets.identity":
			return sheetsIdentity();
		case "sheets.appendTabs":
			return appendSheetTabs(args as unknown as Parameters<typeof appendSheetTabs>[0]);
		default:
			throw new Error(`Unknown automation operation: ${op}`);
	}
}
export function installAutomationService() {
	chrome.runtime.onMessage.addListener((message, sender, respond) => {
		if (message?.type !== "automation") return;
		if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
			respond({ ok: false, error: "Extension pages only" });
			return;
		}
		void automationCall(message.op, message.args ?? {}).then(
			(value) => respond({ ok: true, value }),
			(error) => respond({ ok: false, error: errorText(error) }),
		);
		return true;
	});
	chrome.debugger.onEvent.addListener(networkEvent);
	chrome.debugger.onDetach.addListener((source) => {
		void all<Capture>("captures").then(async (captures) => {
			for (const capture of captures.filter((c) => c.active && c.tabId === source.tabId))
				await put("captures", {
					...capture,
					active: false,
					error: "Debugger detached; start a new capture before continuing",
				});
		});
	});
	chrome.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === "automation-resume") void schedule().catch(console.error);
	});
	chrome.runtime.onStartup.addListener(() => {
		void schedule().catch(console.error);
	});
	void chrome.alarms.create("automation-resume", { periodInMinutes: 0.5 });
	void schedule().catch(console.error);
}
