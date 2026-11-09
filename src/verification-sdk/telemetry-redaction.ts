export function telemetryUrl(value: string): string {
	try {
		const url = new URL(value);
		return /^https?:$/.test(url.protocol) ? `${url.origin}${url.pathname}` : `[${url.protocol} omitted]`;
	} catch {
		return "[relative URL omitted]";
	}
}

export function redactTelemetryText(value: string, secrets: readonly string[] = []): string {
	let result = value;
	for (const secret of secrets) if (secret.length >= 6) result = result.split(secret).join("[redacted]");
	return result
		.replace(/\bapikey_[A-Za-z0-9_]+/g, "[redacted]")
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
		.replace(
			/((?:api[_-]?key|authorization|cookie|password|passwd|secret|token|ticket|session[_-]?(?:id|token)?|nonce|signature)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/gi,
			'$1"[redacted]"',
		)
		.replace(/https?:\/\/[^\s"'<>`\\)]+/gi, (url) => telemetryUrl(url))
		.replace(/url\(\s*["']?([^"')]*?)["']?\s*\)/gi, (_match, url: string) => `url(${telemetryUrl(url)})`)
		.replace(/(["'])(\/[^"'\s?#]*)(?:[?#][^"']*)\1/g, "$1$2$1");
}

export type SanitizationOmission = "depth" | "string" | "array" | "object";

export function sanitizeTelemetry(
	value: unknown,
	secrets: readonly string[] = [],
	depth = 0,
	onOmission?: (kind: SanitizationOmission, count: number) => void,
): unknown {
	if (depth > 15) {
		onOmission?.("depth", 1);
		return "[depth limit]";
	}
	if (typeof value === "string") {
		return redactTelemetryText(value, secrets);
	}
	if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return value;
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeTelemetry(item, secrets, depth + 1, onOmission));
	}
	if (typeof value !== "object") return String(value);
	const result: Record<string, unknown> = {};
	const entries = Object.entries(value);
	for (const [key, item] of entries)
		result[key] =
			/^(?:api[_-]?key|authorization|cookie|password|passwd|secret|token|ticket|session[_-]?(?:id|token)?|nonce|signature|access[_-]?token|refresh[_-]?token)$/i.test(
				key,
			)
				? "[redacted]"
				: sanitizeTelemetry(item, secrets, depth + 1, onOmission);
	return result;
}
