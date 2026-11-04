import { get, put, required } from "./store.js";

interface GoogleSession {
	id: string;
	token: string;
	expires: number;
	email: string;
	sub: string;
}
async function identity(token: string): Promise<{ email: string; sub: string }> {
	const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok) throw new Error("Google identity verification failed; reconnect Sheets");
	const profile = (await response.json()) as { email?: string; sub?: string; email_verified?: boolean };
	if (!profile.email || !profile.sub || !profile.email_verified)
		throw new Error("Google did not return a verified account identity");
	return { email: profile.email, sub: profile.sub };
}
export async function connectSheets(clientId: string, expectedEmail: string) {
	if (!clientId.endsWith(".apps.googleusercontent.com") || !expectedEmail.includes("@"))
		throw new Error("Provide a Google OAuth client ID and exact expected account email");
	const state = crypto.randomUUID();
	const redirect = chrome.identity.getRedirectURL("sheets");
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.search = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirect,
		response_type: "token",
		scope: "openid email https://www.googleapis.com/auth/spreadsheets",
		state,
		login_hint: expectedEmail,
		prompt: "select_account",
	}).toString();
	const callback = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
	if (!callback || !callback.startsWith(`${redirect}#`)) throw new Error("Unexpected OAuth callback");
	const values = new URLSearchParams(new URL(callback).hash.slice(1));
	if (values.get("state") !== state || !values.get("access_token"))
		throw new Error("Google sign-in was not completed");
	const token = values.get("access_token")!;
	const account = await identity(token);
	if (account.email.toLowerCase() !== expectedEmail.toLowerCase())
		throw new Error("Signed-in Google account does not match expected email; no credentials saved");
	await put<GoogleSession>("settings", {
		id: "google-sheets",
		token,
		expires: Date.now() + Number(values.get("expires_in") ?? 3600) * 1000,
		...account,
	});
	return { ...account, connected: true, redirectUri: redirect };
}
async function session(expectedEmail: string) {
	const saved = await required<GoogleSession>("settings", "google-sheets");
	if (saved.expires < Date.now() + 30000) throw new Error("Sheets authorization expired; reconnect");
	const current = await identity(saved.token);
	if (current.sub !== saved.sub || current.email.toLowerCase() !== expectedEmail.toLowerCase())
		throw new Error("Google account mismatch; no spreadsheet changes made");
	return { ...saved, ...current };
}
export async function sheetsIdentity() {
	const connection = await get<GoogleConnection>("settings", "google-connection");
	if (connection?.pending) return { connected: false, pending: true, expectedEmail: connection.expectedEmail };
	if (connection?.error)
		return { connected: false, error: connection.error, redirectUri: chrome.identity.getRedirectURL("sheets") };
	const saved = await get<GoogleSession>("settings", "google-sheets");
	if (!saved) return { connected: false, redirectUri: chrome.identity.getRedirectURL("sheets") };
	const current = await session(saved.email);
	return { connected: true, email: current.email, sub: current.sub, expires: current.expires };
}
export interface SheetTab {
	title: string;
	rows: (string | number | boolean | null)[][];
}
export async function appendSheetTabs(options: { spreadsheetId: string; expectedEmail: string; tabs: SheetTab[] }) {
	if (!/^[\w-]+$/.test(options.spreadsheetId) || !options.tabs.length)
		throw new Error("Spreadsheet ID and new tabs are required");
	const account = await session(options.expectedEmail);
	const headers = { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" };
	const root = `https://sheets.googleapis.com/v4/spreadsheets/${options.spreadsheetId}`;
	const response = await fetch(`${root}?fields=spreadsheetId,sheets.properties`, { headers });
	if (!response.ok) throw new Error(`Cannot read spreadsheet: HTTP ${response.status}`);
	const before = (await response.json()) as { sheets: { properties: { sheetId: number; title: string } }[] };
	const titles = new Set(before.sheets.map((sheet) => sheet.properties.title));
	const ids = new Set(before.sheets.map((sheet) => sheet.properties.sheetId));
	const requests: object[] = [];
	const added: { sheetId: number; title: string }[] = [];
	for (const tab of options.tabs) {
		if (!tab.title || tab.title.length > 100 || titles.has(tab.title))
			throw new Error(`Tab already exists or title is invalid: ${tab.title}`);
		titles.add(tab.title);
		let sheetId: number;
		do {
			sheetId = crypto.getRandomValues(new Uint32Array(1))[0] % 2_000_000_000;
		} while (ids.has(sheetId));
		ids.add(sheetId);
		const properties = { sheetId, title: tab.title };
		added.push(properties);
		requests.push({
			addSheet: {
				properties: {
					...properties,
					gridProperties: {
						rowCount: Math.max(1000, tab.rows.length),
						columnCount: Math.max(26, ...tab.rows.map((row) => row.length)),
					},
				},
			},
		});
		requests.push({
			updateCells: {
				start: { sheetId, rowIndex: 0, columnIndex: 0 },
				rows: tab.rows.map((row) => ({
					values: row.map((value) => ({
						userEnteredValue:
							value === null
								? {}
								: typeof value === "number"
									? { numberValue: value }
									: typeof value === "boolean"
										? { boolValue: value }
										: { stringValue: value },
					})),
				})),
				fields: "userEnteredValue",
			},
		});
	}
	// Single atomic batch targets newly allocated sheet IDs only. No sharing API.
	const written = await fetch(`${root}:batchUpdate`, { method: "POST", headers, body: JSON.stringify({ requests }) });
	if (!written.ok) throw new Error(`Sheets batch rejected: HTTP ${written.status}; inspect before retrying`);
	return {
		spreadsheetId: options.spreadsheetId,
		account: { email: account.email, sub: account.sub },
		added,
		existingTabs: before.sheets.map((sheet) => sheet.properties),
		sharingChanged: false,
	};
}

interface GoogleConnection {
	id: string;
	pending: boolean;
	expectedEmail: string;
	error?: string;
}
export async function startSheetsConnection(clientId: string, expectedEmail: string) {
	const existing = await get<GoogleConnection>("settings", "google-connection");
	if (existing?.pending) return { pending: true, expectedEmail: existing.expectedEmail };
	await put<GoogleConnection>("settings", { id: "google-connection", pending: true, expectedEmail });
	void connectSheets(clientId, expectedEmail).then(
		() => put<GoogleConnection>("settings", { id: "google-connection", pending: false, expectedEmail }),
		() =>
			put<GoogleConnection>("settings", {
				id: "google-connection",
				pending: false,
				expectedEmail,
				error: "Google connection failed; check client registration, redirect URI and selected account",
			}),
	);
	return { pending: true, expectedEmail };
}
