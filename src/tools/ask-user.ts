import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import { registerToolRenderer, renderHeader } from "@earendil-works/pi-web-ui";
import { i18n } from "@mariozechner/mini-lit";
import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { MessageCircleQuestion } from "lucide";
import "../utils/i18n-extension.js";

const questionSchema = Type.Object({
	question: Type.String({ description: "One short question" }),
	options: Type.Array(Type.String(), { minItems: 2, maxItems: 6, description: "Distinct answers to choose from" }),
	multiSelect: Type.Boolean({ description: "Whether several options may be chosen" }),
});
const schema = Type.Object({
	questions: Type.Array(questionSchema, { minItems: 1, maxItems: 4 }),
});
type Params = Static<typeof schema>;
type Question = Static<typeof questionSchema>;

interface Details {
	/** Per question, the chosen options plus any typed "Other" answer. Empty when skipped. */
	answers: string[][];
	skipped: boolean;
}

/** Calls waiting on the user, by tool call id. The form in the transcript resolves them. */
const waiting = new Map<string, (details: Details) => void>();
/** Fires "change" when a call starts or stops waiting; the call can render before execute runs. */
const waitingChanged = new EventTarget();
const setWaiting = (id: string, resolve?: (details: Details) => void) => {
	if (resolve) waiting.set(id, resolve);
	else waiting.delete(id);
	waitingChanged.dispatchEvent(new Event("change"));
};

export const ASK_USER_TOOL_DESCRIPTION = `Ask the user up to 4 multiple-choice questions and wait for the answers.

Use it when a decision is the user's to make and the page does not settle it: which account, email or address to use, whether to submit, pay or delete, which of several matching items they mean. Do not use it for facts you can find on the page or for confirming every step.

Every question offers its options plus a free-text "Other" answer. The user may skip; then decide conservatively or stop and explain.`;

export class AskUserTool implements AgentTool<typeof schema, Details> {
	name = "ask_user";
	label = "Ask User";
	description = ASK_USER_TOOL_DESCRIPTION;
	parameters = schema;

	async execute(toolCallId: string, args: Params, signal?: AbortSignal): Promise<AgentToolResult<Details>> {
		if (signal?.aborted) throw new Error("Aborted before the user answered");
		const details = await new Promise<Details>((resolve, reject) => {
			setWaiting(toolCallId, resolve);
			signal?.addEventListener(
				"abort",
				() => {
					setWaiting(toolCallId);
					reject(new Error("Aborted before the user answered"));
				},
				{ once: true },
			);
		});
		const text = details.skipped
			? "The user skipped these questions."
			: args.questions
					.map((q, i) => `${q.question}\n${details.answers[i]?.join(", ") || "(no answer)"}`)
					.join("\n\n");
		return { content: [{ type: "text", text }], details };
	}
}

@customElement("ask-user-form")
export class AskUserForm extends LitElement {
	@property({ attribute: false }) toolCallId = "";
	@property({ attribute: false }) questions: Question[] = [];
	@state() private chosen: string[][] = [];
	@state() private other: string[] = [];
	@state() private open = false;
	private sync = () => {
		this.open = waiting.has(this.toolCallId);
	};

	protected override createRenderRoot() {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		waitingChanged.addEventListener("change", this.sync);
		this.sync();
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		waitingChanged.removeEventListener("change", this.sync);
	}

	override willUpdate(changed: Map<string, unknown>) {
		if (changed.has("toolCallId")) this.sync();
	}

	private toggle(index: number, option: string, multi: boolean) {
		const current = this.chosen[index] ?? [];
		const next = multi
			? current.includes(option)
				? current.filter((o) => o !== option)
				: [...current, option]
			: [option];
		this.chosen = this.questions.map((_, i) => (i === index ? next : (this.chosen[i] ?? [])));
	}

	private answers(): string[][] {
		return this.questions.map((_, i) => {
			const typed = this.other[i]?.trim();
			return [...(this.chosen[i] ?? []), ...(typed ? [typed] : [])];
		});
	}

	private finish(skipped: boolean) {
		const resolve = waiting.get(this.toolCallId);
		if (!resolve) return;
		setWaiting(this.toolCallId);
		resolve({ answers: skipped ? [] : this.answers(), skipped });
	}

	override render() {
		const complete = this.answers().every((a) => a.length > 0);
		return html`<div class="ask-form" ?inert=${!this.open}>
			${this.questions.map(
				(q, i) => html`<fieldset class="ask-question">
					<legend>${q.question}</legend>
					${q.options.map((option) => {
						const checked = (this.chosen[i] ?? []).includes(option);
						return html`<label class="ask-option" data-checked=${checked}>
							<input
								type=${q.multiSelect ? "checkbox" : "radio"}
								name=${`${this.toolCallId}-${i}`}
								.checked=${checked}
								@change=${() => this.toggle(i, option, q.multiSelect)}
							/>
							<span>${option}</span>
						</label>`;
					})}
					<input
						class="ask-other"
						type="text"
						placeholder=${i18n("Other")}
						.value=${this.other[i] ?? ""}
						@input=${(e: InputEvent) => {
							const value = (e.target as HTMLInputElement).value;
							this.other = this.questions.map((_, j) => (j === i ? value : (this.other[j] ?? "")));
						}}
					/>
				</fieldset>`,
			)}
			<div class="ask-actions">
				<button type="button" class="ask-skip" @click=${() => this.finish(true)}>${i18n("Skip")}</button>
				<button type="button" class="ask-submit" ?disabled=${!complete || !this.open} @click=${() => this.finish(false)}>
					${i18n("Answer")}
				</button>
			</div>
		</div>`;
	}
}

registerToolRenderer("ask_user", {
	render(params: Params | undefined, result, _isStreaming, context) {
		const questions = params?.questions ?? [];
		if (!result) {
			return {
				content: html`${renderHeader("inprogress", MessageCircleQuestion, i18n("Waiting for your answer"))}
					${
						context && questions.length > 0
							? html`<ask-user-form .toolCallId=${context.toolCallId} .questions=${questions}></ask-user-form>`
							: ""
					}`,
				isCustom: false,
			};
		}
		if (result.isError) {
			return { content: renderHeader("error", MessageCircleQuestion, i18n("Not answered")), isCustom: false };
		}
		const details = result.details as Details | undefined;
		if (!details || details.skipped) {
			return { content: renderHeader("complete", MessageCircleQuestion, i18n("Skipped")), isCustom: false };
		}
		return {
			content: html`${renderHeader("complete", MessageCircleQuestion, i18n("Answered"))}
				<dl class="ask-summary">
					${questions.map(
						(q, i) => html`<dt>${q.question}</dt>
							<dd>${details.answers[i]?.join(", ") || "-"}</dd>`,
					)}
				</dl>`,
			isCustom: false,
		};
	},
});
