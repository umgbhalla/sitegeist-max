import type { TypesafeConfig } from "./verification-sdk/index.js";

declare const __TYPESAFE_ENABLED__: boolean;

let localConfig: Promise<TypesafeConfig | undefined> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only the private local build has this flag and its untracked config file. */
export function loadTypesafeConfig(): Promise<TypesafeConfig | undefined> {
	if (typeof __TYPESAFE_ENABLED__ === "undefined" || !__TYPESAFE_ENABLED__) return Promise.resolve(undefined);
	localConfig ??= fetch(chrome.runtime.getURL("typesafe.local.json")).then(async (response) => {
		if (!response.ok) throw new Error("Typesafe local configuration is unavailable");
		const value: unknown = await response.json();
		if (
			!isRecord(value) ||
			typeof value.apiKey !== "string" ||
			!value.apiKey ||
			typeof value.baseUrl !== "string" ||
			typeof value.model !== "string"
		) {
			throw new Error("Typesafe local configuration is invalid");
		}
		return { apiKey: value.apiKey, baseUrl: value.baseUrl, model: value.model };
	});
	return localConfig;
}
