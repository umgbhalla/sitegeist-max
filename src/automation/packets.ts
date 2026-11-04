import JSZip from "jszip";
import { all, get, insertFile, required, safeName } from "./store.js";

export interface PacketFile {
	id: string;
	packet: string;
	name: string;
	mime: string;
	base64: string;
	size: number;
	sha256: string;
	createdAt: number;
}
export function bytes(base64: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
export function base64(data: Uint8Array): string {
	let text = "";
	for (let i = 0; i < data.length; i += 8192) text += String.fromCharCode(...data.subarray(i, i + 8192));
	return btoa(text);
}
export async function hash(data: Uint8Array): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data))), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}
export function fileInfo(file: PacketFile): Omit<PacketFile, "base64"> {
	const { base64: _, ...info } = file;
	return info;
}
export async function saveFile(
	packet: string,
	name: string,
	data: string,
	mime = "application/octet-stream",
	encoding: "base64" | "text" = "base64",
) {
	safeName(packet);
	if (packet.includes("/")) throw new Error("Packet names cannot contain slashes");
	safeName(name);
	if (name === "manifest.json") throw new Error("manifest.json is reserved for the validated export manifest");
	const content = encoding === "text" ? new TextEncoder().encode(data) : bytes(data);
	if (content.length > 64 * 1024 * 1024) throw new Error("File exceeds 64 MiB limit");
	const id = `${packet}/${name}`;
	const sha256 = await hash(content);
	const previous = await get<PacketFile>("files", id);
	if (previous && previous.sha256 !== sha256)
		throw new Error(`File already exists with different content: ${name}; use a new name`);
	const file: PacketFile = {
		id,
		packet,
		name,
		mime,
		base64: base64(content),
		size: content.length,
		sha256,
		createdAt: Date.now(),
	};
	return await insertFile(fileInfo(previous ?? file), file.base64);
}
export async function listFiles(packet: string) {
	return (await all<PacketFile>("files")).filter((file) => file.packet === packet).map(fileInfo);
}
export async function validatePacket(packet: string, expected: string[]) {
	if (!expected.length || new Set(expected).size !== expected.length)
		throw new Error("Provide a non-empty, unique expected file list");
	const files: PacketFile[] = [];
	for (const name of expected) {
		safeName(name);
		const file = await readFile(packet, name);
		const data = bytes(file.base64);
		if (data.length !== file.size || (await hash(data)) !== file.sha256)
			throw new Error(`File integrity failure: ${name}`);
		files.push(file);
	}
	const actual = await listFiles(packet);
	const unexpected = actual.filter((file) => !expected.includes(file.name)).map((file) => file.name);
	return { packet, valid: true, files: files.map(fileInfo), unexpected };
}
export async function exportPacket(packet: string, expected: string[]) {
	const manifest = await validatePacket(packet, expected);
	if (manifest.unexpected.length) throw new Error(`Unlisted packet files: ${manifest.unexpected.join(", ")}`);
	if (manifest.files.reduce((n, file) => n + file.size, 0) > 250 * 1024 * 1024)
		throw new Error("Packet exceeds 250 MiB export limit; split it into smaller packets");
	const zip = new JSZip();
	for (const info of manifest.files) {
		const file = await readFile(info.packet, info.name);
		zip.file(file.name, file.base64, { base64: true });
	}
	zip.file("manifest.json", JSON.stringify(manifest, null, 2));
	const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
	const reopened = await JSZip.loadAsync(data, { checkCRC32: true });
	for (const file of manifest.files) {
		const entry = reopened.file(file.name);
		if (!entry || (await hash(await entry.async("uint8array"))) !== file.sha256)
			throw new Error(`ZIP verification failed: ${file.name}`);
	}
	const downloadId = await chrome.downloads.download({
		url: `data:application/zip;base64,${base64(data)}`,
		filename: `${safeName(packet)}.zip`,
		saveAs: false,
		conflictAction: "uniquify",
	});
	return {
		packet,
		downloadId,
		sha256: await hash(data),
		size: data.length,
		files: manifest.files.length,
		verified: true,
	};
}

export async function readFile(packet: string, name: string): Promise<PacketFile> {
	const info = await required<Omit<PacketFile, "base64">>("files", `${packet}/${name}`);
	const content = await required<{ id: string; base64: string }>("file-content", info.id);
	return { ...info, base64: content.base64 };
}
