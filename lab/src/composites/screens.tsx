// Sitegeist screens, built only from Fluid Functionalism components used as
// published. This file supplies Sitegeist data and layout, nothing else. Every
// element maps to something the extension runs today: real tool names, workflow
// browser sub-agents, the steer queue, artifacts, the model picker.
import { type ComponentType, type ReactNode, useState } from "react";
import { Tabs, TabsItem } from "../../vendor/ff/components/flavored/tabs";
import {
	ThinkingStep,
	ThinkingStepDetails,
	ThinkingSteps,
	ThinkingStepsContent,
	ThinkingStepsHeader,
	ThinkingStepSource,
	ThinkingStepSources,
} from "../../vendor/ff/components/flavored/thinking-steps";
import { ChatMessage } from "../../vendor/ff/registry/default/chat-message";
import {
	CommandMenu,
	CommandMenuEmpty,
	CommandMenuInput,
	type CommandMenuItemData,
	CommandMenuList,
} from "../../vendor/ff/registry/default/command-menu";
import { InputMessage, type QueuedMessage } from "../../vendor/ff/registry/default/input-message";
import { Elevated } from "../../vendor/ff/registry/default/lib/elevated";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../../vendor/ff/registry/default/table";

/** Sidebar column: scrolling transcript over a pinned composer. */
function Panel({ children, composer }: { children: ReactNode; composer: ReactNode }) {
	return (
		<div className="flex h-dvh flex-col">
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">{children}</div>
			<div className="shrink-0 px-2 pb-2">{composer}</div>
		</div>
	);
}

/** The queue is the agent's steer queue: sent while a run is streaming, delivered after the current tool step. */
function Composer({ streaming, initialQueue = [] }: { streaming: boolean; initialQueue?: QueuedMessage[] }) {
	const [value, setValue] = useState("");
	const [queue, setQueue] = useState<QueuedMessage[]>(initialQueue);
	return (
		<InputMessage
			value={value}
			onValueChange={setValue}
			status={streaming ? "streaming" : "idle"}
			queue={queue}
			onQueueChange={setQueue}
			placeholder={streaming ? "Steer this run" : "Ask anything or work with a page..."}
			onSend={() => setValue("")}
		/>
	);
}

const PRICING = [
	{ vendor: "Stripe", fee: "2.9% + 30c", model: "Flat" },
	{ vendor: "Adyen", fee: "Interchange++", model: "Per transaction" },
	{ vendor: "Paddle", fee: "5% + 50c", model: "Merchant of record" },
];

