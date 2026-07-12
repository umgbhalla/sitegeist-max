import { expect, sidepanelUrl, test } from "./fixtures";

// Verifies browser-native dynamic workflows end-to-end: the assistant calls the
// `workflow` tool with a script that fans out real pi sub-agents via
// agent()/parallel()/phase(); each sub-agent dequeues a mock turn; the progress
// panel reflects real agent-loop completion. Zero network.
test("workflow tool runs agents + progress panel completes", async ({ context, extensionId }) => {
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));

	const script = [
		"phase('scan');",
		"const a = await agent('do A');",
		"phase('review');",
		"const b = await parallel([() => agent('do B1'), () => agent('do B2')]);",
		"log('synthesizing');",
		"return 'done:' + a + '|' + b.join(',');",
	].join("\n");

	await page.goto(
		sidepanelUrl(extensionId, {
			steps: ["run demo workflow"],
			mock: [
				{ tool: { name: "workflow", args: { title: "demo", script } } },
				{ text: "A result" },
				{ text: "B1 result" },
				{ text: "B2 result" },
				{ text: "workflow complete" },
			],
		}),
	);

	// The live progress panel (real panel, not the streaming placeholder) renders.
	await expect(page.locator("workflow-progress-panel")).toBeVisible({ timeout: 30_000 });
	// At least one phase and the 3 spawned agents, all reaching done.
	await expect(page.getByTestId("workflow-phase").first()).toBeVisible();
	await expect(page.getByTestId("workflow-agent").first()).toHaveAttribute("data-state", "done", { timeout: 30_000 });
	expect(await page.getByTestId("workflow-agent").count()).toBeGreaterThanOrEqual(3);

	expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
});
