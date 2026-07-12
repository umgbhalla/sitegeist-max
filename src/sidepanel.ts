import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
} from "@earendil-works/pi-agent-core";
import { getModel, getModels, type Model } from "@earendil-works/pi-ai";
import {
	ChatPanel,
	createExtractDocumentTool,
	createStreamFn,
	ModelSelector,
	ProxyTab,
	SettingsDialog,
	// PersistentStorageDialog,
	setAppStorage,
	setShowJsonMode,
} from "@earendil-works/pi-web-ui";
import { html, render } from "lit";
import { History, Plus, Settings } from "lucide";
import { AboutTab } from "./dialogs/AboutTab.js";
import { ApiKeyOrOAuthDialog } from "./dialogs/ApiKeyOrOAuthDialog.js";
import { ApiKeysOAuthTab } from "./dialogs/ApiKeysOAuthTab.js";
import { CostsTab } from "./dialogs/CostsTab.js";
import { SessionCostDialog } from "./dialogs/SessionCostDialog.js";
import { SitegeistSessionListDialog } from "./dialogs/SessionListDialog.js";
import { SkillsTab } from "./dialogs/SkillsTab.js";
import { UpdateNotificationDialog } from "./dialogs/UpdateNotificationDialog.js";
import { UserScriptsPermissionDialog } from "./dialogs/UserScriptsPermissionDialog.js";
import { WelcomeSetupDialog } from "./dialogs/WelcomeSetupDialog.js";
import { browserMessageTransformer } from "./messages/message-transformer.js";
import { createNavigationMessage, registerNavigationRenderer } from "./messages/NavigationMessage.js";
import { registerUserMessageRenderer } from "./messages/UserMessageRenderer.js";
import { createWelcomeMessage, registerWelcomeRenderer } from "./messages/WelcomeMessage.js";
import { installLatestModelFilter } from "./models/latest.js";
import { isOAuthCredentials, resolveApiKey } from "./oauth/index.js";
import { SYSTEM_PROMPT } from "./prompts/prompts.js";
import { SitegeistAppStorage } from "./storage/app-storage.js";
import { DebuggerTool } from "./tools/debugger.js";
import { ExtractImageTool, registerExtractImageRenderer } from "./tools/extract-image.js";
import { AskUserWhichElementTool, skillTool } from "./tools/index.js";
import { NativeInputEventsRuntimeProvider } from "./tools/NativeInputEventsRuntimeProvider.js";
import { NavigateTool } from "./tools/navigate.js";
import { BrowserRuntimeProvider } from "./tools/repl/browser/BrowserRuntimeProvider.js";
import { createReplTool } from "./tools/repl/repl.js";
import { BrowserJsRuntimeProvider, NavigateRuntimeProvider } from "./tools/repl/runtime-providers.js";
import { ToolResultsRuntimeProvider } from "./tools/repl/tool-results-runtime-provider.js";
import * as port from "./utils/port.js";
import "./utils/i18n-extension.js";
import "./utils/live-reload.js";
import { tutorials } from "./tutorials.js";

// Restrict the model picker to the latest model of each lineage (installs a
// filter hook into pi-ai's getModels). Must run before any model list renders.
installLatestModelFilter();

// Register custom message renderers
registerNavigationRenderer();
registerExtractImageRenderer();

// Listen for abort messages from REPL overlay.
// Background routes these by stamping targetWindowId; only the sidepanel that
// owns that window may abort, so a Stop click never aborts another window's run.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	console.log("[Sidepanel] Received message:", message, "from:", sender);
	if (message.type === "abort-repl") {
		// Fail CLOSED: only abort when this window's id is known AND the message is
		// explicitly scoped to it. An undefined targetWindowId (background couldn't
		// resolve a window) or an undefined currentWindowId (abort arrived before
		// initApp set it) must NOT abort — otherwise we re-open the original
		// cross-session bug where an unscoped abort aborts every streaming sidepanel.
		if (
			currentWindowId === undefined ||
			message.targetWindowId === undefined ||
			message.targetWindowId !== currentWindowId
		) {
			console.log(
				"[Sidepanel] Ignoring abort-repl for window",
				message.targetWindowId,
				"(this window:",
				currentWindowId,
				")",
			);
			sendResponse({ success: false, reason: "unscoped-or-wrong-window" });
			return true;
		}
		console.log("[Sidepanel] Abort-repl message received, agent streaming:", agent?.state.isStreaming);
		if (agent?.state.isStreaming) {
			console.log("[Sidepanel] Aborting agent...");
			agent.abort();
			sendResponse({ success: true });
		} else {
			console.log("[Sidepanel] Agent not streaming, ignoring");
			sendResponse({ success: false, reason: "not-streaming" });
		}
		return true; // Keep channel open for async response
	}
});

