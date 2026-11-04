// Every view the lab can render. Kit entries come from Fluid Functionalism's own
// catalog (componentList), so a sync that adds a component adds it here.
import { componentList } from "../vendor/ff/lib/docs/components";
import { COMPOSITES } from "./composites/index";

export interface ViewEntry {
	id: string;
	title: string;
	caption: string;
	group: string;
	variants?: string[];
}

export const VIEWS: ViewEntry[] = [
	...COMPOSITES.map((c) => ({
		id: `sg/${c.id}`,
		title: c.title,
		caption: c.caption,
		group: "Sitegeist composites",
		variants: c.variants,
	})),
	...componentList.map((c) => ({ id: `ff/${c.slug}`, title: c.name, caption: c.description, group: "Fluid Functionalism" })),
];
