export const VERIFICATION_BUDGET = {
	version: "jev-2026-11-08.4",
	targetMs: 10_000,
	limitMs: 300_000,
} as const;

export function verificationBudget(elapsedMs: number) {
	return { ...VERIFICATION_BUDGET, targetExceeded: elapsedMs > VERIFICATION_BUDGET.targetMs };
}