// ============================================================================
// STORAGE SETUP
// ============================================================================
const storage = new SitegeistAppStorage();
setAppStorage(storage);

// ============================================================================
// APP STATE
// ============================================================================
let currentSessionId: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;
let currentWindowId: number | undefined;

// Track which skills we've shown in full (skillName -> lastUpdated timestamp)
// Reset when a new session/agent is created
const shownSkills = new Map<string, string>();

// Track which messages we've already recorded costs for (avoid duplicates)
// Use Set with message object identity (not cleared on session switch - persists in memory)
const recordedCostMessages = new Set<AgentMessage>();

// Cached auth type label for the current provider
let authLabel = "";

const DEFAULT_MODELS: Record<string, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	anthropic: "claude-sonnet-5",
	"azure-openai-responses": "gpt-5.2",
	cerebras: "zai-glm-4.6",
	"github-copilot": "gpt-4o",
	google: "gemini-2.5-flash",
	"google-antigravity": "gemini-3.1-pro-high",
	"google-gemini-cli": "gemini-2.5-pro",
	"google-vertex": "gemini-3-pro-preview",
	groq: "openai/gpt-oss-20b",
	huggingface: "moonshotai/Kimi-K2.5",
	"kimi-coding": "kimi-k2-thinking",
	minimax: "MiniMax-M2.1",
	"minimax-cn": "MiniMax-M2.1",
	mistral: "devstral-medium-latest",
	openai: "gpt-5.6-sol",
	"openai-codex": "gpt-5.6-sol",
	opencode: "claude-opus-4-6",
	"opencode-go": "kimi-k2.5",
	openrouter: "openai/gpt-5.1-codex",
	"vercel-ai-gateway": "anthropic/claude-opus-4-6",
	xai: "grok-4-fast-non-reasoning",
	zai: "glm-4.6",
};

async function selectDefaultModelForAvailableProvider() {
	const providers = await getProvidersWithKeys();
	if (providers.length === 0 || !agent) return;

	// Try each provider with keys and find a default model
	for (const provider of providers) {
		const modelId = DEFAULT_MODELS[provider];
		if (modelId) {
			const model = getModel(provider as any, modelId);
			if (model) {
				agent.state.model = model;
				await storage.settings.set("lastUsedModel", model);
				await updateAuthLabel();
				renderApp();
				return;
			}
		}
	}

	// If no default found, try the first model for the first provider with a key
	for (const provider of providers) {
		const models = getModels(provider as any);
		if (models.length > 0) {
			agent.state.model = models[0];
			await storage.settings.set("lastUsedModel", models[0]);
			await updateAuthLabel();
			renderApp();
			return;
		}
	}
}

async function getProvidersWithKeys(): Promise<string[]> {
	const providers = await storage.providerKeys.list();
	const result: string[] = [];
	for (const provider of providers) {
		const key = await storage.providerKeys.get(provider);
		if (key) result.push(provider);
	}
	return result;
}

async function hasAnyApiKey(): Promise<boolean> {
	const providers = await storage.providerKeys.list();
	return providers.length > 0;
}

function openApiKeysDialog(): Promise<void> {
	return new Promise((resolve) => {
		SettingsDialog.open(
			[new ApiKeysOAuthTab(), new CostsTab(), new SkillsTab(), new ProxyTab(), new AboutTab()],
			resolve,
		);
	});
}

async function updateAuthLabel() {
	if (!agent) {
		authLabel = "";
		return;
	}
	const provider = agent.state.model.provider;
	const stored = await storage.providerKeys.get(provider);
	if (!stored) {
		authLabel = "";
	} else if (isOAuthCredentials(stored)) {
		authLabel = "subscription";
	} else {
		authLabel = "api key";
	}
}

// Export getter for message transformer
export function getShownSkills(): Map<string, string> {
	return shownSkills;
}

