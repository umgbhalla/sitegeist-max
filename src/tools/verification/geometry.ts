import type { Rect } from "./shape.js";

export interface Scale {
	x: number;
	y: number;
}

export function viewportRectToPixels(rect: Rect, scale: Scale): Rect {
	return {
		x: Math.round(rect.x * scale.x),
		y: Math.round(rect.y * scale.y),
		width: Math.round(rect.width * scale.x),
		height: Math.round(rect.height * scale.y),
	};
}

export function pixelRectToViewportCenter(rect: Rect, scale: Scale): { x: number; y: number } {
	return { x: (rect.x + rect.width / 2) / scale.x, y: (rect.y + rect.height / 2) / scale.y };
}

export function frameRectToViewport(rect: Rect, frame: Rect, viewport: { width: number; height: number }): Rect {
	if (viewport.width <= 0 || viewport.height <= 0) throw new Error("Frame viewport is empty");
	return {
		x: frame.x + (rect.x * frame.width) / viewport.width,
		y: frame.y + (rect.y * frame.height) / viewport.height,
		width: (rect.width * frame.width) / viewport.width,
		height: (rect.height * frame.height) / viewport.height,
	};
}
