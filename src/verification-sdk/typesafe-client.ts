import { deadlineSignal } from "./deadline.js";
import type { VerificationTelemetryRecorder } from "./telemetry.js";

export interface TypesafeConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
}

export interface VisionQuestion {
	type: "choice" | "noul";
	instructions: string;
	criteria?: Record<string, string>;
}

export interface VisionAnswer {
	type: "choice" | "noul";
	choice?: string;
	probabilities?: Record<string, number>;
	noul?: number;
}

export interface VisionResponse {
	model: string;
	answers: Record<string, VisionAnswer>;
	usage: { input_tokens: number | null; output_tokens: number | null };
}

export interface VisionCallTrace {
	recorder: VerificationTelemetryRecorder;
	callId: string;
	stage?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Validate remote output before it can influence coordinates or input. */
export function parseVisionResponse(value: unknown, questions: Record<string, VisionQuestion>): VisionResponse {
	if (!isRecord(value) || typeof value.model !== "string" || !isRecord(value.answers))
		throw new Error("Invalid Typesafe response");
	const answers: Record<string, VisionAnswer> = {};
	for (const [id, question] of Object.entries(questions)) {
		const answer = value.answers[id];
		if (!isRecord(answer) || answer.type !== question.type)
			throw new Error("Typesafe answer type does not match the question");
		if (question.type === "noul") {
			if (!probability(answer.noul)) throw new Error("Invalid Typesafe match probability");
			answers[id] = { type: "noul", noul: answer.noul };
		} else {
			const options = Object.keys(question.criteria ?? {});
			if (typeof answer.choice !== "string" || !options.includes(answer.choice) || !isRecord(answer.probabilities))
				throw new Error("Invalid Typesafe choice");
			const probabilities: Record<string, number> = {};
			for (const option of options) {
				const p = answer.probabilities[option];
				if (!probability(p)) throw new Error("Invalid Typesafe choice probability");
				probabilities[option] = p;
			}
			if (
				Object.keys(answer.probabilities).length !== options.length ||
				Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.05 ||
				Object.values(probabilities).some((p) => p > probabilities[answer.choice as string])
			)
				throw new Error("Inconsistent Typesafe probability distribution");
			answers[id] = { type: "choice", choice: answer.choice, probabilities };
		}
	}
	const usage = isRecord(value.usage) ? value.usage : {};
	return {
		model: value.model,
		answers,
		usage: {
			input_tokens:
				typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens) ? usage.input_tokens : null,
			output_tokens:
				typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens)
					? usage.output_tokens
					: null,
		},
	};
}

/** No automatic retries: the challenge has one shared deadline, including clicks. */
export async function askTypesafe(
	config: TypesafeConfig,
	images: Record<string, Blob>,
	questions: Record<string, VisionQuestion>,
	deadline: number,
	signal?: AbortSignal,
	trace?: VisionCallTrace,
): Promise<VisionResponse> {
	signal?.throwIfAborted();
	const startedAtMs = performance.now();
	const remaining = deadline - performance.now() - 1_500;
	if (remaining <= 0) throw new Error("Recognition deadline reached; input time was reserved");
	const state: Record<string, string> = {};
	const assets: Record<string, { type: "image"; part: string }> = {};
	const form = new FormData();
	for (const name of Object.keys(images)) {
		const id = crypto.randomUUID();
		state[name] = id;
		assets[id] = { type: "image", part: name };
	}
	const transportRequest = { model: config.model, state, assets, questions };
	trace?.recorder.event("transport_request", {
		callId: trace.callId,
		stage: trace.stage,
		request: transportRequest,
		budgetRemainingMs: Math.round(deadline - performance.now()),
		assetCount: Object.keys(images).length,
		questionCount: Object.keys(questions).length,
	});
	form.append("request", new Blob([JSON.stringify(transportRequest)], { type: "application/json" }));
	for (const [name, blob] of Object.entries(images)) form.append(name, blob, `${name}.png`);
	const base = new URL(config.baseUrl);
	if (
		base.protocol !== "https:" ||
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		base.pathname !== "/"
	)
		throw new Error("Typesafe requires an HTTPS API origin");
	const timeout = deadlineSignal(
		deadline - 1_500,
		"Typesafe request exhausted the remaining recognition budget",
		signal,
	);
	const requestSignal = timeout.signal;
	try {
		requestSignal.throwIfAborted();
		const response = await fetch(new URL("/v1/systemone", base), {
			method: "POST",
			headers: { Authorization: `Bearer ${config.apiKey}`, "TypeSafe-Danger-Zone-Images": "true" },
			body: form,
			signal: requestSignal,
			redirect: "error",
			credentials: "omit",
		});
		const ttfbMs = performance.now() - startedAtMs;
		const body = await response.text();
		const downloadMs = performance.now() - startedAtMs - ttfbMs;
		trace?.recorder.event("transport_response", {
			callId: trace.callId,
			stage: trace.stage,
			status: response.status,
			statusText: response.statusText,
			url: response.url,
			headers: Object.fromEntries(response.headers.entries()),
			ttfbMs: Math.round(ttfbMs),
			downloadMs: Math.round(downloadMs),
			totalMs: Math.round(ttfbMs + downloadMs),
			budgetRemainingMs: Math.round(deadline - performance.now()),
		});
		trace?.recorder.text(`transport/${trace.callId}/response.txt`, body, "text/plain", { callId: trace.callId });
		if (!response.ok) throw new Error(`Typesafe HTTP ${response.status}; no request was retried`);
		const value: unknown = JSON.parse(body);
		requestSignal.throwIfAborted();
		return parseVisionResponse(value, questions);
	} catch (error) {
		trace?.recorder.event("transport_failure", {
			callId: trace.callId,
			stage: trace.stage,
			message: error instanceof Error ? error.message : String(error),
			elapsedMs: Math.round(performance.now() - startedAtMs),
			budgetRemainingMs: Math.round(deadline - performance.now()),
		});
		if (requestSignal.aborted) throw requestSignal.reason;
		throw error;
	} finally {
		timeout.dispose();
	}
}