// ============================================================================
// HELPERS
// ============================================================================
const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user");
	if (!firstUserMsg || firstUserMsg.role !== "user") return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c) => c.type === "text");
		text = textBlocks.map((c) => c.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const shouldSaveSession = (messages: AgentMessage[]): boolean => {
	const hasUserMsg = messages.some((m: AgentMessage) => m.role === "user");
	const hasAssistantMsg = messages.some((m: AgentMessage) => m.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
};

const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent || !currentTitle) return;

	const state = agent.state;
	if (!shouldSaveSession(state.messages)) return;

	try {
		// Calculate cumulative usage from all assistant messages
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		for (const msg of state.messages) {
			if (msg.role === "assistant") {
				usage.input += msg.usage.input;
				usage.output += msg.usage.output;
				usage.cacheRead += msg.usage.cacheRead;
				usage.cacheWrite += msg.usage.cacheWrite;
				usage.totalTokens += msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
				if (msg.usage.cost) {
					usage.cost.input += msg.usage.cost.input;
					usage.cost.output += msg.usage.cost.output;
					usage.cost.cacheRead += msg.usage.cost.cacheRead;
					usage.cost.cacheWrite += msg.usage.cost.cacheWrite;
					usage.cost.total += msg.usage.cost.total;
				}
			}
		}

		// Generate preview text (first 2KB of user + assistant text)
		let preview = "";
		for (const msg of state.messages) {
			if (preview.length >= 2048) break;
			if (msg.role === "user") {
				const text =
					typeof msg.content === "string"
						? msg.content
						: msg.content
								.filter((c) => c.type === "text")
								.map((c) => c.text)
								.join("\n") || "";
				preview += `${text}\n`;
			} else if (msg.role === "assistant") {
				const text = msg.content
					.filter((c) => c.type === "text" || c.type === "thinking")
					.map((c) => (c.type === "text" ? c.text : c.thinking))
					.join("\n");
				preview += `${text}\n`;
			}
		}
		preview = preview.substring(0, 2048);

		// Preserve createdAt if session already exists
		const existingMetadata = await storage.sessions.getMetadata(currentSessionId);
		const createdAt = existingMetadata?.createdAt || new Date().toISOString();

		const metadata = {
			id: currentSessionId,
			title: currentTitle,
			createdAt,
			lastModified: new Date().toISOString(),
			messageCount: state.messages.length,
			usage,
			modelId: state.model.id,
			thinkingLevel: state.thinkingLevel,
			preview,
		};

		await storage.sessions.saveSession(currentSessionId, state, metadata, currentTitle);
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

// ----------------------------------------------------------------------------
// AGENT EVENT HANDLERS
//
// Split out of the subscriber so each settled observation point is explicit.
// message_end is the ONLY point where state.messages gains a message (the
// runtime pushes via the message_end reducer); message_start/update never push.
// So all transcript-derived work (re-slice, cost, title, save) belongs here,
// not on agent_start/turn_start/message_update where state is incomplete.
// ----------------------------------------------------------------------------

/**
 * Runs for every message_end: user/steering/follow-up, the final assistant
 * message, AND each tool-result message (emitToolResultMessage fires message_end
 * too). The role checks below narrow to the cases that matter.
 */
const handleMessageEnd = (message: AgentMessage) => {
	// pi-agent-core pushes the finished message into the SAME array in place
	// (agent.js message_end reducer), so the array identity never changes and
	// MessageList's identity-based diffing skips the re-render — the streamed
	// text gets cleared but never lands in the stable list. Reassigning through
	// the slicing setter restores a fresh identity BEFORE AgentInterface's
	// later-registered subscriber calls requestUpdate().
	agent.state.messages = agent.state.messages.slice();

	// Record cost from completed assistant messages only. Skip error/aborted
	// turns (handleRunFailure synthesizes an assistant message with a zeroed/
	// absent usage and stopReason "error"|"aborted") — the cost?.total guard
	// already no-ops on those, but gating on stopReason makes intent explicit.
	// recordedCostMessages dedups by stable object identity (state.messages holds
	// stable references) and is reset per session in createAgent.
	if (
		message.role === "assistant" &&
		message.stopReason !== "error" &&
		message.stopReason !== "aborted" &&
		message.usage?.cost?.total > 0 &&
		!recordedCostMessages.has(message)
	) {
		recordedCostMessages.add(message);
		storage.costs
			.recordCost(agent.state.model.provider, agent.state.model.id, message.usage.cost.total)
			.catch((err) => console.error("Failed to record cost:", err));
	}

	const messages = agent.state.messages;

	// Title/save derivation only makes sense once the transcript has settled a
	// user + assistant message — which can only be observed at message_end.
	if (!currentTitle && shouldSaveSession(messages)) {
		currentTitle = generateTitle(messages);
	}

	if (!currentSessionId && shouldSaveSession(messages)) {
		currentSessionId = crypto.randomUUID();

		// currentWindowId is set in initApp(), which always completes before any run
		// can start; handleMessageEnd only fires mid-run, so it is defined here.
		port
			.sendMessage({
				type: "acquireLock",
				sessionId: currentSessionId,
				windowId: currentWindowId as number,
			})
			.then((lockResponse) => {
				if (!lockResponse.success) {
					console.warn("Failed to acquire lock for newly created session", currentSessionId);
				}
			});
		updateUrl(currentSessionId);
	}

	if (currentSessionId) {
		saveSession();
	}

	renderApp();
};

/**
 * Runs once at the end of a run. isStreaming is still TRUE here (agent-core
 * flips it false only in finishRun, after all awaited agent_end listeners
 * settle). So we wait for idle, then force one trailing render with the
 * stop/send composer in its idle state — but only if no new run has started in
 * the meantime, otherwise we'd briefly flash the composer out of streaming mode.
 */
const handleAgentEnd = () => {
	agent
		.waitForIdle()
		.then(() => {
			if (agent.state.isStreaming) return; // a new run already began; leave it.
			chatPanel?.agentInterface?.requestUpdate();
			renderApp();
		})
		.catch(() => {});
};

const createAgent = async (initialState?: Partial<AgentState>, shouldSave = true) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}

	// Reset cost dedup for the new session. recordedCostMessages keys by message
	// object identity; old sessions' message objects are no longer in any agent
	// state, so without this the Set leaks across every session switch.
	recordedCostMessages.clear();

	// Mark all loaded messages as already recorded (by object identity)
	for (const msg of initialState?.messages || []) {
		if (msg.role === "assistant" && msg.usage?.cost?.total > 0) {
			recordedCostMessages.add(msg);
		}
	}

	// Reset skill tracking for new session
	// When loading an old session, we intentionally don't reconstruct shownSkills
	// This ensures that new navigations in the continued session show the LATEST
	// version of skills, even if they were updated since the session was created
	shownSkills.clear();

	// Load debugger mode setting
	const stored = await chrome.storage.local.get("debuggerMode");
	const debuggerModeEnabled = stored.debuggerMode || false;

	// Load CORS proxy settings for extract_document tool
	const corsProxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
	const corsProxyUrl = await storage.settings.get<string>("proxy.url");

	// Determine default model: saved > default for a provider with key > gemini flash fallback
	let defaultModel: Model<any> | undefined;
	if (!initialState?.model) {
		const savedModel = await storage.settings.get<Model<any>>("lastUsedModel");
		if (savedModel) {
			defaultModel = savedModel;
		} else {
			// Try to find a default model for a provider the user already has a key for
			const providersWithKeys = await getProvidersWithKeys();
			for (const provider of providersWithKeys) {
				const modelId = DEFAULT_MODELS[provider];
				if (modelId) {
					const model = getModel(provider as any, modelId);
					if (model) {
						defaultModel = model;
						break;
					}
				}
			}
		}
	}
	// Final fallback
	if (!defaultModel && !initialState?.model) {
		defaultModel = getModel("anthropic", "claude-sonnet-5");
	}

	agent = new Agent({
		initialState: initialState || {
			systemPrompt: SYSTEM_PROMPT,
			model: defaultModel,
			thinkingLevel: "medium",
			messages: [],
			tools: [],
		},
		convertToLlm: browserMessageTransformer,
		toolExecution: "sequential",
		streamFn: createStreamFn(async () => {
			const enabled = await storage.settings.get<boolean>("proxy.enabled");
			if (!enabled) return undefined;
			return (await storage.settings.get<string>("proxy.url")) || undefined;
		}),
		getApiKey: async (provider: string) => {
			const stored = await storage.providerKeys.get(provider);
			if (!stored) return undefined;
			const proxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
			const proxyUrl = proxyEnabled ? (await storage.settings.get<string>("proxy.url")) || undefined : undefined;
			return resolveApiKey(stored, provider, storage.providerKeys, proxyUrl);
		},
	});

	await updateAuthLabel();

	if (shouldSave) {
		// ORDERING DEPENDENCY: this subscriber MUST be registered before
		// AgentInterface/ChatPanel's subscriber (which happens later in
		// chatPanel.setAgent below). agent-core invokes listeners in registration
		// order, so the message_end/agent_end re-slice here restores a fresh array
		// identity BEFORE AgentInterface calls requestUpdate() — otherwise the
		// completed message never re-renders (blank-transcript bug). Do not reorder
		// agent.subscribe() and chatPanel.setAgent() without preserving this.
		agentUnsubscribe = agent.subscribe((event: AgentEvent) => {
			try {
				// EVENT GATING (0.75.3 contract): a single tool turn emits dozens-to-
				// hundreds of events (agent_start, turn_start, message_update*,
				// message_start/end per prompt/assistant/EACH tool-result,
				// tool_execution_* per tool, turn_end, agent_end). Every listener is
				// AWAITED sequentially inside the agent's own loop, so any work done
				// here blocks streaming. We therefore handle ONLY the two settled
				// observation points we care about — message_end (a message just landed
				// in state.messages) and agent_end (run fully done) — and do nothing on
				// the high-frequency start/update/tool events.
				//
				// NOTE: lastUsedModel persistence and the auth label are intentionally
				// NOT refreshed here. The model only changes via onModelSelect / the
				// auto-select paths (state.model mutation); there is no per-event
				// model-change signal, so doing async storage writes on every event was
				// pure throttling of the stream. Those sites own that work now.
				switch (event.type) {
					case "message_end":
						handleMessageEnd(event.message);
						break;
					case "agent_end":
						handleAgentEnd();
						break;
				}
			} catch (err) {
				// Swallow + log: a throw here would propagate into agent-core's
				// awaited listener loop and abort event processing mid-completion,
				// leaving the transcript blank. Never let that happen.
				console.error("[Sidepanel] agent subscriber failed:", err);
			}
		});
	}

	await chatPanel.setAgent(agent, {
		sandboxUrlProvider: () => {
			return chrome.runtime.getURL("sandbox.html");
		},
		onApiKeyRequired: async (provider: string) => {
			return await ApiKeyOrOAuthDialog.prompt(provider);
		},
		onModelSelect: async () => {
			const providers = await getProvidersWithKeys();
			if (providers.length === 0) {
				openApiKeysDialog();
				return;
			}
			ModelSelector.open(
				agent.state.model,
				(model) => {
					// This is the only place the user-driven model actually changes
					// (there is no per-event model-change signal), so persist
					// lastUsedModel and refresh the auth label HERE rather than in the
					// per-event subscriber where it would fire on every stream event.
					agent.state.model = model;
					storage.settings
						.set("lastUsedModel", model)
						.catch((err) => console.error("Failed to save lastUsedModel:", err));
					chatPanel.agentInterface?.requestUpdate();
					updateAuthLabel().catch(() => {});
					renderApp();
				},
				providers,
			);
		},
		onBeforeSend: async () => {
			if (!agent) return;

			// Get current tab info
			const [tab] = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			});
			if (!tab?.url || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("moz-extension://")) return;

			// One-time first-send grounding only. After the first turn the agent
			// PULLS page context itself via browser.activeTab()/browser.tabs();
			// the forced per-turn NavigationMessage inject was removed.
			if (agent.state.messages.some((m) => (m as any).role === "navigation")) return;

			const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
			agent.state.messages = [...agent.state.messages, navMessage];
		},
		onCostClick: () => {
			if (!agent) return;
			SessionCostDialog.open(agent.state.messages);
		},
		toolsFactory: (_agent, _agentInterface, _artifactsPanel, runtimeProvidersFactory) => {
			const navigateTool = new NavigateTool();
			const selectElementTool = new AskUserWhichElementTool();

			// Create extract_document tool with CORS proxy from settings (loaded above)
			const extractDocumentTool = createExtractDocumentTool();
			if (corsProxyEnabled && corsProxyUrl) {
				extractDocumentTool.corsProxyUrl = `${corsProxyUrl}/?url=`;
			}

			const replTool = createReplTool();
			replTool.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");
			// Scope the abort overlay to this window so a Stop click can only abort
			// THIS window's streaming run, never another window's session.
			replTool.windowId = currentWindowId;

			// Extend base providers with browser orchestration capabilities
			replTool.runtimeProvidersFactory = () => {
				// Providers that should be available in page context via browserjs()
				const pageProviders = [
					...runtimeProvidersFactory(), // attachments + artifacts from ChatPanel
					new NativeInputEventsRuntimeProvider(), // trusted browser events
				];

				return [
					...pageProviders, // Make them available in REPL context too
					new ToolResultsRuntimeProvider(agent),
					new BrowserJsRuntimeProvider(pageProviders), // Pass to page context
					new NavigateRuntimeProvider(navigateTool),
					// REPL-sandbox-only: owns its own page/CDP access; must NOT be
					// re-injected into the userScript world (not in pageProviders).
					new BrowserRuntimeProvider(),
				];
			};

			const extractImageTool = new ExtractImageTool();
			extractImageTool.windowId = currentWindowId;

			// ponytail: `as unknown as` bridges typebox-v1 method/property variance.
			// Tools conform structurally; drop the cast when the tool spec is redesigned.
			const tools: AgentTool<any, any>[] = [
				navigateTool,
				selectElementTool,
				replTool,
				skillTool,
				extractDocumentTool,
				extractImageTool,
			] as unknown as AgentTool<any, any>[];

			// Conditionally add debugger tool if enabled
			if (debuggerModeEnabled) {
				const debuggerTool = new DebuggerTool();
				tools.push(debuggerTool as unknown as AgentTool<any, any>);
			}

			return tools;
		},
	});

	// Register custom message renderers after agentInterface is available
	if (chatPanel.agentInterface) {
		registerWelcomeRenderer(agent, chatPanel.agentInterface);

		// Only disable auto-scroll for new sessions with welcome message
		// Check if this is a fresh session (only has welcome message, no user messages)
		const hasUserMessage = agent.state.messages.some((m) => m.role === "user");
		if (!hasUserMessage) {
			chatPanel.agentInterface.setAutoScroll(false);

			// Re-enable auto-scroll on first user message
			let unsubscribe: (() => void) | undefined;
			unsubscribe = agent.subscribe(() => {
				const hasUserMsg = agent.state.messages.some((m) => m.role === "user");
				if (hasUserMsg && unsubscribe) {
					chatPanel.agentInterface?.setAutoScroll(true);
					unsubscribe();
				}
			});
		}
	}
};

