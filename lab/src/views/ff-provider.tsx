import type { ReactNode } from "react";
import { hugeiconsIcons } from "../../vendor/ff/registry/default/lib/icons-hugeicons";
import { phosphorIcons } from "../../vendor/ff/registry/default/lib/icons-phosphor";
import { tablerIcons } from "../../vendor/ff/registry/default/lib/icons-tabler";
import { untitleduiIcons } from "../../vendor/ff/registry/default/lib/icons-untitledui";
import { FluidProvider } from "../../vendor/ff/registry/default/lib/fluid-provider";
import type { LabState } from "../protocol";

const ICON_SETS = {
	lucide: undefined,
	phosphor: phosphorIcons,
	tabler: tablerIcons,
	hugeicons: hugeiconsIcons,
	untitledui: untitleduiIcons,
};

/** Fluid Functionalism's own provider; remounted when a provider dial or spring changes. */
export function FfProvider({ state, children }: { state: LabState; children: ReactNode }) {
	const { shape, size, icons, springs } = state.ff;
	return (
		<FluidProvider key={JSON.stringify({ shape, size, icons, springs })} shape={shape} size={size} icons={ICON_SETS[icons]}>
			{children}
		</FluidProvider>
	);
}
