import type { ArtifactElement } from "./ArtifactElement.js";
import { DocxArtifact } from "./DocxArtifact.js";
import { ExcelArtifact } from "./ExcelArtifact.js";
import { GenericArtifact } from "./GenericArtifact.js";
import { HtmlArtifact } from "./HtmlArtifact.js";
import { ImageArtifact } from "./ImageArtifact.js";
import { MarkdownArtifact } from "./MarkdownArtifact.js";
import { PdfArtifact } from "./PdfArtifact.js";
import { SvgArtifact } from "./SvgArtifact.js";
import { TextArtifact } from "./TextArtifact.js";

/**
 * Artifact output registry: which element previews a file, keyed by extension.
 * A later registration for an extension replaces the earlier one; files with no
 * registered extension use the generic viewer.
 */
export interface ArtifactViewer {
	id: string;
	extensions: readonly string[];
	create(): ArtifactElement;
}

const viewers = new Map<string, ArtifactViewer>();

const GENERIC_VIEWER: ArtifactViewer = { id: "generic", extensions: [], create: () => new GenericArtifact() };

export function registerArtifactViewer(viewer: ArtifactViewer): void {
	for (const extension of viewer.extensions) viewers.set(extension.toLowerCase(), viewer);
}

export function fileExtension(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

export function resolveArtifactViewer(filename: string): ArtifactViewer {
	return viewers.get(fileExtension(filename)) ?? GENERIC_VIEWER;
}

registerArtifactViewer({ id: "html", extensions: ["html", "htm"], create: () => new HtmlArtifact() });
registerArtifactViewer({ id: "svg", extensions: ["svg"], create: () => new SvgArtifact() });
registerArtifactViewer({ id: "markdown", extensions: ["md", "markdown"], create: () => new MarkdownArtifact() });
registerArtifactViewer({ id: "pdf", extensions: ["pdf"], create: () => new PdfArtifact() });
registerArtifactViewer({ id: "excel", extensions: ["xlsx", "xls"], create: () => new ExcelArtifact() });
registerArtifactViewer({ id: "docx", extensions: ["docx"], create: () => new DocxArtifact() });
registerArtifactViewer({
	id: "image",
	extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"],
	create: () => new ImageArtifact(),
});
registerArtifactViewer({
	id: "text",
	extensions: [
		"txt",
		"json",
		"xml",
		"yaml",
		"yml",
		"csv",
		"js",
		"ts",
		"jsx",
		"tsx",
		"py",
		"java",
		"c",
		"cpp",
		"h",
		"css",
		"scss",
		"sass",
		"less",
		"sh",
	],
	create: () => new TextArtifact(),
});
