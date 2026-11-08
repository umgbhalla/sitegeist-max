import { VERIFICATION_BUDGET } from "./budget.js";
import type { BinaryImage, Rect } from "./shape.js";
import { redactTelemetryText, sanitizeTelemetry } from "./telemetry-redaction.js";
import type {
	StoredTelemetryAsset,
	TelemetryReference,
	TelemetryRun,
	VerificationTelemetryStore,
} from "./telemetry-store.js";

const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_RUN_BYTES = 16 * 1024 * 1024;

/** Local diagnostics only. Recording never changes the selected sequence or retries input. */
export class VerificationTelemetryRecorder {
	private readonly started = performance.now();
	private readonly secrets: string[] = [];
	private readonly assets: { id: string; role: string; blob: Blob; metadata?: unknown }[] = [];
	private readonly blobIds = new WeakMap<Blob, string>();
	private readonly hashes = new Map<Blob, Promise<string>>();
	private readonly pending: Promise<void>[] = [];
	private write = Promise.resolve();
	private stored = false;
	private bytes = 0;
	private eventBytes = 0;
	private finishStarted = 0;
	readonly run: TelemetryRun;

	constructor(
		private readonly store: VerificationTelemetryStore,
		request: unknown,
	) {
		let producer: TelemetryRun["producer"] = { name: "verification-sdk", version: "0.1.0" };
		try {
			if (typeof chrome !== "undefined" && chrome.runtime?.getManifest) {
				const manifest = chrome.runtime.getManifest();
				producer = { name: manifest.name, version: manifest.version, extensionId: chrome.runtime.id };
			}
		} catch {
			/* A disconnected extension context still receives a diagnostic record. */
		}
		this.run = {
			schemaVersion: 1,
			id: crypto.randomUUID(),
			startedAt: new Date().toISOString(),
			status: "running",
			producer,
			request: sanitizeTelemetry(request),
			events: [],
			assets: [],
			bytes: 0,
			warnings: [],
		};
		this.event("sdk_policy", {
			budget: VERIFICATION_BUDGET,
			userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
		});
	}

	protect(secret: string): void {
		if (secret) this.secrets.push(secret);
	}

	warn(message: string): void {
		const clean = redactTelemetryText(message, this.secrets);
		if (!this.run.warnings.includes(clean)) this.run.warnings.push(clean);
	}

	event(name: string, data?: unknown): void {
		const clean = sanitizeTelemetry(data, this.secrets);
		const bytes = JSON.stringify(clean)?.length ?? 0;
		if (this.run.events.length >= 3000 || bytes > 100_000 || this.eventBytes + bytes > 2 * 1024 * 1024) {
			this.warn(`Event omitted at size limit: ${name}`);
			return;
		}
		this.eventBytes += bytes;
		this.run.events.push({ atMs: Math.round(performance.now() - this.started), name, data: clean });
	}

	job(promise: Promise<void>): void {
		this.pending.push(
			promise.catch((error: unknown) => {
				this.warn(error instanceof Error ? error.message : "Diagnostic capture failed");
			}),
		);
	}

	asset(role: string, blob: Blob, metadata?: unknown): string | undefined {
		const existing = this.blobIds.get(blob);
		if (existing) return existing;
		if (blob.size > MAX_ASSET_BYTES || this.bytes + blob.size > MAX_RUN_BYTES) {
			this.warn(`Asset omitted at size limit: ${role}`);
			return undefined;
		}
		const id = `asset-${this.assets.length + 1}`;
		this.assets.push({ id, role, blob, metadata: sanitizeTelemetry(metadata, this.secrets) });
		this.blobIds.set(blob, id);
		this.bytes += blob.size;
		return id;
	}

	text(role: string, value: string, mime: string, metadata?: unknown): void {
		this.asset(role, new Blob([redactTelemetryText(value, this.secrets)], { type: mime }), metadata);
	}

