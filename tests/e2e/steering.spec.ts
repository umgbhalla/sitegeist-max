import { expect, sidepanelUrl, test } from "./fixtures";

test("messages sent during a run steer it or queue the next run", async ({ context, extensionId }) => {
	const page = await context.newPage();
	await page.setViewportSize({ width: 420, height: 800 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(
		sidepanelUrl(extensionId, {
			steps: ["Build a page"],
			mock: [
				// An HTML artifact waits for its sandbox logs, which holds the tool round open.
				{ tool: { name: "artifact_create", args: { filename: "page.html", content: "<p>hi</p>" } } },
				{ text: "Steered answer." },
				{ text: "Follow-up answer." },
			],
		}),
	);

	const composer = page.getByPlaceholder("Steer this run. Alt+Enter queues it for next.");
	await expect(composer).toBeVisible();
	await composer.fill("Use dark mode");
	await composer.press("Enter");
	await composer.fill("Then summarize");
	await composer.press("Alt+Enter");

	const queue = page.getByRole("status").filter({ hasText: "Queued" });
	await expect(queue).toContainText("Use dark mode");
	await expect(queue).toContainText("Then summarize");

	await expect(page.getByText("Follow-up answer.")).toBeVisible();
	await expect(queue).toBeHidden();

	// Steer lands inside the first run; the follow-up only after it answered.
	const transcript = await page.locator("message-list").innerText();
	const order = ["Use dark mode", "Steered answer.", "Then summarize", "Follow-up answer."].map((text) =>
		transcript.indexOf(text),
	);
	expect(order.every((index) => index >= 0)).toBe(true);
	expect([...order].sort((a, b) => a - b)).toEqual(order);
	await expect(page.getByPlaceholder("Ask anything or work with a page...")).toBeVisible();
	expect(errors).toEqual([]);
});
