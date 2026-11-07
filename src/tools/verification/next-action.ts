import type { InteractionResult, Point } from "./interaction.js";

export interface VerificationNextAction {
	action:
		| "click_and_verify"
		| "inspect_matches"
		| "inspect_markers"
		| "verify_submission"
		| "inspect_changed_challenge"
		| "report_failure"
		| "continue_task";
	instruction: string;
	targets?: Point[];
}

const clickInstruction =
	"Recheck a fresh screenshot, the current tab, and frame geometry. Use previous coordinates only if the challenge and geometry still match; otherwise discard them. With user-authorized interaction and a confirmed reference order, click the targets in order using native mouse input. Check that each numbered marker appears before the next click. Once all markers are confirmed, click OK once and inspect the result for explicit success, failure, or a changed challenge. A dispatched click is not proof of acceptance. Do not repeat an uncertain click or submission.";

/** Instructions must follow observed input state so the agent cannot duplicate a click. */
export function verificationNextAction(
	targets: Point[] | undefined,
	interaction?: InteractionResult,
): VerificationNextAction {
	if (interaction?.status === "success")
		return {
			action: "continue_task",
			instruction:
				"Verification success was observed. Do not click the targets or OK again. Recheck the page and continue the original task.",
		};
	if (interaction?.status === "failure")
		return {
			action: "report_failure",
			instruction:
				"Verification failure was observed. Report the failure and preserve the current page. Do not repeat the sequence, submit again, or refresh automatically.",
		};
	if (interaction?.status === "changed")
		return {
			action: "inspect_changed_challenge",
			instruction:
				"The challenge or tab changed. Discard every previous coordinate. Capture the current state and ask for help with the changed challenge; do not reuse or submit the previous sequence.",
		};
	if (interaction?.submissionAttempted)
		return {
			action: "verify_submission",
			instruction:
				"OK was already attempted. Do not click it again. Capture fresh evidence and inspect the page for explicit success, failure, or a changed challenge. Report an unresolved outcome if the result remains unclear.",
		};
	if (
		interaction &&
		(interaction.acknowledged > 0 ||
			interaction.events?.some(
				(event) =>
					event.event === "input_started" ||
					event.event === "input_dispatched" ||
					event.event === "input_uncertain",
			))
	)
		return {
			action: "inspect_markers",
			instruction:
				"Mouse input has already started. Preserve the selections and inspect a fresh screenshot for numbered markers. Ask a focused question about any missing acknowledgement. Do not repeat a click or press OK while the selected state is unresolved.",
		};
	if (targets?.length && !interaction)
		return {
			action: "click_and_verify",
			instruction: `Recognition checks passed; this analysis call sent no clicks. ${clickInstruction}`,
			targets,
		};
	return {
		action: "inspect_matches",
		instruction: `The tool sent no clicks. Inspect a fresh screenshot and compare each reference with the proposed candidates. Try to resolve the matches visually. If every target is clear, proceed with the authorized clicks and verify the outcome. ${clickInstruction} If a target remains ambiguous, ask the user to confirm that specific symbol or position instead of immediately handing off the whole challenge. Low model confidence is a recognition limit, not a ban on mouse clicks.`,
	};
}
