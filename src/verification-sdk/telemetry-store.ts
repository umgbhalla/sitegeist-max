import { redactTelemetryText } from "./telemetry-redaction.js";

export interface TelemetryAsset {
	id: string;
	sha256: string;
	role: string;
	mime: string;
	bytes: number;
	metadata?: unknown;
}

export interface TelemetryLabel {
	outcome: "success" | "failure" | "uncertain";
	notes?: string;
	correctTargets?: { x: number; y: number }[];
	updatedAt?: string;
}

export interface TelemetryRun {
	schemaVersion: 1;
	id: string;
	startedAt: string;
	finishedAt?: string;
	collectionMs?: number;
	status: "running" | "analysis" | "success" | "failure" | "changed" | "uncertain" | "error";
	producer: { name: string; version: string; extensionId?: string };
	request: unknown;
	events: { atMs: number; name: string; data?: unknown }[];
	assets: TelemetryAsset[];
	bytes: number;
	result?: unknown;
	error?: { name: string; message: string; stack?: string; phase?: string; budget?: unknown; elapsedMs?: number };
	label?: TelemetryLabel;
	warnings: string[];
}

export interface StoredTelemetryAsset {
	sha256: string;
	blob: Blob;
}

export interface TelemetryReference {
	runId: string;
	stored: boolean;
	assetCount: number;
	collectionMs: number;
	warnings: string[];
}

export interface TelemetryRunSummary {
	id: string;
	startedAt: string;
	finishedAt?: string;
	status: TelemetryRun["status"];
	assetCount: number;
	bytes: number;
	label?: TelemetryLabel;
}

export const TELEMETRY_RETENTION = { maxRuns: 50, maxBytes: 512 * 1024 * 1024 } as const;

function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		if (typeof indexedDB === "undefined") return reject(new Error("Local telemetry storage is unavailable"));
		const request = indexedDB.open("jev-verification-telemetry-v1", 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore("runs", { keyPath: "id" });
			request.result.createObjectStore("assets", { keyPath: "sha256" });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("Could not open telemetry storage"));
		request.onblocked = () => reject(new Error("Telemetry storage upgrade is blocked"));
	});
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("Telemetry storage read failed"));
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error ?? new Error("Telemetry storage transaction aborted"));
		transaction.onerror = () => reject(transaction.error ?? new Error("Telemetry storage transaction failed"));
	});
}

