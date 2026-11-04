import { type ComponentType, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./lab-base.css";
import { onState } from "./frame-state";
import { kitOf, type LabState } from "./protocol";

export type ViewComponent = ComponentType<{ id: string; state: LabState }>;

const view = new URLSearchParams(location.search).get("view") ?? "sg/chat-run";
const kit = kitOf(view);

// Kit views and composites both render on Fluid Functionalism's stylesheet.
async function loadKit(): Promise<ViewComponent> {
	await import("./kit.css");
	return kit === "ff" ? (await import("./views/ff")).FfView : (await import("./views/sg")).SgView;
}

function Frame({ View }: { View: ViewComponent }) {
	const [state, setState] = useState<LabState | null>(null);
	useEffect(() => onState(setState), []);
	if (!state) return null;
	return <View id={view.slice(kit.length + 1)} state={state} />;
}

loadKit().then((View) => {
	createRoot(document.getElementById("root")!).render(
		<StrictMode>
			<Frame View={View} />
		</StrictMode>,
	);
});
