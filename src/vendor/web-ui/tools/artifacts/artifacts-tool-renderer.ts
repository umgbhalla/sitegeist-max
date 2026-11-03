import "@mariozechner/mini-lit/dist/CodeBlock.js";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { createRef, ref } from "lit/directives/ref.js";
import { FileCode2 } from "lucide";
import "../../components/ConsoleBlock.js";
import { Diff } from "@mariozechner/mini-lit/dist/Diff.js";
import { html, type TemplateResult } from "lit";
import { i18n } from "../../utils/i18n.js";
import { renderCollapsibleHeader, renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { ArtifactPill } from "./ArtifactPill.js";
import { type ArtifactOperationName, toArtifactCall } from "./artifact-operations.js";
import type { ArtifactsPanel } from "./artifacts.js";

// Helper to extract text from content blocks
function getTextOutput(result: ToolResultMessage<any> | undefined): string {
	if (!result) return "";
	return (
		result.content
			?.filter((c) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

// Helper to determine language for syntax highlighting
function getLanguageFromFilename(filename?: string): string {
	if (!filename) return "text";
	const ext = filename.split(".").pop()?.toLowerCase();
	const languageMap: Record<string, string> = {
		js: "javascript",
		jsx: "javascript",
		ts: "typescript",
		tsx: "typescript",
		html: "html",
		css: "css",
		scss: "scss",
		json: "json",
		py: "python",
		md: "markdown",
		svg: "xml",
		xml: "xml",
		yaml: "yaml",
		yml: "yaml",
		sh: "bash",
		bash: "bash",
		sql: "sql",
		java: "java",
		c: "c",
		cpp: "cpp",
		cs: "csharp",
		go: "go",
		rs: "rust",
		php: "php",
		rb: "ruby",
		swift: "swift",
		kt: "kotlin",
		r: "r",
	};
	return languageMap[ext || ""] || "text";
}

type Label = Parameters<typeof i18n>[0];

const LABELS: Record<ArtifactOperationName, { streaming: Label; complete: Label }> = {
	create: { streaming: "Creating artifact", complete: "Created artifact" },
	edit: { streaming: "Updating artifact", complete: "Updated artifact" },
	write: { streaming: "Rewriting artifact", complete: "Rewrote artifact" },
	read: { streaming: "Getting artifact", complete: "Got artifact" },
	delete: { streaming: "Deleting artifact", complete: "Deleted artifact" },
	logs: { streaming: "Getting logs", complete: "Got logs" },
};

/**
 * Renders every artifact tool. `toolName` selects the operation; the legacy
 * `artifacts` tool is normalized from its `command` field.
 */
export class ArtifactsToolRenderer implements ToolRenderer<Record<string, unknown>, undefined> {
	constructor(
		public artifactsPanel: ArtifactsPanel | undefined,
		private readonly toolName: string,
	) {}

	render(
		params: Record<string, unknown> | undefined,
		result: ToolResultMessage<undefined> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		const call = params ? toArtifactCall(this.toolName, params) : undefined;
		if (!call) {
			return { content: renderHeader(state, FileCode2, i18n("Preparing artifact...")), isCustom: false };
		}

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		const filename = call.args.filename || undefined;
		const labels = LABELS[call.op];
		const header = (text: Label): TemplateResult =>
			filename
				? html`<span>${i18n(text)} ${ArtifactPill(filename, this.artifactsPanel)}</span>`
				: html`<span>${i18n(text)}</span>`;
		const collapsible = (text: Label, body: unknown, spaced = true) => ({
			content: html`
				<div>
					${renderCollapsibleHeader(state, FileCode2, header(text), contentRef, chevronRef, false)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300 ${spaced ? "space-y-3" : ""}">
						${body}
					</div>
				</div>
			`,
			isCustom: false,
		});
		const source = (code: string) =>
			code ? html`<code-block .code=${code} language=${getLanguageFromFilename(filename)}></code-block>` : "";
		const isHtml = filename?.endsWith(".html") ?? false;
		const output = getTextOutput(result);

		// Content the call carries: full source, or the edit diff.
		const authored =
			call.op === "create" || call.op === "write"
				? source(call.args.content)
				: call.op === "edit" && (call.args.old_str || call.args.new_str)
					? Diff({ oldText: call.args.old_str, newText: call.args.new_str })
					: "";

		if (result?.isError) {
			const message = output || i18n("An error occurred");
			if (call.op === "create" || call.op === "edit" || call.op === "write") {
				return collapsible(
					labels.streaming,
					html`${authored}
						${
							isHtml
								? html`<console-block .content=${message} variant="error"></console-block>`
								: html`<div class="text-sm text-destructive">${message}</div>`
						}`,
				);
			}
			return {
				content: html`
					<div class="space-y-3">
						${renderHeader(state, FileCode2, header(labels.streaming))}
						<div class="text-sm text-destructive">${message}</div>
					</div>
				`,
				isCustom: false,
			};
		}

		if (!result) {
			if (call.op === "delete") return { content: renderHeader(state, FileCode2, header(labels.streaming)), isCustom: false };
			return collapsible(labels.streaming, authored, false);
		}

		switch (call.op) {
			case "read":
				return collapsible(labels.complete, source(output) || i18n("(no output)"), false);
			case "logs":
				return collapsible(labels.complete, html`<console-block .content=${output || i18n("(no output)")}></console-block>`, false);
			case "delete":
				return {
					content: html`<div class="space-y-3">${renderHeader(state, FileCode2, header(labels.complete))}</div>`,
					isCustom: false,
				};
			default: {
				// Mutations return "<Verb> file <name>" plus HTML console logs on following lines.
				const logs = output.split("\n").slice(1).join("\n").trim();
				return collapsible(
					labels.complete,
					html`${authored} ${isHtml && logs ? html`<console-block .content=${logs}></console-block>` : ""}`,
				);
			}
		}
	}
}
