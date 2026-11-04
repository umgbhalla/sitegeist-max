import { expect, sidepanelUrl, test } from "./fixtures";

test("chat, history and settings are tabs; the chat stays mounted", async ({ context, extensionId }) => {
	const page = await context.newPage();
	await page.setViewportSize({ width: 400, height: 800 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(
		sidepanelUrl(extensionId, {
			steps: ["Summarize this page"],
			mock: [
				{ tool: { name: "artifact_create", args: { filename: "notes.md", content: "# Notes\n\n- one" } } },
				{ text: "Saved notes.md with the summary." },
			],
		}),
	);
	await expect(page.getByText("Saved notes.md with the summary.", { exact: true })).toBeVisible();
	await expect(page.locator("html")).toHaveClass(/dark/);
	await page.waitForTimeout(400); // theme and tab transitions settle
	await page.screenshot({ path: "test-results/ui-chat-dark.png" });

	const tabs = page.getByRole("tablist", { name: "Views" });
	await tabs.getByRole("tab", { name: "Settings" }).click();
	await expect(page.locator("settings-panel")).toBeVisible();
	await expect(page.getByText("Saved notes.md with the summary.", { exact: true })).toBeHidden();
	await page.waitForTimeout(400); // theme and tab transitions settle
	await page.screenshot({ path: "test-results/ui-settings-dark.png" });

	await page.getByRole("radio", { name: "Light" }).click();
	await expect(page.locator("html")).not.toHaveClass(/dark/);
	await page.waitForTimeout(400); // theme and tab transitions settle
	await page.screenshot({ path: "test-results/ui-settings-light.png" });
	await page.getByRole("radio", { name: "Dark" }).click();

	await tabs.getByRole("tab", { name: "History" }).click();
	await expect(page.getByPlaceholder("Search sessions...")).toBeVisible();
	await expect(tabs.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
	await expect(tabs.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "false");
	await page.waitForTimeout(400); // theme and tab transitions settle
	await page.screenshot({ path: "test-results/ui-history-dark.png" });

	await tabs.getByRole("tab").first().click();
	await expect(page.getByText("Saved notes.md with the summary.", { exact: true })).toBeVisible();
	expect(errors).toEqual([]);
});
