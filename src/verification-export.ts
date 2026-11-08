import { VerificationTelemetryStore } from "./verification-sdk/index.js";

/** Download from extension context so a website cannot read another tab's dataset. */
export async function downloadVerificationTelemetry(
	options: { runIds?: string[]; limit?: number; start?: string; end?: string } = {},
) {
	const store = new VerificationTelemetryStore();
	if (!(await store.listRuns(1)).length) throw new Error("No saved verification runs to export yet");
	const blob = await store.exportRuns(options);
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 8192)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
	const filename = `jev-verification-samples-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
	const downloadId = await chrome.downloads.download({
		url: `data:application/json;base64,${btoa(binary)}`,
		filename,
		saveAs: false,
		conflictAction: "uniquify",
	});
	return { downloadId, filename, bytes: blob.size };
}
