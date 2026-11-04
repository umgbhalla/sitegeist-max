import { expect, sidepanelUrl, test } from "./fixtures";

// A shopping-research run shaped like real use: reasoning, several repl steps,
// a question to the user mid-run, a file, then the answer. Checks the run reads
// as one step column with one summary line, the question form round-trips, and
// queued messages can be edited.
test("a multi-step run groups into one column; ask_user pauses for an answer", async ({ context, extensionId }) => {
	const page = await context.newPage();
	await page.setViewportSize({ width: 420, height: 860 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	const repl = (title: string) => ({ name: "repl", args: { title, code: `console.log(${JSON.stringify(title)})` } });
	await page.goto(
		sidepanelUrl(extensionId, {
			steps: ["Find a wireless JetKVM on Superbuy under $80"],
			mock: [
				{ thinking: "Search controls first, then query in Chinese.", tool: repl("Locate Superbuy search controls") },
				{ tool: repl("Enter Chinese JetKVM wireless search") },
				{ tool: repl("Read wireless KVM results") },
				{
					thinking: "Two listings fit; the cheaper one ships without the Wi-Fi module.",
					tool: {
						name: "ask_user",
						args: {
							questions: [
								{
									question: "Which listing should I open?",
									options: ["JetKVM Wireless, $74", "JetKVM Pro with Wi-Fi, $79"],
									multiSelect: false,
								},
							],
						},
					},
				},
				{ tool: { name: "artifact_create", args: { filename: "jetkvm.md", content: "# JetKVM\n\n- Pro with Wi-Fi, $79" } } },
				{ text: "Opened the JetKVM Pro with Wi-Fi listing ($79) and saved the comparison to jetkvm.md." },
			],
		}),
	);

	const form = page.locator("ask-user-form");
	await expect(form).toBeVisible();
	await expect(form.getByText("Which listing should I open?")).toBeVisible();

	// While the run waits, a steer can be queued, switched to next-run and removed.
	const composer = page.locator("message-editor textarea");
	await composer.fill("Prefer sellers with returns");
	await composer.press("Enter");
	const queue = page.getByRole("status").filter({ hasText: "Queued" });
	await expect(queue).toContainText("Prefer sellers with returns");
	await queue.getByRole("button", { name: "Steer" }).click();
	await expect(queue.getByRole("button", { name: "Next" })).toBeVisible();
	await page.waitForTimeout(300);
	await page.screenshot({ path: "test-results/ui-run-waiting.png" });
	await queue.getByTitle("Remove").click();
	await expect(queue).toBeHidden();

	await expect(form.getByRole("button", { name: "Answer" })).toBeDisabled();
	await form.getByText("JetKVM Pro with Wi-Fi, $79").click();
	await form.getByRole("button", { name: "Answer" }).click();

	await expect(page.getByText("saved the comparison to jetkvm.md", { exact: false })).toBeVisible();
	await expect(page.getByText("Answered")).toBeVisible();
	// One run, one summary: 5 tool calls, summed cost of 6 mock turns.
	const footer = page.locator(".run-footer");
	await expect(footer).toHaveCount(1);
	await expect(footer).toContainText("5 steps");
	await expect(footer).toContainText("$0.0738");
	await page.waitForTimeout(300);
	await page.screenshot({ path: "test-results/ui-run-done.png" });

	// Prompt history: Up in the empty composer recalls the last sent prompt.
	await composer.click();
	await composer.press("ArrowUp");
	await expect(composer).toHaveValue("Prefer sellers with returns");
	expect(errors).toEqual([]);
});
