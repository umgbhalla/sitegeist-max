import { completeVerification } from "./completion.js";
import { VisionResponseCache } from "./response-cache.js";
import { VerificationTelemetryRecorder } from "./telemetry.js";
import { VerificationTelemetryStore } from "./telemetry-store.js";
import type { TypesafeConfig } from "./typesafe-client.js";
import { runVerification, type VerificationDetails, type VerificationParams } from "./workflow.js";

export { VERIFICATION_BUDGET } from "./budget.js";
export { VerificationCompletionError } from "./completion.js";
export { verificationTelemetryReference } from "./telemetry.js";
export type { TelemetryLabel, TelemetryReference, TelemetryRun, TelemetryRunSummary } from "./telemetry-store.js";
export { TELEMETRY_RETENTION, VerificationTelemetryStore } from "./telemetry-store.js";
export type { TypesafeConfig } from "./typesafe-client.js";
export type { VerificationDetails, VerificationParams } from "./workflow.js";

export interface VerificationRequest extends VerificationParams {
	windowId: number;
	tabId?: number;
	signal?: AbortSignal;
}

export interface VerificationClientOptions {
	loadConfig?: () => Promise<TypesafeConfig | undefined>;
	telemetry?: boolean | (() => Promise<boolean>);
}

/** Chrome extension SDK. Each client owns its response cache; input is never cached. */
export class VerificationClient {
	private readonly cache = new VisionResponseCache();
	readonly telemetry = new VerificationTelemetryStore();

	constructor(private readonly options: VerificationClientOptions = {}) {}

	async verify(request: VerificationRequest): Promise<VerificationDetails> {
		const { windowId, tabId, signal, ...args } = request;
		const enabled =
			typeof this.options.telemetry === "function"
				? await this.options.telemetry()
				: this.options.telemetry !== false;
		const telemetry = !enabled
			? undefined
			: new VerificationTelemetryRecorder(this.telemetry, {
					windowId,
					tabId,
					method: args.method ?? "jev",
					attempt: args.attempt ?? true,
					count: args.count,
					reference: args.reference,
					scene: args.scene,
				});
		telemetry?.checkpoint();
		const captureTelemetry = typeof indexedDB === "undefined" ? undefined : telemetry;
		const loadConfig = async () => {
			const config = await this.options.loadConfig?.();
			if (config) {
				telemetry?.protect(config.apiKey);
				telemetry?.event("model_config", { model: config.model, baseUrl: config.baseUrl });
			}
			return config;
		};
		try {
			const details =
				(args.attempt ?? true) && (args.method ?? "jev") === "jev" && !args.reference
					? await completeVerification(windowId, args, signal, tabId, {
							cache: this.cache,
							loadConfig,
							telemetry: captureTelemetry,
						})
					: await runVerification(windowId, args, signal, {
							policy: "best-effort",
							tabId,
							cache: this.cache,
							loadConfig,
							telemetry: captureTelemetry,
						});
			if (telemetry) details.telemetry = await telemetry.finish(details);
			return details;
		} catch (error) {
			if (telemetry) {
				const reference = await telemetry.finish(undefined, error);
				if (error instanceof Error)
					try {
						Object.defineProperty(error, "telemetry", { value: reference, configurable: true });
					} catch {
						/* Preserve a frozen caller error; its recording remains in the local store. */
					}
			}
			throw error;
		}
	}

	clearCache(): void {
		this.cache.clear();
	}
}
