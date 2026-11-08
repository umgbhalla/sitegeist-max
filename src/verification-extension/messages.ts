import type { VerificationDetails } from "../verification-sdk/index.js";

export const COMPLETE_MESSAGE = "jev-verification:complete";
export const EXPORT_MESSAGE = "jev-verification:export-runs";
export const LABEL_MESSAGE = "jev-verification:label-run";
export const SHOW_RECORDINGS_MESSAGE = "jev-verification:show-recordings";

export type CompletionResponse =
	| { ok: true; details: VerificationDetails }
	| {
			ok: false;
			error: string;
			elapsedMs?: number;
			phase?: "setup" | "verification";
			budget?: VerificationDetails["budget"];
			telemetry?: VerificationDetails["telemetry"];
	  };

export function isCompletionResponse(value: unknown): value is CompletionResponse {
	if (typeof value !== "object" || value === null || !("ok" in value)) return false;
	return value.ok === true
		? "details" in value
		: value.ok === false && "error" in value && typeof value.error === "string";
}
