import { type Static, type TSchema, Type } from "typebox";

/**
 * Artifact input registry.
 *
 * Each operation is its own model-facing tool with a schema where every field is
 * required, instead of one `artifacts` tool whose `command` decides which optional
 * fields matter. Mutating operations also define `apply`, a pure transition over a
 * filename -> content map. The panel runs `apply` to execute a call, and replays the
 * same `apply` over the transcript to rebuild state, so execution and reconstruction
 * cannot drift.
 */

export type ArtifactOperationName = "create" | "edit" | "write" | "read" | "delete" | "logs";

export type ArtifactFiles = Map<string, string>;

/** Thrown by `apply` and by panel reads; becomes an `isError` tool result. */
export class ArtifactError extends Error {}

export interface ArtifactOperation<S extends TSchema = TSchema> {
	op: ArtifactOperationName;
	/** Tool name the model calls. */
	tool: string;
	label: string;
	/** True when the call changes stored files (replayed on session load). */
	mutates: boolean;
	parameters: S;
	/** Present on mutating operations: validate against `files` and apply the change in place. */
	apply?: (files: ArtifactFiles, args: Static<S>) => void;
}

const filename = Type.String({ description: "Filename including extension, e.g. 'notes.md' or 'index.html'" });

function missing(files: ArtifactFiles, name: string): ArtifactError {
	const names = Array.from(files.keys());
	return new ArtifactError(
		names.length === 0
			? `File ${name} not found. No files have been created yet.`
			: `File ${name} not found. Available files: ${names.join(", ")}`,
	);
}

function requireFile(files: ArtifactFiles, name: string): string {
	const content = files.get(name);
	if (content === undefined) throw missing(files, name);
	return content;
}

const createParams = Type.Object({
	filename,
	content: Type.String({ description: "Full file content" }),
});
const editParams = Type.Object({
	filename,
	old_str: Type.String({ description: "Exact text to replace; must occur in the file" }),
	new_str: Type.String({ description: "Replacement text" }),
});
const writeParams = Type.Object({
	filename,
	content: Type.String({ description: "New full file content" }),
});
const fileOnlyParams = Type.Object({ filename });

export const CREATE: ArtifactOperation<typeof createParams> = {
	op: "create",
	tool: "artifact_create",
	label: "Create artifact",
	mutates: true,
	parameters: createParams,
	apply: (files, args) => {
		if (files.has(args.filename)) {
			throw new ArtifactError(`File ${args.filename} already exists. Use artifact_edit or artifact_write.`);
		}
		files.set(args.filename, args.content);
	},
};

export const EDIT: ArtifactOperation<typeof editParams> = {
	op: "edit",
	tool: "artifact_edit",
	label: "Edit artifact",
	mutates: true,
	parameters: editParams,
	apply: (files, args) => {
		const content = requireFile(files, args.filename);
		if (args.old_str === "") throw new ArtifactError("old_str must not be empty");
		if (!content.includes(args.old_str)) {
			throw new ArtifactError(`old_str not found in ${args.filename}. Current content:\n\n${content}`);
		}
		files.set(args.filename, content.replace(args.old_str, args.new_str));
	},
};

export const WRITE: ArtifactOperation<typeof writeParams> = {
	op: "write",
	tool: "artifact_write",
	label: "Rewrite artifact",
	mutates: true,
	parameters: writeParams,
	apply: (files, args) => {
		requireFile(files, args.filename);
		files.set(args.filename, args.content);
	},
};

export const READ: ArtifactOperation<typeof fileOnlyParams> = {
	op: "read",
	tool: "artifact_read",
	label: "Read artifact",
	mutates: false,
	parameters: fileOnlyParams,
};

export const DELETE: ArtifactOperation<typeof fileOnlyParams> = {
	op: "delete",
	tool: "artifact_delete",
	label: "Delete artifact",
	mutates: true,
	parameters: fileOnlyParams,
	apply: (files, args) => {
		requireFile(files, args.filename);
		files.delete(args.filename);
	},
};

export const LOGS: ArtifactOperation<typeof fileOnlyParams> = {
	op: "logs",
	tool: "artifact_logs",
	label: "Read HTML artifact logs",
	mutates: false,
	parameters: fileOnlyParams,
};

export const ARTIFACT_OPERATIONS = [CREATE, EDIT, WRITE, READ, DELETE, LOGS] as const;

export type ArtifactOperationArgs = {
	create: Static<typeof createParams>;
	edit: Static<typeof editParams>;
	write: Static<typeof writeParams>;
	read: Static<typeof fileOnlyParams>;
	delete: Static<typeof fileOnlyParams>;
	logs: Static<typeof fileOnlyParams>;
};

/** One normalized call, whichever tool shape produced it. */
export type ArtifactCall = {
	[K in ArtifactOperationName]: { op: K; args: ArtifactOperationArgs[K] };
}[ArtifactOperationName];

export const LEGACY_ARTIFACTS_TOOL = "artifacts";

const byTool = new Map<string, ArtifactOperation>(ARTIFACT_OPERATIONS.map((operation) => [operation.tool, operation]));
const byOp = new Map<ArtifactOperationName, ArtifactOperation>(
	ARTIFACT_OPERATIONS.map((operation) => [operation.op, operation]),
);

export function artifactOperation(op: ArtifactOperationName): ArtifactOperation {
	const operation = byOp.get(op);
	if (!operation) throw new Error(`Unknown artifact operation: ${op}`);
	return operation;
}

export function isArtifactTool(toolName: string): boolean {
	return byTool.has(toolName) || toolName === LEGACY_ARTIFACTS_TOOL;
}

const LEGACY_COMMANDS: Record<string, ArtifactOperationName> = {
	create: "create",
	update: "edit",
	rewrite: "write",
	get: "read",
	delete: "delete",
	logs: "logs",
};

/**
 * Normalize a recorded tool call into an operation call. Accepts the current tools
 * and the legacy single `artifacts` tool (`{ command, filename, content?, old_str?, new_str? }`)
 * so sessions saved before the split still render and rebuild.
 */
export function toArtifactCall(toolName: string, args: unknown): ArtifactCall | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const raw = args as Record<string, unknown>;
	let op: ArtifactOperationName | undefined;
	if (toolName === LEGACY_ARTIFACTS_TOOL) {
		op = typeof raw.command === "string" ? LEGACY_COMMANDS[raw.command] : undefined;
	} else {
		op = byTool.get(toolName)?.op;
	}
	if (!op) return undefined;
	const name = typeof raw.filename === "string" ? raw.filename : "";
	const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : "");
	switch (op) {
		case "create":
		case "write":
			return { op, args: { filename: name, content: text("content") } };
		case "edit":
			return { op, args: { filename: name, old_str: text("old_str"), new_str: text("new_str") } };
		default:
			return { op, args: { filename: name } };
	}
}

/** Apply a mutating call to `files`. Read-only calls are a no-op. */
export function applyArtifactCall(files: ArtifactFiles, call: ArtifactCall): void {
	const operation = artifactOperation(call.op) as ArtifactOperation<TSchema>;
	operation.apply?.(files, call.args);
}
