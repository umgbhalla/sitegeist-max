import assert from "node:assert/strict";
import { test } from "node:test";
import { VerificationShapeTool } from "../src/tools/verification/verification-tool.js";

test("verification tool rejects a tab switch during capture", async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
	let queries = 0;
	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: {
			tabs: {
				query: async () => [{ id: ++queries === 1 ? 7 : 8 }],
				captureVisibleTab: async () => "data:image/png;base64,",
			},
			scripting: { executeScript: async () => [{ result: { width: 100, height: 100 } }] },
		},
	});
	try {
		const tool = new VerificationShapeTool();
		tool.windowId = 1;
		await assert.rejects(
			tool.execute("test", {
				count: 3,
				reference: { x: 0, y: 0, width: 30, height: 10 },
				scene: { x: 0, y: 20, width: 100, height: 80 },
			}),
			/Active tab changed/,
		);
	} finally {
		if (previous) Object.defineProperty(globalThis, "chrome", previous);
		else Reflect.deleteProperty(globalThis, "chrome");
	}
});

test("verification tool rejects a resized viewport during capture", async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
	let measurements = 0;
	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: {
			tabs: { query: async () => [{ id: 7 }], captureVisibleTab: async () => "data:image/png;base64," },
			scripting: { executeScript: async () => [{ result: { width: ++measurements === 1 ? 100 : 101, height: 100 } }] },
		},
	});
	try {
		const tool = new VerificationShapeTool();
		tool.windowId = 1;
		await assert.rejects(
			tool.execute("test", {
				count: 3,
				reference: { x: 0, y: 0, width: 30, height: 10 },
				scene: { x: 0, y: 20, width: 100, height: 80 },
			}),
			/Viewport changed/,
		);
	} finally {
		if (previous) Object.defineProperty(globalThis, "chrome", previous);
		else Reflect.deleteProperty(globalThis, "chrome");
	}
});

test("verification tool discovers frame regions and maps screenshot matches", async () => {
	const keys = ["chrome", "OffscreenCanvas", "createImageBitmap"];
	const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
	const data = new Uint8ClampedArray(110 * 30 * 4).fill(255);
	for (const origin of [1, 12]) {
		for (let y = 1; y <= 10; y++) {
			for (let x = 0; x < 6; x++) {
				if (x > 0 && y < 9 && !(x === 1 && y === 1)) continue;
				const index = (y * 110 + origin + x) * 4;
				data[index] = 0;
				data[index + 1] = 0;
				data[index + 2] = 0;
			}
		}
	}
	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: {
			tabs: { query: async () => [{ id: 7 }], captureVisibleTab: async () => "data:image/png;base64," },
			scripting: {
				executeScript: async (args: { target: { allFrames?: boolean } }) =>
					args.target.allFrames
						? [
								{ frameId: 0, result: { frame: { x: 0, y: 0, width: 110, height: 30 }, references: [], scene: null } },
								{ frameId: 2, result: { references: [{ x: 0, y: 0, width: 9, height: 12 }], scene: { x: 10, y: 0, width: 100, height: 12 }, width: 110, height: 30 } },
							]
						: [{ result: { width: 110, height: 30 } }],
			},
		},
	});
	Object.defineProperty(globalThis, "createImageBitmap", {
		configurable: true,
		value: async () => ({ width: 110, height: 30, close() {} }),
	});
	Object.defineProperty(globalThis, "OffscreenCanvas", {
		configurable: true,
		value: class {
			getContext() {
				return { drawImage() {}, getImageData: () => ({ width: 110, height: 30, data }) };
			}
		},
	});
	try {
		const tool = new VerificationShapeTool();
		tool.windowId = 1;
		const result = await tool.execute("test", { count: 1 });
		assert.equal(result.details.rankings[0][0].x, 15);
		assert.equal(result.details.rankings[0][0].y, 6);
		assert.equal(result.details.nextAction?.action, "inspect_matches");
	} finally {
		keys.forEach((key, index) => {
			const descriptor = previous[index];
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		});
	}
});

