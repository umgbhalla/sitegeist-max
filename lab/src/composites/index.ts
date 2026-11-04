// Sitegeist screens composed from Fluid Functionalism. Metadata only: the shell
// lists these without loading kit code; screens.tsx renders them inside the frame.
export interface CompositeMeta {
	id: string;
	title: string;
	caption: string;
	variants?: string[];
}

export const COMPOSITES: CompositeMeta[] = [
	{
		id: "chat-run",
		title: "Chat: run",
		caption: "One turn: reasoning, tool calls, workflow sub-agents, steer queue, answer.",
		variants: ["Running", "Done"],
	},
	{
		id: "files",
		title: "Files: docked preview",
		caption: "Artifacts created in the chat, previewed above the composer.",
	},
	{
		id: "model-picker",
		title: "Model picker",
		caption: "Choosing provider and model from the composer.",
	},
];