	canvas(role: string, source: OffscreenCanvas, rect: Rect, metadata?: unknown): void {
		try {
			if (
				rect.width <= 0 ||
				rect.height <= 0 ||
				rect.x < 0 ||
				rect.y < 0 ||
				rect.x + rect.width > source.width ||
				rect.y + rect.height > source.height
			) {
				this.warn(`Image outside capture: ${role}`);
				return;
			}
			const crop = new OffscreenCanvas(rect.width, rect.height);
			const context = crop.getContext("2d");
			if (!context) {
				this.warn(`No image context: ${role}`);
				return;
			}
			context.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
			this.pending.push(
				crop
					.convertToBlob({ type: "image/png" })
					.then((blob) => {
						this.asset(role, blob, { rect, ...(metadata as Record<string, unknown>) });
					})
					.catch(() => {
						this.warn(`Image encoding failed: ${role}`);
					}),
			);
		} catch {
			this.warn(`Image capture failed: ${role}`);
		}
	}

	binary(role: string, image: BinaryImage, rect: Rect): void {
		try {
			const canvas = new OffscreenCanvas(rect.width, rect.height);
			const context = canvas.getContext("2d");
			if (!context) return;
			const pixels = context.createImageData(rect.width, rect.height);
			for (let y = 0; y < rect.height; y++)
				for (let x = 0; x < rect.width; x++) {
					const at = (y * rect.width + x) * 4;
					const value = image.pixels[(rect.y + y) * image.width + rect.x + x] ? 0 : 255;
					pixels.data.set([value, value, value, 255], at);
				}
			context.putImageData(pixels, 0, 0);
			this.canvas(role, canvas, { x: 0, y: 0, width: rect.width, height: rect.height }, { sourceRect: rect });
		} catch {
			this.warn(`Mask encoding failed: ${role}`);
		}
	}

	checkpoint(): void {
		void this.flush();
	}

	private flush(): Promise<void> {
		this.write = this.write
			.then(async () => {
				await Promise.all(this.pending);
				const storedAssets: StoredTelemetryAsset[] = [];
				this.run.assets = await Promise.all(
					this.assets.map(async (asset) => {
						let hash = this.hashes.get(asset.blob);
						if (!hash) {
							hash = asset.blob
								.arrayBuffer()
								.then((bytes) => crypto.subtle.digest("SHA-256", bytes))
								.then((bytes) =>
									Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""),
								);
							this.hashes.set(asset.blob, hash);
						}
						const sha256 = await hash;
						storedAssets.push({ sha256, blob: asset.blob });
						return {
							id: asset.id,
							sha256,
							role: asset.role,
							mime: asset.blob.type,
							bytes: asset.blob.size,
							metadata: asset.metadata,
						};
					}),
				);
				this.run.bytes = this.bytes;
				if (this.finishStarted) this.run.collectionMs = Math.round(performance.now() - this.finishStarted);
				const clean = sanitizeTelemetry(this.run, this.secrets) as TelemetryRun;
				clean.bytes += new Blob([JSON.stringify(clean)]).size;
				await this.store.saveRun(clean, storedAssets);
				this.stored = true;
			})
			.catch((error: unknown) => {
				this.stored = false;
				this.warn(error instanceof Error ? error.message : "Telemetry save failed");
			});
		return this.write;
	}

	async finish(result?: unknown, error?: unknown): Promise<TelemetryReference> {
		this.finishStarted = performance.now();
		this.run.finishedAt = new Date().toISOString();
		if (error !== undefined) {
			this.run.status = "error";
			this.run.error = {
				name: error instanceof Error ? error.name : "Error",
				message: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				phase: error instanceof Error && "phase" in error ? String(error.phase) : undefined,
				budget: error instanceof Error && "budget" in error ? error.budget : undefined,
				elapsedMs:
					error instanceof Error && "elapsedMs" in error && typeof error.elapsedMs === "number"
						? error.elapsedMs
						: undefined,
			};
		} else {
			this.run.result = result;
			const interaction =
				typeof result === "object" && result !== null && "interaction" in result ? result.interaction : undefined;
			this.run.status =
				typeof interaction === "object" && interaction !== null && "status" in interaction
					? (interaction.status as TelemetryRun["status"])
					: "analysis";
		}
		this.event("run_finished", { status: this.run.status });
		await this.flush();
		return {
			runId: this.run.id,
			collectionMs: Math.round(performance.now() - this.finishStarted),
			stored: this.stored,
			assetCount: this.run.assets.length,
			warnings: [...this.run.warnings],
		};
	}
}

export function verificationTelemetryReference(error: unknown): TelemetryReference | undefined {
	return error instanceof Error && "telemetry" in error ? (error.telemetry as TelemetryReference) : undefined;
}
