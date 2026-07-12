import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { type Static, Type } from "@earendil-works/pi-ai";
import {
	registerToolRenderer,
	SandboxIframe,
	type SandboxRuntimeProvider,
	type ToolRenderer,
	type ToolRenderResult,
} from "@earendil-works/pi-web-ui";
import { html } from "lit";
import { WORKFLOW_TOOL_DESCRIPTION } from "../../prompts/workflow-prompts.js";
import type { WorkflowRunsStore } from "../../storage/stores/workflow-runs-store.js";
import type { SpawnSubagent } from "./subagent-runner.js";
import { wfDebug } from "./workflow-debug-bus.js";
import { activeRuns, WorkflowRunBus } from "./workflow-run-bus.js";
import { WorkflowRuntimeProvider } from "./workflow-runtime-provider.js";
import "../../components/WorkflowProgressPanel.js"; // registers <workflow-progress-panel>

// Multi-agent orchestration routinely exceeds the sandbox's default 120s execute
// cap, so the workflow tool passes a generous ceiling (still catches true hangs).
const WORKFLOW_TIMEOUT_MS = 30 * 60 * 1000;

const workflowSchema = Type.Object({
	title: Type.String({ description: "Short title for this workflow run." }),
	script: Type.String({ description: "JavaScript orchestration script (see tool description)." }),
	args: Type.Optional(Type.Any()),
});

interface WorkflowToolResult {
	runId: string;
}

export function createWorkflowTool(): AgentTool<typeof workflowSchema, WorkflowToolResult> & {
	spawnSubagent?: SpawnSubagent;
	sandboxUrlProvider?: () => string;
	storeProvider?: () => WorkflowRunsStore | undefined;
	runtimeProvidersFactory?: () => SandboxRuntimeProvider[];
} {
	const tool: AgentTool<typeof workflowSchema, WorkflowToolResult> & {
		spawnSubagent?: SpawnSubagent;
		sandboxUrlProvider?: () => string;
		storeProvider?: () => WorkflowRunsStore | undefined;
		runtimeProvidersFactory?: () => SandboxRuntimeProvider[];
	} = {
		label: "Workflow",
		name: "workflow",
		get description() {
			return WORKFLOW_TOOL_DESCRIPTION;
		},
		parameters: workflowSchema,
		spawnSubagent: undefined,
		sandboxUrlProvider: undefined,
		storeProvider: undefined,
		runtimeProvidersFactory: undefined,
		execute: async function (_toolCallId: string, args: Static<typeof workflowSchema>, signal?: AbortSignal) {
			if (!this.spawnSubagent) {
				throw new Error("workflow tool not wired: spawnSubagent missing");
			}
			const runId = `wf-${Date.now()}`;
			const run = {
				id: runId,
				title: args.title || "workflow",
				status: "running" as const,
				nodes: [],
				createdAt: Date.now(),
			};
			const bus = new WorkflowRunBus(run, this.storeProvider?.());
			activeRuns.set(runId, bus);
			wfDebug(`run ${runId} start · "${run.title}" · script ${args.script.length} chars`);

			// Log exactly what was injected + flag placeholder-looking args so misuse
			// (the "PLACEHOLDER"-instead-of-real-data mistake) is loud, not cryptic.
			const argReport = inspectArgs(args.args);
			for (const l of argReport.log) wfDebug(`arg ${l}`);
			for (const w of argReport.warnings) {
				wfDebug(w, "error");
				bus.log(`⚠ ${w}`);
			}

			const provider = new WorkflowRuntimeProvider(this.spawnSubagent, bus, args.args);
			// Extra providers (e.g. read/write artifact access) so the script can pull
			// real data via getArtifact()/listArtifacts() instead of inlining it.
			const providers = [provider, ...(this.runtimeProvidersFactory?.() ?? [])];
			const sandbox = new SandboxIframe();
			if (this.sandboxUrlProvider) sandbox.sandboxUrlProvider = this.sandboxUrlProvider;
			// The sandbox element must be connected to the document or its iframe
			// never loads (detached iframes don't navigate) — mirror the REPL tool.
			sandbox.style.display = "none";
			document.body.appendChild(sandbox);
			try {
				wfDebug("sandbox.execute() → running orchestration script");
				const result = await sandbox.execute(runId, args.script, providers, [], signal, false, WORKFLOW_TIMEOUT_MS);
				if (result.success) {
					wfDebug(`sandbox done · returnValue: ${stringify(result.returnValue).slice(0, 120)}`);
					bus.finish("done", stringify(result.returnValue));
				} else {
					wfDebug(`sandbox FAILED · ${result.error?.message ?? "unknown"}`, "error");
					bus.finish("error", buildErrorHint(result.error, args.args, argReport.warnings));
				}
			} finally {
				sandbox.remove();
			}
			let text = summarize(bus);
			if (bus.run.status !== "error" && argReport.warnings.length) {
				text += `\n⚠ Possible placeholder args detected: ${argReport.warnings.join("; ")}`;
			}
			return { content: [{ type: "text", text }], details: { runId } };
		},
	};
	return tool;
}

