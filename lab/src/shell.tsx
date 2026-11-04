import { type DialConfig, DialRoot, useDialKit, useDialKitController } from "dialkit";
import "dialkit/styles.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { VIEWS, type ViewEntry } from "./catalog";
import type { LabState, SpringTier } from "./protocol";
import "./shell.css";

// Upstream defaults: vendor/ff/registry/default/lib/springs.ts.
const SPRINGS = { fast: [0.08, 0], moderate: [0.16, 0], slow: [0.24, 0.12] } as const;

type Range = [number, number, number, number];

const frameConfig = {
	width: [400, 260, 900, 1] as Range,
	height: [780, 360, 1100, 1] as Range,
	theme: {
		type: "select" as const,
		options: ["light", "dark"],
		default: new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light",
	},
	zoom: [1, 0.75, 1.5, 0.05] as Range,
} satisfies DialConfig;

const springDial = ([visualDuration, bounce]: readonly [number, number]) => ({
	type: "spring" as const,
	visualDuration,
	bounce,
});

const ffConfig = {
	shape: { type: "select" as const, options: ["rounded", "pill"], default: "rounded" },
	size: { type: "select" as const, options: ["default", "compact"], default: "default" },
	icons: {
		type: "select" as const,
		options: ["lucide", "phosphor", "tabler", "hugeicons", "untitledui"],
		default: "lucide",
	},
	overrideAccent: false,
	accent: { type: "color" as const, default: "#6B97FF" },
	springs: { fast: springDial(SPRINGS.fast), moderate: springDial(SPRINGS.moderate), slow: springDial(SPRINGS.slow) },
} satisfies DialConfig;

type SpringValue = { visualDuration?: number; bounce?: number };
const tier = (value: unknown, fallback: readonly [number, number]): SpringTier => {
	const v = value as SpringValue;
	return { duration: v?.visualDuration ?? fallback[0], bounce: v?.bounce ?? fallback[1] };
};

const initialView = () => new URLSearchParams(location.search).get("view") ?? VIEWS[0].id;

/** The view's own variants as a select. Keyed by view, so each view registers its own panel. */
function VariantPanel({ entry, onChange }: { entry: ViewEntry; onChange: (variant: string) => void }) {
	const options = entry.variants && entry.variants.length > 0 ? entry.variants : ["default"];
	const values = useDialKit(`View: ${entry.title}`, { variant: { type: "select", options, default: options[0] } });
	useEffect(() => onChange(values.variant), [values.variant, onChange]);
	return null;
}

