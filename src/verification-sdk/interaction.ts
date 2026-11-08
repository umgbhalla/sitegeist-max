export interface Point {
	x: number;
	y: number;
}

export interface Match extends Point {
	width: number;
	height: number;
	score: number;
}

/** Heuristics reject ambiguous matches; scores are not calibrated probabilities. */
export function selectUnambiguousMatches(rankings: Match[][]): Point[] | null {
	if (!rankings.length) return null;
	const chosen = rankings.map((list) => list[0]);
	for (const list of rankings) {
		const first = list[0];
		if (!first || first.score < 0.96) return null;
		const alternative = list
			.slice(1)
			.find(
				(candidate) =>
					Math.abs(candidate.x - first.x) > Math.max(candidate.width, first.width) / 2 ||
					Math.abs(candidate.y - first.y) > Math.max(candidate.height, first.height) / 2,
			);
		if (!alternative || first.score - alternative.score < 0.06) return null;
	}
	for (let i = 0; i < chosen.length; i++) {
		for (let j = i + 1; j < chosen.length; j++) {
			if (Math.hypot(chosen[i].x - chosen[j].x, chosen[i].y - chosen[j].y) <= 30) return null;
		}
	}
	return chosen.map(({ x, y }) => ({ x, y }));
}

export interface ChallengeState {
	identity: string;
	markers: number;
	status: "open" | "success" | "failure" | "missing";
}

export interface InteractionDriver {
	inspect(): Promise<ChallengeState>;
	click(point: Point): Promise<void>;
	submit(): Promise<void>;
	wait(): Promise<void>;
}

export interface InteractionResult {
	status: "success" | "failure" | "changed" | "uncertain";
	acknowledged: number;
	submissionAttempted: boolean;
	reason: string;
	events?: {
		event:
			| "input_started"
			| "input_dispatched"
			| "input_uncertain"
			| "acknowledged"
			| "submission_started"
			| "submission_dispatched";
		atMs: number;
		index?: number;
		point?: Point;
	}[];
}

/** Never retries input: only an observed marker advances the sequence. */
export async function executeOrderedClicks(
	driver: InteractionDriver,
	identity: string,
	points: Point[],
	signal?: AbortSignal,
	deadline?: number,
): Promise<InteractionResult> {
	let acknowledged = 0;
	const started = performance.now();
	const events: NonNullable<InteractionResult["events"]> = [];
	const record = (event: NonNullable<InteractionResult["events"]>[number]["event"], point?: Point) => {
		events.push({ event, atMs: Math.round(performance.now() - started), index: acknowledged, point });
	};
	const result = (
		status: InteractionResult["status"],
		submissionAttempted: boolean,
		reason: string,
	): InteractionResult => ({
		status,
		acknowledged,
		submissionAttempted,
		reason,
		events,
	});
	const inspect = async () => {
		try {
			return await driver.inspect();
		} catch {
			return null;
		}
	};
	if (!points.length) return result("uncertain", false, "No targets");
	for (const point of points) {
		if (signal?.aborted) return result("uncertain", false, "Aborted");
		if (deadline !== undefined && performance.now() >= deadline)
			return result("uncertain", false, "Time limit reached");
		const before = await inspect();
		if (signal?.aborted) return result("uncertain", false, "Aborted before input");
		if (!before) return result("uncertain", false, "Could not inspect challenge state");
		if (before.identity !== identity || before.status === "missing")
			return result("changed", false, "Challenge changed");
		if (before.status !== "open" || before.markers !== acknowledged)
			return result("uncertain", false, "Unexpected selection state");
		if (deadline !== undefined && performance.now() >= deadline)
			return result("uncertain", false, "Time limit reached");
		try {
			record("input_started", point);
			await driver.click(point);
			record("input_dispatched", point);
		} catch {
			record("input_uncertain", point);
			return result("uncertain", false, "Input dispatch failed; selection may have changed");
		}
		let accepted = false;
		for (let poll = 0; poll < 10; poll++) {
			if (signal?.aborted) return result("uncertain", false, "Aborted while waiting for acknowledgement");
			if (deadline !== undefined && performance.now() >= deadline)
				return result("uncertain", false, "Time limit reached while waiting for acknowledgement");
			const after = await inspect();
			if (signal?.aborted) return result("uncertain", false, "Aborted while waiting for acknowledgement");
			if (!after) return result("uncertain", false, "Could not inspect acknowledgement");
			if (after.identity !== identity || after.status === "missing")
				return result("changed", false, "Challenge changed after input");
			if (after.status !== "open") return result("uncertain", false, "Challenge state changed after input");
			if (after.markers === acknowledged + 1) {
				accepted = true;
				break;
			}
			if (after.markers !== acknowledged) return result("uncertain", false, "Unexpected marker count");
			if (poll < 9) {
				try {
					await driver.wait();
				} catch {
					return result("uncertain", false, "Could not wait for acknowledgement");
				}
			}
		}
		if (!accepted) return result("uncertain", false, "Selection acknowledgement not observed");
		record("acknowledged", point);
		acknowledged++;
	}
	if (signal?.aborted) return result("uncertain", false, "Aborted before submission");
	if (deadline !== undefined && performance.now() >= deadline)
		return result("uncertain", false, "Time limit reached before submission");
	const beforeSubmit = await inspect();
	if (signal?.aborted) return result("uncertain", false, "Aborted before submission");
	if (!beforeSubmit) return result("uncertain", false, "Could not inspect selections before submission");
	if (beforeSubmit.identity !== identity || beforeSubmit.status === "missing")
		return result("changed", false, "Challenge changed before submission");
	if (beforeSubmit.status !== "open" || beforeSubmit.markers !== acknowledged)
		return result("uncertain", false, "Selections changed before submission");
	if (deadline !== undefined && performance.now() >= deadline)
		return result("uncertain", false, "Time limit reached before submission");
	try {
		record("submission_started");
		await driver.submit();
		record("submission_dispatched");
	} catch {
		return result("uncertain", true, "Submission dispatch failed; outcome may have changed");
	}
	for (let poll = 0; poll < 8; poll++) {
		if (signal?.aborted || (deadline !== undefined && performance.now() >= deadline))
			return result("uncertain", true, "Submission outcome not confirmed within the attempt budget");
		const after = await inspect();
		if (!after) return result("uncertain", true, "Could not inspect submission outcome");
		if (after.status === "success") return result("success", true, "Verification success observed");
		if (after.status === "failure") return result("failure", true, "Verification failure observed");
		if (after.identity !== identity)
			return result("changed", true, "A different challenge appeared after submission");
		if (poll < 7) {
			try {
				await driver.wait();
			} catch {
				return result("uncertain", true, "Could not wait for submission outcome");
			}
		}
	}
	return result("uncertain", true, "Submission outcome not confirmed");
}
