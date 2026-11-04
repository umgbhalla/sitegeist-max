import { spring as ffSpring } from "../vendor/ff/registry/default/lib/springs";
import type { FrameMessage, LabState } from "./protocol";

// Apply the dials that live outside React: theme class, zoom, accent override,
// and Fluid Functionalism's spring tiers (mutated in place: every FF component
// reads `spring.fast` etc. at render, so a remount picks the new values up).
export function applyState(state: LabState) {
	const root = document.documentElement;
	root.classList.toggle("dark", state.frame.theme === "dark");
	root.classList.toggle("light", state.frame.theme === "light");
	document.body.style.zoom = String(state.frame.zoom);
	let style = document.getElementById("lab-overrides");
	if (!style) {
		style = document.createElement("style");
		style.id = "lab-overrides";
		document.head.append(style);
	}
	const rules: string[] = [];
	if (state.ff.accent) rules.push(`:root { --fluid-accent: ${state.ff.accent}; }`);
	style.textContent = rules.join("\n");
	for (const tier of ["fast", "moderate", "slow"] as const) {
		Object.assign(ffSpring[tier], state.ff.springs[tier]);
	}
}

export function onState(listener: (state: LabState) => void) {
	window.addEventListener("message", (event: MessageEvent<FrameMessage>) => {
		if (event.source !== window.parent || event.data?.type !== "lab:state") return;
		applyState(event.data.state);
		listener(event.data.state);
	});
	window.parent.postMessage({ type: "lab:ready" }, "*");
}
