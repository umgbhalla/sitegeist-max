// Shell <-> frame contract. The shell owns every dial; the frame renders one view.

export type Kit = "ff" | "sg";

export interface SpringTier {
	duration: number;
	bounce: number;
}

export interface LabState {
	view: string;
	frame: { width: number; height: number; theme: "light" | "dark"; zoom: number };
	/** Variant of the current composite. */
	variant: string;
	ff: {
		accent: string;
		shape: "rounded" | "pill";
		size: "default" | "compact";
		icons: "lucide" | "phosphor" | "tabler" | "hugeicons" | "untitledui";
		springs: { fast: SpringTier; moderate: SpringTier; slow: SpringTier };
	};
}

export type FrameMessage = { type: "lab:state"; state: LabState };

export const kitOf = (view: string): Kit => view.split("/")[0] as Kit;
