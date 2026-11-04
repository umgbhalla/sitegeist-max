import { COMPOSITES } from "../composites/index";
import { SCREENS } from "../composites/screens";
import type { ViewComponent } from "../frame";
import { FfProvider } from "./ff-provider";

export const SgView: ViewComponent = ({ id, state }) => {
	const Screen = SCREENS[id];
	const meta = COMPOSITES.find((c) => c.id === id);
	const variant = meta?.variants?.includes(state.variant) ? state.variant : (meta?.variants?.[0] ?? "");
	if (!Screen) return <p>Unknown composite: {id}</p>;
	return (
		<FfProvider state={state}>
			<div className="min-h-dvh bg-background text-foreground">
				<Screen key={variant} variant={variant} />
			</div>
		</FfProvider>
	);
};
