import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import type { TemplateResult } from "lit";

export interface ToolRenderResult {
	content: TemplateResult;
	isCustom: boolean; // true = no card wrapper, false = wrap in card
}

/** Which call is being rendered, for renderers that hold per-call UI state (e.g. ask_user's form). */
export interface ToolRenderContext {
	toolCallId: string;
}

export interface ToolRenderer<TParams = any, TDetails = any> {
	render(
		params: TParams | undefined,
		result: ToolResultMessage<TDetails> | undefined,
		isStreaming?: boolean,
		context?: ToolRenderContext,
	): ToolRenderResult;
}
