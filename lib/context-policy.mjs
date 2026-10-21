export const PREPARE_PERCENT = 75;
export const HARD_COMPACT_PERCENT = 80;

export function contextPolicy(percent) {
	if (percent >= HARD_COMPACT_PERCENT) {
		return {
			phase: "hard",
			compactionRequired: true,
			requireCleanBoundary: false,
		};
	}
	if (percent >= PREPARE_PERCENT) {
		return {
			phase: "prepare",
			compactionRequired: false,
			requireCleanBoundary: true,
		};
	}
	return {
		phase: "normal",
		compactionRequired: false,
		requireCleanBoundary: false,
	};
}