function stringify(v: unknown): string {
	if (v === undefined || v === null) return "";
	if (typeof v === "string") return v;
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

const PLACEHOLDER_RE =
	/PLACEHOLDER|<[^>]*(paste|your|insert|todo|fill)[^>]*>|YOUR_[A-Z]|\bTODO\b|\bFIXME\b|^\.\.\.$|paste[_ ]?(here|content)|fill[_ ]?in/i;

// Summarize what was injected as `args` and flag values that look like unfilled
// placeholders (the classic "I'll swap this later" mistake that never happens).
function inspectArgs(a: unknown): { log: string[]; warnings: string[] } {
	const log: string[] = [];
	const warnings: string[] = [];
	const flag = (label: string, s: string) => {
		if (PLACEHOLDER_RE.test(s)) warnings.push(`${label} looks like a placeholder: "${s.slice(0, 40)}"`);
	};
	if (a === null || a === undefined) {
		log.push("args: (none passed)");
		return { log, warnings };
	}
	if (typeof a !== "object") {
		const s = String(a);
		log.push(`args: ${typeof a} (${s.length} chars)`);
		flag("args", s);
		return { log, warnings };
	}
	for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
		const size = (() => {
			try {
				return JSON.stringify(v)?.length ?? 0;
			} catch {
				return 0;
			}
		})();
		log.push(`${k}: ${size} bytes`);
		if (typeof v === "string") flag(k, v);
		else if (Array.isArray(v))
			v.forEach((e, i) => {
				if (typeof e === "string") flag(`${k}[${i}]`, e);
			});
	}
	return { log, warnings };
}

// Turn a bare sandbox error into an actionable hint for the model: the raw
// message + stack, what args were actually available, and a defensive-parsing
// reminder (most failures are .split()/JSON.parse on undefined agent() output).
function buildErrorHint(
	error: { message?: string; stack?: string } | undefined,
	args: unknown,
	warnings: string[],
): string {
	const lines = [`Workflow script error: ${error?.message ?? "unknown"}`];
	if (args === null || args === undefined) {
		lines.push(
			'args was null — nothing was injected. Pass the real data via the tool\'s "args" parameter and read it as the global "args" (or use getArtifact(name)).',
		);
	} else if (typeof args === "object") {
		lines.push(`Available args keys: ${Object.keys(args as object).join(", ") || "(empty object)"}`);
	}
	if (warnings.length) lines.push(`Placeholder warning: ${warnings.join("; ")}`);
	lines.push(
		"Reminder: agent() returns an arbitrary string — guard before .split()/JSON.parse and handle empty output.",
	);
	if (error?.stack) lines.push(`Stack:\n${error.stack.slice(0, 600)}`);
	return lines.join("\n");
}

function summarize(bus: WorkflowRunBus): string {
	const { run } = bus;
	const agents = run.nodes.filter((n) => n.kind === "agent");
	const done = agents.filter((n) => n.state === "done").length;
	const failed = agents.filter((n) => n.state === "error").length;
	const lines = [
		`Workflow "${run.title}" ${run.status} — ${done}/${agents.length} agents ok${failed ? `, ${failed} failed` : ""}.`,
	];
	if (run.summary) lines.push(`Result: ${run.summary.slice(0, 4000)}`);
	return lines.join("\n");
}

const workflowRenderer: ToolRenderer<Static<typeof workflowSchema>, WorkflowToolResult> = {
	render(
		params: Static<typeof workflowSchema> | undefined,
		result: ToolResultMessage<WorkflowToolResult> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const runId = result?.details?.runId;
		if (runId) {
			return { content: html`<workflow-progress-panel .runId=${runId}></workflow-progress-panel>`, isCustom: true };
		}
		const title = params?.title ?? "workflow";
		return {
			content: html`<div data-testid="workflow-panel" data-status="running" class="text-sm text-muted-foreground">
				${isStreaming ? "Preparing" : "Running"} workflow: ${title}…
			</div>`,
			isCustom: true,
		};
	},
};

registerToolRenderer("workflow", workflowRenderer);
