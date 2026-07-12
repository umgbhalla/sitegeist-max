// Live debug event bus for workflow runs. Every stage of the workflow path
// (tool execute, sandbox messages, sub-agent lifecycle) calls wfDebug() so the
// WorkflowDebugLog panel can show what's happening in real time — the workflow
// tool is otherwise opaque while execute() is in flight ("Preparing workflow…").

export type WfDebugLevel = "info" | "warn" | "error";
export interface WfDebugEntry {
	t: number;
	level: WfDebugLevel;
	msg: string;
}

const MAX = 300;
const buffer: WfDebugEntry[] = [];

export const workflowDebugBus = new EventTarget();

export function wfDebug(msg: string, level: WfDebugLevel = "info"): void {
	const entry: WfDebugEntry = { t: Date.now(), level, msg };
	buffer.push(entry);
	if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
	try {
		workflowDebugBus.dispatchEvent(new CustomEvent("log", { detail: entry }));
	} catch {
		// no listener / detached — buffer still holds it
	}
	// Mirror to devtools console too.
	const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.debug;
	sink("[workflow]", msg);
}

export function getWfDebugLog(): WfDebugEntry[] {
	return buffer;
}

export function clearWfDebugLog(): void {
	buffer.length = 0;
	workflowDebugBus.dispatchEvent(new CustomEvent("clear"));
}
