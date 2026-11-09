import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import { downloadVerificationTelemetry } from "../../verification-export.js";
import { VerificationTelemetryStore } from "../../verification-sdk/index.js";

const schema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("export"), Type.Literal("label"), Type.Literal("clear")]),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, description: "Maximum recent runs to list or export; defaults to all" }),
	),
	runIds: Type.Optional(
		Type.Array(Type.String(), { description: "Export these specific run IDs instead of the latest runs" }),
	),
	runId: Type.Optional(Type.String({ description: "Run to label with the user's observed outcome" })),
	outcome: Type.Optional(Type.Union([Type.Literal("success"), Type.Literal("failure"), Type.Literal("uncertain")])),
	notes: Type.Optional(Type.String()),
	correctTargets: Type.Optional(Type.Array(Type.Object({ x: Type.Number(), y: Type.Number() }))),
});

export class VerificationTelemetryTool implements AgentTool<typeof schema, Record<string, unknown>> {
	name = "verification_runs";
	label = "Verification recordings";
	description =
		"List or export locally recorded verification attempts, including analysis runs and failures, exact Jev images, sanitized iframe/scripts, timings and click evidence. Export downloads a calibration dataset without sending images into the chat. Defaults to all runs. Label only from the user's observed outcome/correct viewport coordinates; automatic success is recorded separately. Clear only when the user explicitly requests deleting recordings. This tool never clicks a challenge or retries an attempt.";
	parameters = schema;

	async execute(_id: string, args: Static<typeof schema>): Promise<AgentToolResult<Record<string, unknown>>> {
		const store = new VerificationTelemetryStore();
		let details: Record<string, unknown>;
		switch (args.action) {
			case "list":
				details = { runs: await store.listRuns(args.limit) };
				break;
			case "export":
				details = await downloadVerificationTelemetry({ runIds: args.runIds, limit: args.limit });
				break;
			case "label":
				if (!args.runId || !args.outcome) throw new Error("Provide runId and the user's observed outcome");
				await store.labelRun(args.runId, {
					outcome: args.outcome,
					notes: args.notes,
					correctTargets: args.correctTargets,
				});
				details = { runId: args.runId, labelled: true };
				break;
			case "clear":
				await store.clearRuns();
				details = { cleared: true };
				break;
		}
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	}
}
