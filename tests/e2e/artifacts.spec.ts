import type { ChatPanel } from "../../src/vendor/web-ui/ChatPanel.js";
import { expect, sidepanelUrl, test } from "./fixtures";

for (const width of [390, 1100]) {
	test(`files stay closed and previews preserve chat at ${width}px`, async ({ context, extensionId }) => {
		const page = await context.newPage();
		await page.setViewportSize({ width, height: 800 });
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(String(error)));
		await page.goto(sidepanelUrl(extensionId, {
			steps: ["Create a report"],
			mock: [
				{ tool: { name: "artifact_create", args: { filename: "report.md", content: "# Findings\nA short report." } } },
				{ text: "Your report is ready." },
			],
		}));
		await expect(page.getByText("Your report is ready.")).toBeVisible();
		const files = page.getByRole("button", { name: /^Files/ });
		const preview = page.getByRole("region", { name: "File preview" });
		await expect(files).toHaveAttribute("aria-expanded", "false");
		await expect(preview).toBeHidden();
		await page.getByRole("button", { name: "Preview report.md", exact: true }).first().click();
		await expect(preview).toBeVisible();
		await expect(preview.getByRole("heading", { name: "Findings" })).toBeVisible();
		const composer = page.getByPlaceholder("Ask anything or work with a page...");
		await composer.fill("Follow up while viewing a file");
		const inputBounds = await composer.boundingBox();
		const previewBounds = await preview.boundingBox();
		expect(inputBounds).not.toBeNull();
		expect(previewBounds).not.toBeNull();
		if (!inputBounds || !previewBounds) throw new Error("Missing layout bounds");
		expect(inputBounds.y + inputBounds.height).toBeLessThanOrEqual(800);
		if (width < 800) expect(previewBounds.y + previewBounds.height).toBeLessThanOrEqual(inputBounds.y);
		else expect(inputBounds.x + inputBounds.width).toBeLessThanOrEqual(previewBounds.x);
		await page.evaluate(async () => {
			const panel = document.querySelector<ChatPanel>("pi-chat-panel")!;
			await panel.artifactsPanel!.runOperation("create", { filename: "data.json", content: '{"count":2}' });
			await panel.artifactsPanel!.runOperation("write", { filename: "data.json", content: '{"count":3}' });
		});
		await expect(files).toContainText("2");
		await expect(preview.getByRole("heading", { name: "Findings" })).toBeVisible();
		await expect(composer).toHaveValue("Follow up while viewing a file");
		await page.screenshot({ path: `test-results/files-${width}.png` });
		await preview.getByRole("button", { name: "report.md", exact: true }).focus();
		await page.keyboard.press("Escape");
		await expect(preview).toBeHidden();
		await expect(files).toBeFocused();
		await page.evaluate(async () => {
			const panel = document.querySelector<ChatPanel>("pi-chat-panel")!;
			await panel.artifactsPanel!.runOperation("create", { filename: "notes.md", content: "# Notes" });
		});
		await expect(files).toContainText("3");
		await expect(preview).toBeHidden();
		await files.click();
		await expect(preview).toBeVisible();
		expect(errors).toEqual([]);
	});
}
