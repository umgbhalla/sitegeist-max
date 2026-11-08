import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import { loadTypesafeConfig } from "../../verification-config.js";
import { VerificationClient, type VerificationDetails } from "../../verification-sdk/index.js";

const verification = new VerificationClient({ loadConfig: loadTypesafeConfig });

const rectSchema = Type.Object({
	x: Type.Number(),
	y: Type.Number(),
	width: Type.Number(),
	height: Type.Number(),
});

const schema = Type.Object({
	method: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("shape"), Type.Literal("jev")], {
			default: "jev",
			description:
				"Omit to use Jev. Diagnostic overrides: shape uses local math only; auto allows local fallback when Jev is not configured",
		}),
	),
	reference: Type.Optional(
		Type.Object(
			{
				...rectSchema.properties,
			},
			{ description: "Bounding box of the reference strip in viewport CSS pixels" },
		),
	),
	scene: Type.Optional(
		Type.Object(rectSchema.properties, {
			description: "Bounding box of the challenge image in viewport CSS pixels",
		}),
	),
	count: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 8,
			description:
				"Omit to detect the number of individual reference icons. A combined reference strip defaults to three; override only if its count differs",
		}),
	),
	attempt: Type.Optional(
		Type.Boolean({
			default: true,
			description:
				"Omit to complete one challenge, including ordered clicks, submission and outcome verification. Set false only for analysis without input",
		}),
	),
});

type Params = Static<typeof schema>;

/** Complete one discovered Tencent challenge by default; diagnostics remain opt-in. */
export class VerificationShapeTool implements AgentTool<typeof schema, VerificationDetails> {
	name = "verification_shape_match";
	label = "Complete verification";
	description =
		"Complete the visible Tencent ordered-symbol verification for the user-authorized browser task. Call with {}: Jev is the default, a single reference strip means three symbols, and the tool clicks in order, confirms every marker, submits once, and verifies the outcome in one attempt, targeting ten seconds with a five-minute maximum. No method, count, or attempt argument is normally needed. The result reports its policy version and time budget. The shared completion policy uses exact-input caching, fast local proposals, batched Jev checks, and one budgeted comparison branch on disagreement. There are no confidence-score cutoffs; thresholds:null and accepted:true mean selected for an attempt, not proven correct. Only reference and scene crops are sent to Typesafe. Set attempt:false for analysis only; explicit bounds require analysis mode. Diagnostic method overrides remain optional. A changed, failed or uncertain result is unresolved, and input is never repeated automatically.";
	parameters = schema;
	windowId?: number;

	async execute(_id: string, args: Params = {}, signal?: AbortSignal): Promise<AgentToolResult<VerificationDetails>> {
		if (this.windowId === undefined) throw new Error("Browser window is unavailable");
		const details = await verification.verify({ ...args, windowId: this.windowId, signal });
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						...details,
						warning:
							"Scores are uncalibrated. Treat an uncertain or changed result as unresolved and do not repeat input automatically.",
					}),
				},
			],
			details,
		};
	}
}
