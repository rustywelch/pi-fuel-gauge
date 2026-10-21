export const PREPARE_PERCENT: 75;
export const HARD_COMPACT_PERCENT: 80;

export type ContextPolicy =
	| { phase: "normal"; compactionRequired: false; requireCleanBoundary: false }
	| { phase: "prepare"; compactionRequired: false; requireCleanBoundary: true }
	| { phase: "hard"; compactionRequired: true; requireCleanBoundary: false };

export function contextPolicy(percent: number): ContextPolicy;
