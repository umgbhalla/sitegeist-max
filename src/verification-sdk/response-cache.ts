import {
	askTypesafe,
	type TypesafeConfig,
	type VisionCallTrace,
	type VisionQuestion,
	type VisionResponse,
} from "./typesafe-client.js";

interface CachedResponse {
	expires: number;
	response: VisionResponse;
	source?: { runId: string; callId: string };
}

/** Exact inputs only. Never stores coordinates, clicks, page state, or credentials. */
export class VisionResponseCache {
	private readonly entries = new Map<string, CachedResponse>();
	private readonly pending = new Map<
		string,
		{ request: Promise<VisionResponse>; source?: { runId: string; callId: string } }
	>();

	clear(): void {
		this.entries.clear();
	}

	async ask(
		config: TypesafeConfig,
		images: Record<string, Blob>,
		questions: Record<string, VisionQuestion>,
		deadline: number,
		signal?: AbortSignal,
		trace?: VisionCallTrace,
	): Promise<{ response: VisionResponse; cache: "hit" | "miss" | "shared" }> {
		signal?.throwIfAborted();
		if (performance.now() >= deadline) throw new Error("Recognition deadline reached");
		const digest = async (bytes: BufferSource) =>
			Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");
		const imageHashes = await Promise.all(
			Object.entries(images).map(async ([name, image]) => [name, await digest(await image.arrayBuffer())]),
		);
		const key = await digest(
			new TextEncoder().encode(
				JSON.stringify([
					config.baseUrl,
					config.model,
					await digest(new TextEncoder().encode(config.apiKey)),
					questions,
					imageHashes,
				]),
			),
		);
		signal?.throwIfAborted();
		const cached = this.entries.get(key);
		if (cached && cached.expires > performance.now()) {
			this.entries.delete(key);
			this.entries.set(key, cached);
			trace?.recorder.event("cache_resolution", {
				callId: trace.callId,
				stage: trace.stage,
				cache: "hit",
				source: cached.source,
			});
			return { response: structuredClone(cached.response), cache: "hit" };
		}
		this.entries.delete(key);
		const pending = this.pending.get(key);
		if (pending) {
			trace?.recorder.event("cache_resolution", {
				callId: trace.callId,
				stage: trace.stage,
				cache: "shared",
				source: pending.source,
			});
			return { response: structuredClone(await pending.request), cache: "shared" };
		}
		trace?.recorder.event("cache_resolution", { callId: trace.callId, stage: trace.stage, cache: "miss" });
		const source = trace ? { runId: trace.recorder.run.id, callId: trace.callId } : undefined;
		const request = askTypesafe(config, images, questions, deadline, signal, trace);
		this.pending.set(key, { request, source });
		try {
			const response = await request;
			this.entries.set(key, { response: structuredClone(response), expires: performance.now() + 60_000, source });
			while (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value!);
			return { response, cache: "miss" };
		} finally {
			this.pending.delete(key);
		}
	}
}
