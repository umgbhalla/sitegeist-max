// three ships no bundled types and the site only uses it for the decorative orb
// animation. Declare the handful of symbols it imports loosely (classes so they
// work as both value and type; constants as any) — avoids a hard @types/three
// dev-dep. Mirrors src/types/three.d.ts in the extension.
declare module "three" {
	// biome-ignore lint/suspicious/noExplicitAny: loose shim for a decorative import
	export class Scene {
		[key: string]: any;
	}
	// biome-ignore lint/suspicious/noExplicitAny: loose shim
	export class PerspectiveCamera {
		constructor(...args: any[]);
		[key: string]: any;
	}
	// biome-ignore lint/suspicious/noExplicitAny: loose shim
	export class WebGLRenderer {
		constructor(...args: any[]);
		[key: string]: any;
	}
	// biome-ignore lint/suspicious/noExplicitAny: loose shim
	export class Mesh {
		constructor(...args: any[]);
		[key: string]: any;
	}
	// biome-ignore lint/suspicious/noExplicitAny: loose shim
	export class ShaderMaterial {
		constructor(...args: any[]);
		[key: string]: any;
	}
	// biome-ignore lint/suspicious/noExplicitAny: loose shim
	export class SphereGeometry {
		constructor(...args: any[]);
		[key: string]: any;
	}
	// biome-ignore lint/suspicious/noExplicitAny: loose shim
	export class Color {
		constructor(...args: any[]);
		[key: string]: any;
	}
	// biome-ignore lint/suspicious/noExplicitAny: loose shim
	export const AdditiveBlending: any;
	// biome-ignore lint/suspicious/noExplicitAny: loose shim
	export const BackSide: any;
	// biome-ignore lint/suspicious/noExplicitAny: loose shim
	export const DoubleSide: any;
}