const loadSession = (sessionId: string) => {
	// Navigation will disconnect port and auto-release locks
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.location.href = url.toString();
};

const newSession = () => {
	// Navigation will disconnect port and auto-release locks
	const url = new URL(window.location.href);
	url.search = "?new=true";
	window.location.href = url.toString();
};

// ============================================================================
// RENDER
// ============================================================================

// Stable render root. Rendering into #app (not document.body) isolates lit's
// container, so a render throw can only ever blank #app, never sibling/body
// structure. Falls back to document.body if #app is somehow missing.
const getAppRoot = (): HTMLElement => document.getElementById("app") ?? document.body;

const renderApp = () => {
	const appHtml = html`
		<div class="w-full h-full flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-2 px-3 py-2">
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(History, "sm"),
						onClick: () => {
							SitegeistSessionListDialog.open(
								(sessionId: string) => {
									loadSession(sessionId);
								},
								(deletedSessionId: string) => {
									// Only reload if the current session was deleted
									if (deletedSessionId === currentSessionId) {
										newSession();
									}
								},
							);
						},
						title: "Sessions",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Plus, "sm"),
						onClick: newSession,
						title: "New Session",
					})}

					${
						currentTitle
							? isEditingTitle
								? html`<div class="flex items-center gap-2">
									${Input({
										type: "text",
										value: currentTitle,
										className: "text-sm w-48",
										/*
										TODO need to add this in Input in mini-lit
										onBlur: async (e: Event) => {
											const newTitle = (e.target as HTMLInputElement).value.trim();
											if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
												await storage.sessions.updateTitle(currentSessionId, newTitle);
												currentTitle = newTitle;
											}
											isEditingTitle = false;
											renderApp();
										},*/
										onKeyDown: async (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												const newTitle = (e.target as HTMLInputElement).value.trim();
												if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
													await storage.sessions.updateTitle(currentSessionId, newTitle);
													currentTitle = newTitle;
												}
												isEditingTitle = false;
												renderApp();
											} else if (e.key === "Escape") {
												isEditingTitle = false;
												renderApp();
											}
										},
									})}
								</div>`
								: html`<button
									class="px-2 py-1 text-xs text-foreground hover:bg-secondary rounded transition-colors truncate max-w-[150px]"
									@click=${() => {
										isEditingTitle = true;
										renderApp();
										requestAnimationFrame(() => {
											const input = document.body.querySelector('input[type="text"]') as HTMLInputElement;
											if (input) {
												input.focus();
												input.select();
											}
										});
									}}
									title="Click to edit title"
								>
									${currentTitle}
								</button>`
							: html``
					}
				</div>
				<div class="flex items-center gap-1 px-2">
					${agent ? html`<span class="text-[10px] text-muted-foreground truncate max-w-[120px]" title="${agent.state.model.provider}/${agent.state.model.id}${authLabel ? ` (${authLabel})` : ""}">${agent.state.model.provider}${authLabel ? html` <span class="text-[9px] opacity-70">${authLabel}</span>` : ""}</span>` : ""}
					<theme-toggle></theme-toggle>
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () =>
							SettingsDialog.open([
								new ApiKeysOAuthTab(),
								new CostsTab(),
								new SkillsTab(),
								new ProxyTab(),
								new AboutTab(),
							]),
						title: "Settings",
					})}
				</div>
			</div>

			<!-- Chat Panel -->
			${chatPanel}
		</div>
	`;

	// Guard the render so a throw can't propagate into agent-core's awaited
	// listener loop (which would leave a half-cleared transcript / blank panel).
	try {
		render(appHtml, getAppRoot());
	} catch (err) {
		console.error("[Sidepanel] renderApp failed:", err);
	}
};

