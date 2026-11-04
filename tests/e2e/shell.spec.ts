import { expect, sidepanelUrl, test } from "./fixtures";

// Baseline gate: the pi-web-ui shell loads inside the real MV3 extension, the
// agent loop runs, and a mocked assistant turn renders in the transcript — with
// zero real LLM calls. This is the regression gate for the pi 0.80.6 retarget.
test("shell renders + chat round-trip (mock LLM)", async ({ context, extensionId }) => {
	const page = await context.newPage();
	const errors: string[] = [];
	const logs: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));

	await page.goto(
		sidepanelUrl(extensionId, {
			steps: ["say hi"],
			mock: [{ text: "Hello from the mock LLM" }],
		}),
	);

	// getByText pierces open shadow DOM (Lit/mini-lit components); body.textContent does not.
	try {
		await expect(page.getByText("Hello from the mock LLM")).toBeVisible({ timeout: 20_000 });
	} catch (e) {
		console.log("=== CONSOLE ===\n" + logs.join("\n"));
		console.log("=== PAGEERRORS ===\n" + errors.join("\n"));
		const deep = await page.evaluate(() => {
			const acc: string[] = [];
			const rec = (node: Node) => {
				node.childNodes.forEach((c) => {
					if (c.nodeType === 3 && c.textContent?.trim()) acc.push(c.textContent.trim());
					if (c.nodeType === 1) {
						rec(c);
						const sr = (c as HTMLElement).shadowRoot;
						if (sr) rec(sr);
					}
				});
			};
			rec(document.body);
			return acc;
		});
		console.log("=== DEEP TEXT (shadow-pierced) ===\n" + deep.join(" | "));
		console.log("=== ARIA SNAPSHOT ===\n" + (await page.locator("body").ariaSnapshot()));
		await page.screenshot({ path: "test-results/shell-fail.png", fullPage: true });
		throw e;
	}
	await expect(page.locator("message-editor")).toContainText("gpt-6.1-sol");
	await expect(page.getByPlaceholder("Ask anything or work with a page...")).toBeVisible();
	// Fluid Functionalism surface-1, dark by default.
	await expect(page.locator("html")).toHaveClass(/dark/);
	for (const dark of [false, true]) {
		await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), dark);
		await expect(page.locator("body")).toHaveCSS("background-color", dark ? "rgb(23, 23, 23)" : "rgb(250, 250, 250)");
		await expect(page.locator(".user-message-container")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await expect(page.locator(".user-message-container").locator("..")).toHaveCSS("justify-content", "flex-end");
	}
	await page.locator("message-editor").getByRole("combobox").click();
	await expect(page.getByRole("option")).toHaveText(["Low", "Medium", "High", "Extra High", "Max"]);
	await page.getByRole("option", { name: "Max", exact: true }).click();
	await expect(page.locator("message-editor").getByRole("combobox")).toContainText("Max");
	expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
});

test("test startup preserves stored subscription credentials", async ({ context, extensionId }) => {
	const page = await context.newPage();
	await page.goto(sidepanelUrl(extensionId, { steps: ["hi"], mock: [{ text: "Credentials check ready" }] }));
	await expect(page.getByText("Credentials check ready")).toBeVisible();
	const saved = await page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("sitegeist-storage");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const values = ["anthropic", "openai-codex"].map(providerId => JSON.stringify({
			type: "oauth", providerId, access: "test-access", refresh: "test-refresh", expires: Date.now() + 3600000,
		}));
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction("provider-keys", "readwrite");
			["anthropic", "openai-codex"].forEach((provider, i) => tx.objectStore("provider-keys").put(values[i], provider));
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		db.close();
		return values;
	});
	await page.reload();
	await expect(page.getByText("Credentials check ready")).toBeVisible();
	const actual = await page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("sitegeist-storage");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const values = await Promise.all(["anthropic", "openai-codex"].map(provider => new Promise<string>((resolve, reject) => {
			const request = db.transaction("provider-keys").objectStore("provider-keys").get(provider);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		})));
		db.close();
		return values;
	});
	expect(actual).toEqual(saved);
});
