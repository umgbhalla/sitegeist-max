import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { type Static, Type } from "@earendil-works/pi-ai";
import {
	registerToolRenderer,
	SandboxIframe,
	type ToolRenderer,
	type ToolRenderResult,
} from "@earendil-works/pi-web-ui";
import { html } from "lit";
import { WORKFLOW_TOOL_DESCRIPTION } from "../../prompts/workflow-prompts.js";
import type { WorkflowRunsStore } from "../../storage/stores/workflow-runs-store.js";
import type { SpawnSubagent } from "./subagent-runner.js";
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
} {
	const tool: AgentTool<typeof workflowSchema, WorkflowToolResult> & {
		spawnSubagent?: SpawnSubagent;
		sandboxUrlProvider?: () => string;
		storeProvider?: () => WorkflowRunsStore | undefined;
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

			const provider = new WorkflowRuntimeProvider(this.spawnSubagent, bus, args.args);
			const sandbox = new SandboxIframe();
			if (this.sandboxUrlProvider) sandbox.sandboxUrlProvider = this.sandboxUrlProvider;
			// The sandbox element must be connected to the document or its iframe
			// never loads (detached iframes don't navigate) — mirror the REPL tool.
			sandbox.style.display = "none";
			document.body.appendChild(sandbox);
			try {
				const result = await sandbox.execute(
					runId,
					args.script,
					[provider],
					[],
					signal,
					false,
					WORKFLOW_TIMEOUT_MS,
				);
				if (result.success) {
					bus.finish("done", stringify(result.returnValue));
				} else {
					bus.finish("error", result.error?.message ?? "workflow failed");
				}
			} finally {
				sandbox.remove();
			}
			return { content: [{ type: "text", text: summarize(bus) }], details: { runId } };
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