// ============================================================================
// TAB NAVIGATION TRACKING
// ============================================================================

// Tab switches/updates no longer force a NavigationMessage into the agent.
// The agent pulls current tab state on demand via browser.activeTab() / browser.tabs().
// (Removed onUpdated/onActivated auto-steer: it spammed a nav pill on every switch
//  and leaked chrome:// pages past the chrome-extension:// guard.)

// ============================================================================
// KEYBOARD SHORTCUTS
// ============================================================================
window.addEventListener(
	"keydown",
	(e) => {
		// Escape key to abort streaming - works globally in sidepanel
		// Use capturing phase to intercept before MessageEditor handles it
		if (e.key === "Escape" && agent?.state.isStreaming) {
			e.preventDefault();
			e.stopPropagation();
			agent.abort();
		}

		// Cmd+U (Mac) or Ctrl+U (Windows/Linux) to open debug page
		if ((e.metaKey || e.ctrlKey) && e.key === "u") {
			e.preventDefault();
			window.location.href = "./debug.html";
		}

		// Cmd+Shift+K (Mac) or Ctrl+Shift+K (Windows/Linux) to show session costs
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
			e.preventDefault();
			if (agent?.state.messages && agent.state.messages.length > 0) {
				SessionCostDialog.open(agent.state.messages);
			}
		}
	},
	true,
); // Use capture phase to intercept Escape before it reaches MessageEditor

