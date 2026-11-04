// Separate database: automation records must survive panel and worker restarts.
const DATABASE = "sitegeist-automation";
export const STORES = [
	"captures",
	"responses",
	"response-bodies",
	"files",
	"file-content",
	"tools",
	"jobs",
	"steps",
	"settings",
] as const;
type StoreName = (typeof STORES)[number];
let connection: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
	connection ??= new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE, 2);
		request.onupgradeneeded = () => {
			for (const name of STORES)
				if (!request.result.objectStoreNames.contains(name))
					request.result.createObjectStore(name, { keyPath: "id" });
			const tx = request.transaction!;
			for (const [from, to, field] of [
				["files", "file-content", "base64"],
				["responses", "response-bodies", "body"],
			]) {
				const cursor = tx.objectStore(from).openCursor();
				cursor.onsuccess = () => {
					const entry = cursor.result;
					if (!entry) return;
					const value = entry.value as Record<string, unknown>;
					if (typeof value[field] === "string") {
						tx.objectStore(to).put({
							id: value.id,
							[field]: value[field],
							...(field === "body" ? { base64Encoded: value.base64Encoded } : {}),
						});
						delete value[field];
						entry.update(value);
					}
					entry.continue();
				};
			}
		};
		request.onsuccess = () => {
			request.result.onversionchange = () => {
				request.result.close();
				connection = undefined;
			};
			resolve(request.result);
		};
		request.onerror = () => {
			connection = undefined;
			reject(request.error);
		};
	});
	return connection;
}
export async function get<T>(store: StoreName, id: string): Promise<T | undefined> {
	const db = await database();
	return new Promise((resolve, reject) => {
		const request = db.transaction(store).objectStore(store).get(id);
		request.onsuccess = () => resolve(request.result as T | undefined);
		request.onerror = () => reject(request.error);
	});
}
export async function put<T extends { id: string }>(store: StoreName, value: T): Promise<T> {
	const db = await database();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(store, "readwrite");
		tx.objectStore(store).put(value);
		tx.oncomplete = () => resolve(value);
		tx.onabort = tx.onerror = () => reject(tx.error);
	});
}
export async function all<T>(store: StoreName): Promise<T[]> {
	const db = await database();
	return new Promise((resolve, reject) => {
		const request = db.transaction(store).objectStore(store).getAll();
		request.onsuccess = () => resolve(request.result as T[]);
		request.onerror = () => reject(request.error);
	});
}
export async function required<T>(store: StoreName, id: string): Promise<T> {
	const value = await get<T>(store, id);
	if (!value) throw new Error(`Missing ${store} record: ${id}`);
	return value;
}
export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
export function safeName(name: string): string {
	if (
		!name ||
		name.length > 200 ||
		name.includes("\\") ||
		name.startsWith("/") ||
		name.split("/").some((p) => !p || p === "." || p === "..") ||
		/[\x00-\x1f]/.test(name)
	)
		throw new Error("Invalid relative file name");
	return name;
}
export function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				/authorization|cookie|token|secret|password|csrf|api.?key/i.test(key) ? "[redacted]" : redact(item),
			]),
		);
	return value;
}
export function publicUrl(raw: string): string {
	try {
		const url = new URL(raw);
		url.username = "";
		url.password = "";
		url.hash = "";
		for (const key of url.searchParams.keys())
			if (/token|key|auth|sign|secret|credential|code/i.test(key)) url.searchParams.set(key, "[redacted]");
		return url.href;
	} catch {
		return "[invalid URL]";
	}
}

// Compare and insert in one transaction so concurrent writers cannot overwrite evidence.
export async function insertFile<T extends { id: string; sha256: string }>(value: T, content: string): Promise<T> {
	const db = await database();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(["files", "file-content"], "readwrite");
		const store = tx.objectStore("files");
		let result = value;
		let conflict = false;
		const request = store.get(value.id);
		request.onsuccess = () => {
			const previous = request.result as T | undefined;
			if (previous && previous.sha256 !== value.sha256) {
				conflict = true;
				tx.abort();
				return;
			}
			if (previous) result = previous;
			else {
				store.add(value);
				tx.objectStore("file-content").add({ id: value.id, base64: content });
			}
		};
		tx.oncomplete = () => resolve(result);
		tx.onabort = tx.onerror = () =>
			reject(conflict ? new Error(`File already exists with different content: ${value.id}`) : tx.error);
	});
}

export async function mutate<T extends { id: string }>(
	storeName: StoreName,
	id: string,
	change: (previous: T | undefined) => T,
): Promise<T> {
	const db = await database();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, "readwrite");
		const store = tx.objectStore(storeName);
		let value: T;
		let failure: unknown;
		const request = store.get(id);
		request.onsuccess = () => {
			try {
				value = change(request.result as T | undefined);
				store.put(value);
			} catch (error) {
				failure = error;
				tx.abort();
			}
		};
		tx.oncomplete = () => resolve(value);
		tx.onabort = tx.onerror = () => reject(failure ?? tx.error);
	});
}
