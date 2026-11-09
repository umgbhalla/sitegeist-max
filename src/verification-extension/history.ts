import { downloadVerificationTelemetry } from "../verification-export.js";
import { VerificationTelemetryStore } from "../verification-sdk/index.js";

const store = new VerificationTelemetryStore();
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const enabled = element<HTMLInputElement>("enabled");
const auto = element<HTMLInputElement>("auto");
const notice = element<HTMLDivElement>("notice");
const runs = element<HTMLDivElement>("runs");
const showError = (error: unknown) => {
	notice.textContent = error instanceof Error ? error.message : String(error);
};
async function refresh() {
	const list = await store.listRuns();
	element("count").textContent = `(${list.length})`;
	runs.replaceChildren();
	if (!list.length) {
		runs.textContent = "No recordings yet.";
		return;
	}
	for (const run of list) {
		const card = document.createElement("article");
		const title = document.createElement("h3");
		title.textContent = `${run.status} · ${new Date(run.startedAt).toLocaleString()}`;
		const meta = document.createElement("small");
		meta.textContent = `${run.id} · ${(run.bytes / 1024 / 1024).toFixed(2)} MiB · ${run.assetCount} assets`;
		card.append(title, meta);
		if (run.warnings.length) {
			const warnings = document.createElement("ul");
			for (const warning of run.warnings) {
				const li = document.createElement("li");
				li.textContent = warning;
				warnings.append(li);
			}
			card.append(warnings);
		}
		const button = document.createElement("button");
		button.textContent = "Export run";
		button.addEventListener("click", () => {
			void downloadVerificationTelemetry({ runIds: [run.id] }).then(() => {
				notice.textContent = "Export started.";
			}, showError);
		});
		card.append(button);
		const details = document.createElement("details");
		const summary = document.createElement("summary");
		summary.textContent = "Activity and coverage";
		const content = document.createElement("div");
		details.append(summary, content);
		details.addEventListener("toggle", () => {
			if (!details.open) return;
			void store.getRun(run.id).then((record) => {
				content.replaceChildren();
				if (!record) {
					content.textContent = "Run no longer exists.";
					return;
				}
				const coverage = document.createElement("p");
				coverage.textContent = record.coverage
					? `Coverage: ${record.coverage.eventsCaptured} events and ${record.coverage.assetsCaptured} assets captured; ${record.coverage.eventsOmitted} events and ${record.coverage.assetsOmitted} assets omitted.`
					: "Coverage details are unavailable for this older recording.";
				content.append(coverage);
				if (record.coverage && Object.keys(record.coverage.sanitizationOmissions).length) {
					const omissions = document.createElement("p");
					omissions.textContent = `Sanitization omissions: ${JSON.stringify(record.coverage.sanitizationOmissions)}`;
					content.append(omissions);
				}
				const limitations = document.createElement("ul");
				for (const item of record.coverage?.limitations ?? []) {
					const li = document.createElement("li");
					li.textContent = item;
					limitations.append(li);
				}
				content.append(limitations);
				const assetDetails = document.createElement("details");
				const assetSummary = document.createElement("summary");
				assetSummary.textContent = `Captured assets (${record.assets.length})`;
				assetDetails.append(assetSummary);
				const assetList = document.createElement("ul");
				for (const asset of record.assets) {
					const item = document.createElement("li");
					item.textContent = `${asset.role} · ${asset.bytes} bytes · ${asset.sha256}`;
					assetList.append(item);
				}
				assetDetails.append(assetList);
				content.append(assetDetails);
				const activity = document.createElement("ol");
				activity.className = "activity";
				for (const event of record.events) {
					const item = document.createElement("li");
					const eventDetails = document.createElement("details");
					const eventSummary = document.createElement("summary");
					eventSummary.textContent = `+${(event.atMs / 1000).toFixed(2)}s  ${event.name.replaceAll("_", " ")}`;
					eventDetails.append(eventSummary);
					if (event.data !== undefined) {
						const data = document.createElement("pre");
						data.textContent = JSON.stringify(event.data, null, 2);
						eventDetails.append(data);
					}
					item.append(eventDetails);
					activity.append(item);
				}
				content.append(activity);
			}, showError);
		});
		card.append(details);
		runs.append(card);
	}
}
void chrome.storage.local.get({ recordingEnabled: true, automaticExport: false }).then((settings) => {
	enabled.checked = Boolean(settings.recordingEnabled);
	auto.checked = Boolean(settings.automaticExport);
}, showError);
enabled.addEventListener("change", () => {
	void chrome.storage.local.set({ recordingEnabled: enabled.checked }).catch(showError);
});
auto.addEventListener("change", () => {
	void chrome.storage.local.set({ automaticExport: auto.checked }).catch(showError);
});
element("show-controls").addEventListener("click", () => {
	void chrome.runtime
		.sendMessage({ type: "verification:show-controls" })
		.then((result: { ok: boolean; error?: string }) => {
			if (!result.ok) throw new Error(result.error ?? "Could not show controls");
			notice.textContent = "Page controls opened.";
		})
		.catch(showError);
});
element("refresh").addEventListener("click", () => {
	void refresh().catch(showError);
});
element("clear").addEventListener("click", () => {
	if (!confirm("Delete all saved recordings and assets? This cannot be undone.")) return;
	void chrome.runtime
		.sendMessage({ type: "verification:clear-history" })
		.then((result: { ok: boolean; error?: string }) => {
			if (!result.ok) throw new Error(result.error ?? "Deletion failed");
			return refresh();
		})
		.then(() => {
			notice.textContent = "Recordings deleted.";
		}, showError);
});
function dateValue(id: string, nextDay = false): string | undefined {
	const value = element<HTMLInputElement>(id).value;
	if (!value) return undefined;
	const date = new Date(`${value}T00:00:00`);
	if (nextDay) date.setDate(date.getDate() + 1);
	return date.toISOString();
}
element("export").addEventListener("click", () => {
	const start = dateValue("start"),
		end = dateValue("end", true);
	if (start && end && start >= end) {
		notice.textContent = "The end date must be on or after the start date.";
		return;
	}
	void downloadVerificationTelemetry({ start, end }).then(() => {
		notice.textContent = "Export started.";
	}, showError);
});
element("all").addEventListener("click", () => {
	void downloadVerificationTelemetry().then(() => {
		notice.textContent = "Export started.";
	}, showError);
});
void refresh().catch(showError);