// ============================================================================
// TEST STEPS FROM DEBUGGER.TS
// ============================================================================
async function testSteps(): Promise<boolean> {
	const urlParams = new URLSearchParams(window.location.search);
	const testStepsParam = urlParams.get("teststeps");
	const testProvider = urlParams.get("provider");
	const testModel = urlParams.get("model");

	if (!testStepsParam) return false;

	// Handle test prompts - create temporary session without saving
	try {
		const testSteps = JSON.parse(decodeURIComponent(testStepsParam)) as string[];

		// Set model if specified
		let initialState: Partial<AgentState> | undefined;
		if (testProvider && testModel) {
			const model = getModel(testProvider as any, testModel);
			if (model) {
				initialState = {
					systemPrompt: SYSTEM_PROMPT,
					model,
				};
			}
		}

		await createAgent(initialState, false);
		renderApp();

		// Wait for UI to render
		await new Promise((resolve) => requestAnimationFrame(resolve));

		// Submit prompts sequentially
		for (let i = 0; i < testSteps.length; i++) {
			const step = testSteps[i];
			if (!chatPanel?.agentInterface) break;

			// Send the prompt
			await chatPanel.agentInterface.sendMessage(step);

			// Wait for agent to finish (not streaming anymore)
			if (i < testSteps.length - 1) {
				// Wait for response to complete before sending next step
				await new Promise<void>((resolve) => {
					const checkComplete = () => {
						if (!chatPanel.agent?.state.isStreaming) {
							resolve();
						} else {
							setTimeout(checkComplete, 100);
						}
					};
					checkComplete();
				});
			}
		}
		return true;
	} catch (err) {
		console.error("Failed to run test steps:", err);
		return false;
	}
}

