/** An absolute deadline whose timer can be cancelled after successful work. */
export function deadlineSignal(
	deadline: number,
	message: string,
	parent?: AbortSignal,
): {
	signal: AbortSignal;
	dispose: () => void;
} {
	const controller = new AbortController();
	const remaining = Math.ceil(deadline - performance.now());
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expire = () => controller.abort(new DOMException(message, "TimeoutError"));
	if (remaining <= 0) expire();
	else timer = setTimeout(expire, remaining);
	return {
		signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
		dispose: () => {
			if (timer !== undefined) clearTimeout(timer);
		},
	};
}