test("a supported single-symbol challenge checks markers before submitting", async () => {
	const keys = ["chrome", "OffscreenCanvas", "createImageBitmap"];
	const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
	const data = new Uint8ClampedArray(110 * 30 * 4).fill(255);
	const setBlack = (x: number, y: number) => {
		const index = (y * 110 + x) * 4;
		data[index] = 0;
		data[index + 1] = 0;
		data[index + 2] = 0;
	};
	for (const origin of [1, 12]) {
		for (let y = 1; y <= 10; y++) {
			for (let x = 0; x < 6; x++) {
				if (x === 0 || y >= 9 || (x === 1 && y === 1)) setBlack(origin + x, y);
			}
		}
	}
	for (let y = 1; y <= 10; y++) for (let x = 32; x < 38; x++) setBlack(x, y);
	let markers = 0;
	let success = false;
	const presses: number[] = [];
	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: {
			tabs: { query: async () => [{ id: 7 }], captureVisibleTab: async () => "data:image/png;base64," },
			scripting: {
				executeScript: async (args: { target: { allFrames?: boolean; frameIds?: number[] }; func: () => unknown }) => {
					if (args.target.allFrames) return [
						{ frameId: 0, result: { frame: { x: 0, y: 0, width: 110, height: 30 }, references: [], scene: null } },
						{ frameId: 2, result: { instruction: "Select in order", references: [{ x: 0, y: 0, width: 9, height: 12 }], scene: { x: 10, y: 0, width: 100, height: 12 }, width: 110, height: 30 } },
					];
					if (args.target.frameIds) return [{ result: { identity: "challenge", markers, status: success ? "success" : "open", button: { x: 90, y: 20, width: 10, height: 8 }, width: 110, height: 30 } }];
					if (args.func.toString().includes("tcaptcha_iframe_dy")) return [{ result: { x: 0, y: 0, width: 110, height: 30 } }];
					return [{ result: { width: 110, height: 30 } }];
				},
			},
			debugger: {
				attach: async () => {},
				sendCommand: async (_target: unknown, _command: string, event: { type: string; x: number }) => {
					if (event.type === "mousePressed") presses.push(event.x);
					if (event.type === "mouseReleased") { if (event.x > 80) success = true; else markers++; }
				},
			},
		},
	});
	Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: async () => ({ width: 110, height: 30, close() {} }) });
	Object.defineProperty(globalThis, "OffscreenCanvas", {
		configurable: true,
		value: class {
			getContext() {
				return {
					drawImage() {},
					getImageData: (x: number, y: number, width: number, height: number) => {
						const pixels = new Uint8ClampedArray(width * height * 4);
						for (let row = 0; row < height; row++) pixels.set(data.subarray(((y + row) * 110 + x) * 4, ((y + row) * 110 + x + width) * 4), row * width * 4);
						return { width, height, data: pixels };
					},
				};
			}
		},
	});
	try {
		const tool = new VerificationShapeTool();
		tool.windowId = 1;
		const analysis = await tool.execute("analysis", { count: 1 });
		assert.equal(analysis.details.nextAction?.action, "click_and_verify");
		assert.deepEqual(analysis.details.nextAction?.targets, [{ x: 15, y: 6 }]);
		assert.deepEqual(presses, []);
		const text = analysis.content.find((content) => content.type === "text");
		assert.ok(text && text.type === "text");
		assert.equal(JSON.parse(text.text).nextAction.action, "click_and_verify");
		const result = await tool.execute("test", { count: 1, attempt: true });
		assert.equal(result.details.interaction?.status, "success");
		assert.equal(result.details.interaction?.acknowledged, 1);
		assert.equal(result.details.nextAction?.action, "continue_task");
		assert.deepEqual(presses, [15, 95]);
	} finally {
		keys.forEach((key, index) => {
			const descriptor = previous[index];
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		});
	}
});