function Lab() {
	const [viewId, setViewId] = useState(initialView);
	const [filter, setFilter] = useState("");
	const [saved, setSaved] = useState<string[]>([]);
	const [status, setStatus] = useState("");
	const entry = VIEWS.find((v) => v.id === viewId) ?? VIEWS[0];

	const frame = useDialKitController("Frame", frameConfig);
	const ff = useDialKitController("Fluid Functionalism", ffConfig);
	const [variant, setVariant] = useState("");

	const state: LabState = useMemo(
		() => ({
			view: entry.id,
			variant,
			frame: {
				width: frame.values.width,
				height: frame.values.height,
				theme: frame.values.theme as LabState["frame"]["theme"],
				zoom: frame.values.zoom,
			},
			ff: {
				shape: ff.values.shape as LabState["ff"]["shape"],
				size: ff.values.size as LabState["ff"]["size"],
				icons: ff.values.icons as LabState["ff"]["icons"],
				accent: ff.values.overrideAccent ? ff.values.accent : "",
				springs: {
					fast: tier(ff.values.springs.fast, SPRINGS.fast),
					moderate: tier(ff.values.springs.moderate, SPRINGS.moderate),
					slow: tier(ff.values.springs.slow, SPRINGS.slow),
				},
			},
		}),
		[entry.id, variant, frame.values, ff.values],
	);

	// Push state to the frame on every change, and again when it (re)loads.
	const iframe = useRef<HTMLIFrameElement>(null);
	const stateRef = useRef(state);
	stateRef.current = state;
	const push = useCallback(() => {
		iframe.current?.contentWindow?.postMessage({ type: "lab:state", state: stateRef.current }, "*");
	}, []);
	useEffect(push, [state, push]);
	useEffect(() => {
		const onReady = (event: MessageEvent) => {
			if (event.data?.type === "lab:ready") push();
		};
		window.addEventListener("message", onReady);
		return () => window.removeEventListener("message", onReady);
	}, [push]);

	// Dragging the frame corner writes back into the Frame dials.
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const observer = new ResizeObserver(() => {
			const width = Math.round(el.offsetWidth);
			const height = Math.round(el.offsetHeight);
			const current = frame.getValues();
			if (width !== current.width || height !== current.height) frame.setValues({ width, height });
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [frame]);

	const refreshSaved = useCallback(() => {
		fetch("/api/state/")
			.then((r) => r.json())
			.then((files: string[]) => setSaved(files.map((f) => f.replace(/\.json$/, ""))));
	}, []);
	useEffect(refreshSaved, [refreshSaved]);

	const fileName = (id: string) => id.replace(/\//g, "__");

	// Switching views restores that view's saved dials, if any.
	useEffect(() => {
		const url = new URL(location.href);
		url.searchParams.set("view", viewId);
		history.replaceState(null, "", url);
		fetch(`/api/state/${fileName(viewId)}`)
			.then((r) => r.json())
			.then((record: { dials?: { frame?: object; ff?: object } } | null) => {
				if (!record?.dials) return;
				if (record.dials.frame) frame.setValues(record.dials.frame as never);
				if (record.dials.ff) ff.setValues(record.dials.ff as never);
				setStatus("Restored saved dials");
			});
	}, [viewId, frame, ff]);

	const save = async (name: string) => {
		const body = {
			state,
			dials: { frame: frame.getValues(), ff: ff.getValues(), variant },
		};
		const res = await fetch(`/api/state/${name}`, { method: "POST", body: JSON.stringify(body) });
		const { file } = (await res.json()) as { file: string };
		setStatus(`Saved ${file}`);
		refreshSaved();
	};

	const groups = useMemo(() => {
		const q = filter.trim().toLowerCase();
		const map = new Map<string, ViewEntry[]>();
		for (const view of VIEWS) {
			if (q && !`${view.title} ${view.caption}`.toLowerCase().includes(q)) continue;
			map.set(view.group, [...(map.get(view.group) ?? []), view]);
		}
		return [...map];
	}, [filter]);

	return (
		<div className="lab">
			<nav className="lab-nav" aria-label="Views">
				<input placeholder="Filter views" value={filter} onChange={(e) => setFilter(e.target.value)} />
				{groups.map(([group, views]) => (
					<section key={group}>
						<div className="lab-group">{group}</div>
						{views.map((view) => (
							<button
								key={view.id}
								type="button"
								className="lab-item"
								aria-current={view.id === viewId}
								onClick={() => setViewId(view.id)}
							>
								{view.title}
								{saved.includes(fileName(view.id)) && <span className="lab-saved">saved</span>}
							</button>
						))}
					</section>
				))}
			</nav>
			<main className="lab-stage">
				<div className="lab-bar">
					<h1>{entry.title}</h1>
					<p title={entry.caption}>{entry.caption}</p>
					<span className="lab-status">{status}</span>
					<button type="button" onClick={() => save(fileName(viewId))}>
						Save view state
					</button>
					<button type="button" onClick={() => save("final")}>
						Save as final
					</button>
				</div>
				<div className="lab-canvas">
					<div
						ref={box}
						className="lab-frame"
						style={{ width: state.frame.width, height: state.frame.height }}
					>
						<iframe ref={iframe} key={viewId} title={entry.title} src={`/frame.html?view=${encodeURIComponent(viewId)}`} />
					</div>
					<div className="lab-size">
						{state.frame.width} x {state.frame.height} {state.frame.zoom !== 1 ? `@ ${state.frame.zoom}x` : ""}
					</div>
				</div>
			</main>
			<VariantPanel key={entry.id} entry={entry} onChange={setVariant} />
			<aside className="lab-dials">
				<DialRoot mode="inline" />
			</aside>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<Lab />);
