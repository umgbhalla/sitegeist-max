// biome-ignore-all lint/suspicious/noExplicitAny: Existing ambient shim for the decorative Three.js orb.
// three ships no bundled types and the site only uses it for the decorative orb
// animation. Declare the handful of symbols it imports loosely (classes so they
// work as both value and type; constants as any) — avoids a hard @types/three
// dev-dep. Mirrors src/types/three.d.ts in the extension.
declare module "three" {
	export class Scene {
		[key: string]: any;
	}
	export class PerspectiveCamera {
		constructor(...args: any[]);
		[key: string]: any;
	}
	export class WebGLRenderer {
		constructor(...args: any[]);
		[key: string]: any;
	}
	export class Mesh {
		constructor(...args: any[]);
		[key: string]: any;
	}
	export class ShaderMaterial {
		constructor(...args: any[]);
		[key: string]: any;
	}
	export class SphereGeometry {
		constructor(...args: any[]);
		[key: string]: any;
	}
	export class Color {
		constructor(...args: any[]);
		[key: string]: any;
	}
	export const AdditiveBlending: any;
	export const BackSide: any;
	export const DoubleSide: any;
}
