import { previewMap } from "../../vendor/ff/app/components/bento-previews";
import type { ViewComponent } from "../frame";
import { FfProvider } from "./ff-provider";

// Fluid Functionalism: the previews its homepage renders (app/components/bento-previews.tsx).
export const FfView: ViewComponent = ({ id, state }) => {
	const Preview = previewMap[id];
	return (
		<FfProvider state={state}>
			<div className="flex min-h-dvh items-start justify-center p-3">
				{Preview ? <Preview /> : <p className="text-muted-foreground">No homepage preview for {id}</p>}
			</div>
		</FfProvider>
	);
};