/** Local to this extension. Binary assets are content-addressed and shared between runs. */
export class VerificationTelemetryStore {
	async saveRun(run: TelemetryRun, assets: StoredTelemetryAsset[]): Promise<void> {
		const db = await openDatabase();
		try {
			const tx = db.transaction(["runs", "assets"], "readwrite");
			const done = transactionDone(tx);
			const runs = tx.objectStore("runs");
			const binaries = tx.objectStore("assets");
			for (const asset of assets) binaries.put(asset);
			// Checkpointing must preserve a label entered by another extension page.
			const previous = runs.get(run.id) as IDBRequest<TelemetryRun | undefined>;
			previous.onsuccess = () => {
				runs.put({ ...run, label: previous.result?.label ?? run.label });
				const all = runs.getAll() as IDBRequest<TelemetryRun[]>;
				all.onsuccess = () => {
					let count = 0;
					let bytes = 0;
					const keep = new Set<string>();
					for (const item of all.result.sort(
						(a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
					)) {
						if (count >= TELEMETRY_RETENTION.maxRuns || bytes + item.bytes > TELEMETRY_RETENTION.maxBytes) {
							runs.delete(item.id);
							continue;
						}
						count++;
						bytes += item.bytes;
						for (const asset of item.assets) keep.add(asset.sha256);
					}
					const keys = binaries.getAllKeys();
					keys.onsuccess = () => {
						for (const key of keys.result) if (!keep.has(String(key))) binaries.delete(key);
					};
				};
			};
			await done;
		} finally {
			db.close();
		}
	}

	async listRuns(limit = 20): Promise<TelemetryRunSummary[]> {
		return (await this.readRuns()).slice(0, Math.min(50, Math.max(1, limit))).map((run) => ({
			id: run.id,
			startedAt: run.startedAt,
			finishedAt: run.finishedAt,
			status: run.status,
			assetCount: run.assets.length,
			bytes: run.bytes,
			label: run.label,
		}));
	}

	private async readRuns(): Promise<TelemetryRun[]> {
		const db = await openDatabase();
		try {
			const tx = db.transaction("runs", "readonly");
			const done = transactionDone(tx);
			const [runs] = await Promise.all([
				requestValue(tx.objectStore("runs").getAll() as IDBRequest<TelemetryRun[]>),
				done,
			]);
			return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
		} finally {
			db.close();
		}
	}

	async labelRun(runId: string, label: TelemetryLabel): Promise<void> {
		if (!["success", "failure", "uncertain"].includes(label.outcome)) throw new Error("Invalid observed outcome");
		if (
			label.correctTargets?.some(
				(point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0,
			)
		)
			throw new Error("Correct target coordinates must be finite viewport positions");
		const db = await openDatabase();
		try {
			const tx = db.transaction("runs", "readwrite");
			const done = transactionDone(tx);
			const store = tx.objectStore("runs");
			const request = store.get(runId) as IDBRequest<TelemetryRun | undefined>;
			let missing = false;
			request.onsuccess = () => {
				if (!request.result) {
					missing = true;
					return;
				}
				store.put({
					...request.result,
					label: {
						outcome: label.outcome,
						notes: label.notes ? redactTelemetryText(label.notes.slice(0, 2000)) : undefined,
						correctTargets: label.correctTargets?.slice(0, 8),
						updatedAt: new Date().toISOString(),
					},
				});
			};
			await done;
			if (missing) throw new Error("Telemetry run was not found");
		} finally {
			db.close();
		}
	}

	async exportRuns(options: { runIds?: string[]; limit?: number } = {}): Promise<Blob> {
		const all = await this.readRuns();
		const runs = options.runIds
			? all.filter((run) => options.runIds?.includes(run.id))
			: all.slice(0, Math.min(50, Math.max(1, options.limit ?? 20)));
		if (options.runIds?.some((id) => !runs.some((run) => run.id === id)))
			throw new Error("A requested telemetry run was not found");
		const hashes = [...new Set(runs.flatMap((run) => run.assets.map((asset) => asset.sha256)))];
		const db = await openDatabase();
		let assets: (StoredTelemetryAsset | undefined)[];
		try {
			const tx = db.transaction("assets", "readonly");
			const done = transactionDone(tx);
			[assets] = await Promise.all([
				Promise.all(
					hashes.map((hash) =>
						requestValue(tx.objectStore("assets").get(hash) as IDBRequest<StoredTelemetryAsset | undefined>),
					),
				),
				done,
			]);
		} finally {
			db.close();
		}
		const encoded = await Promise.all(
			assets.map(async (asset, index) => {
				if (!asset) throw new Error(`Telemetry asset is unavailable: ${hashes[index]}`);
				const bytes = new Uint8Array(await asset.blob.arrayBuffer());
				const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
					byte.toString(16).padStart(2, "0"),
				).join("");
				if (digest !== asset.sha256) throw new Error(`Telemetry asset integrity failure: ${asset.sha256}`);
				let binary = "";
				for (let offset = 0; offset < bytes.length; offset += 8192)
					binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
				return {
					sha256: asset.sha256,
					mime: asset.blob.type,
					bytes: bytes.length,
					encoding: "base64",
					data: btoa(binary),
				};
			}),
		);
		return new Blob(
			[
				JSON.stringify({
					schema: "sitegeist.verification.telemetry/1",
					exportedAt: new Date().toISOString(),
					retention: TELEMETRY_RETENTION,
					coordinates: {
						clicksAndLabels: "top-level viewport CSS pixels",
						sourceRects: "full screenshot pixels",
						assetPixels: "local to each image; sourceRect and contentRect supply crop transforms",
					},
					runs,
					assets: encoded,
				}),
			],
			{ type: "application/json" },
		);
	}

	async clearRuns(): Promise<void> {
		const db = await openDatabase();
		try {
			const tx = db.transaction(["runs", "assets"], "readwrite");
			const done = transactionDone(tx);
			tx.objectStore("runs").clear();
			tx.objectStore("assets").clear();
			await done;
		} finally {
			db.close();
		}
	}
}