// ============================================================================
// UPDATE CHECK
// ============================================================================
function isNewerVersion(latest: string, current: string): boolean {
	const latestParts = latest.split(".").map(Number);
	const currentParts = current.split(".").map(Number);

	for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
		const l = latestParts[i] || 0;
		const c = currentParts[i] || 0;
		if (l > c) return true;
		if (l < c) return false;
	}
	return false;
}

async function checkForUpdates() {
	try {
		const currentVersion = chrome.runtime.getManifest().version;

		// Fetch latest version
		const response = await fetch("https://sitegeist.ai/uploads/version.json", {
			cache: "no-cache",
		});
		const data = await response.json();
		const latestVersion = data.version;

		// Show dialog only if server version is newer than current version
		if (isNewerVersion(latestVersion, currentVersion)) {
			// Show update dialog - blocks until extension is updated and restarted
			await UpdateNotificationDialog.show(latestVersion);
		}
	} catch (err) {
		console.warn("[Sidepanel] Failed to check for updates:", err);
		// Silently fail - don't block startup
	}
}

// ============================================================================
// INIT
// ============================================================================
async function initApp() {
	// Show loading
	render(
		html`
			<div class="w-full h-full flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">Loading...</div>
			</div>
		`,
		getAppRoot(),
	);

	// Load showJsonMode setting
	const stored = await chrome.storage.local.get("showJsonMode");
	const showJsonModeEnabled = (stored.showJsonMode as boolean) || false;
	setShowJsonMode(showJsonModeEnabled);

	// Get current window ID for filtering tab events
	const currentWindow = await chrome.windows.getCurrent();
	if (!currentWindow.id) {
		throw new Error("Failed to get current window ID");
	}
	currentWindowId = currentWindow.id;

	// Initialize port communication system
	port.initialize(currentWindowId);

	// TODO reenable Request persistent storage
	// if (storage.sessions) {
	// 	await PersistentStorageDialog.request();
	// }

	// Request userScripts permission if not available
	if (!chrome.userScripts) {
		await UserScriptsPermissionDialog.request();
	}

	// TODO: re-enable update check when publishing to users
	// await checkForUpdates();

	// Initialize default skills
	const { initializeDefaultSkills } = await import("./tools/skill.js");
	await initializeDefaultSkills();

	// Proxy disabled — CORS is handled locally via declarativeNetRequest rules
	await storage.settings.set("proxy.enabled", false);

	// Create ChatPanel
	chatPanel = new ChatPanel();

	// Handle test steps
	if (await testSteps()) {
		return;
	}

	// Check for session in URL
	const urlParams = new URLSearchParams(window.location.search);
	let sessionIdFromUrl = urlParams.get("session");
	const isNewSession = urlParams.get("new") === "true";

	// If no session in URL and not explicitly creating new, try to load the most recent session
	if (!sessionIdFromUrl && !isNewSession && storage.sessions) {
		const latestSessionId = await storage.sessions.getLatestSessionId();
		if (latestSessionId) {
			// Try to acquire lock for latest session
			const lockResponse = await port.sendMessage({
				type: "acquireLock",
				sessionId: latestSessionId,
				windowId: currentWindowId,
			});

			if (lockResponse.success) {
				sessionIdFromUrl = latestSessionId;
				// Update URL to include the latest session
				updateUrl(latestSessionId);
			}
			// If lock fails, fall through to create new session
		}
	}

	if (sessionIdFromUrl && storage.sessions) {
		const sessionData = await storage.sessions.loadSession(sessionIdFromUrl);
		if (sessionData) {
			// Try to acquire lock if we don't already have it (in case user navigated directly via URL)
			const lockResponse = await port.sendMessage({
				type: "acquireLock",
				sessionId: sessionIdFromUrl,
				windowId: currentWindowId,
			});

			if (!lockResponse.success) {
				// Session is locked in another window - show landing page instead
				await createAgent();
				if (agent) {
					const welcomeMessage = createWelcomeMessage(tutorials);
					agent.state.messages = [...agent.state.messages, welcomeMessage];
				}
				renderApp();
				return;
			}

			currentSessionId = sessionIdFromUrl;
			const metadata = await storage.sessions.getMetadata(sessionIdFromUrl);
			currentTitle = metadata?.title || "";

			await createAgent({
				systemPrompt: SYSTEM_PROMPT,
				model: sessionData.model,
				thinkingLevel: sessionData.thinkingLevel,
				messages: sessionData.messages,
				tools: [],
			});

			renderApp();
			return;
		} else {
			// Session doesn't exist, redirect to new session
			newSession();
			return;
		}
	}

	// No session - create new agent with welcome message
	await createAgent();

	// Add welcome message for new sessions
	if (agent) {
		const welcomeMessage = createWelcomeMessage(tutorials);
		agent.state.messages = [...agent.state.messages, welcomeMessage];
	}

	renderApp();

	// If no API keys configured, show welcome dialog, open settings, then auto-select model
	if (!(await hasAnyApiKey())) {
		await WelcomeSetupDialog.show();
		await openApiKeysDialog();
		await selectDefaultModelForAvailableProvider();
		renderApp();
	}
}

// Register custom user message renderer early, before any session loads
registerUserMessageRenderer();

initApp();