function PricingTable() {
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Vendor</TableHead>
					<TableHead>Card fee</TableHead>
					<TableHead>Model</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{PRICING.map((row, index) => (
					<TableRow key={row.vendor} index={index}>
						<TableCell>{row.vendor}</TableCell>
						<TableCell>{row.fee}</TableCell>
						<TableCell>{row.model}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

/** One assistant turn: reasoning and tool calls, in call order. */
function Run({ done }: { done: boolean }) {
	return (
		<ThinkingSteps defaultOpen className="w-full">
			<ThinkingStepsHeader>{done ? "Worked for 38s" : "Working"}</ThinkingStepsHeader>
			<ThinkingStepsContent>
				<ThinkingStep
					icon="brain"
					label="Thought for 6s"
					description="One browser sub-agent per vendor keeps the pages isolated."
				/>
				<ThinkingStep icon="globe" label="navigate">
					<ThinkingStepSources>
						<ThinkingStepSource>stripe.com/pricing</ThinkingStepSource>
					</ThinkingStepSources>
				</ThinkingStep>
				<ThinkingStep icon="play" label="repl">
					<ThinkingStepDetails summary="3 tables, 41 rows" details={["browserjs: read pricing tables", "stored pricing.json"]} />
				</ThinkingStep>
				<ThinkingStep icon="users" label="workflow" status="complete">
					<ThinkingStepDetails
						summary={done ? "2 browser agents finished" : "2 browser agents, 1 running"}
						details={["adyen.com/pricing: done", done ? "paddle.com/pricing: done" : "paddle.com/pricing: running"]}
						defaultOpen={!done}
					/>
				</ThinkingStep>
				<ThinkingStep icon="pencil" label="artifact_create" status={done ? "complete" : "active"} isLast>
					<ThinkingStepSources>
						<ThinkingStepSource>pricing-summary.md</ThinkingStepSource>
					</ThinkingStepSources>
				</ThinkingStep>
			</ThinkingStepsContent>
		</ThinkingSteps>
	);
}

function ChatRun({ variant }: { variant: string }) {
	const done = variant === "Done";
	return (
		<Panel
			composer={
				<Composer
					streaming={!done}
					initialQueue={done ? [] : [{ id: "q1", text: "Also include Paddle's MoR fee", files: [] }]}
				/>
			}
		>
			<ChatMessage from="user" time="Today 9:41">
				Compare pricing on Stripe, Adyen and Paddle and write a summary
			</ChatMessage>
			<Run done={done} />
			{done && (
				<ChatMessage from="assistant">
					<p>Stripe and Paddle publish flat rates. Adyen prices on Interchange++, so its cost depends on your card mix.</p>
					<PricingTable />
				</ChatMessage>
			)}
		</Panel>
	);
}

/** Artifacts docked above the composer: one tab per file, the selected file's viewer below. */
function Files() {
	const [tab, setTab] = useState(0);
	const files = ["pricing-summary.md", "pricing.json"];
	return (
		<div className="flex h-dvh flex-col">
			<div className="shrink-0 border-b border-border px-2 pt-2 pb-3">
				<Tabs idPrefix="lab-files" selectedIndex={tab} onSelect={setTab} aria-label="Files">
					{files.map((name, i) => (
						<TabsItem key={name} index={i} label={name} />
					))}
				</Tabs>
				<div className="pt-3">
					{tab === 0 ? (
						<PricingTable />
					) : (
						<pre className="overflow-x-auto px-2 font-mono text-[12px] text-muted-foreground">
							{JSON.stringify(PRICING, null, 2)}
						</pre>
					)}
				</div>
			</div>
			<Panel composer={<Composer streaming={false} />}>
				<ChatMessage from="user" time="Today 9:43">
					Save that as a markdown file
				</ChatMessage>
				<ChatMessage from="assistant">Created pricing-summary.md.</ChatMessage>
			</Panel>
		</div>
	);
}

const MODELS: CommandMenuItemData[] = [
	{ value: "claude-opus-5-5", label: "Claude Opus 5.5", description: "Anthropic", group: "Anthropic" },
	{ value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", description: "Anthropic", group: "Anthropic" },
	{ value: "claude-haiku-5-5", label: "Claude Haiku 5.5", description: "Anthropic", group: "Anthropic" },
	{ value: "gpt-6.1-sol", label: "GPT-6.1 Sol", description: "OpenAI", group: "OpenAI" },
	{ value: "gemini-3-pro", label: "Gemini 3 Pro", description: "Google", group: "Google" },
];

function ModelPicker() {
	return (
		<Panel composer={<Composer streaming={false} />}>
			<Elevated offset={2} shadowLevel={3} className="flex max-h-[420px] w-full flex-col overflow-hidden rounded-xl">
				<CommandMenu items={MODELS}>
					<CommandMenuInput placeholder="Search models" />
					<CommandMenuList>
						<CommandMenuEmpty>No model matches</CommandMenuEmpty>
					</CommandMenuList>
				</CommandMenu>
			</Elevated>
		</Panel>
	);
}

export const SCREENS: Record<string, ComponentType<{ variant: string }>> = {
	"chat-run": ChatRun,
	files: Files,
	"model-picker": ModelPicker,
};
