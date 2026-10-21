export const DEFAULT_RESERVE_TOKENS = 16_384;

export function defaultCompactionInfo(window) {
	return {
		enabled: DEFAULT_RESERVE_TOKENS < window,
		reserveTokens: DEFAULT_RESERVE_TOKENS,
	};
}

export function resolveCompactionInfo(settings, modelKey, window) {
	const compaction = settings?.compaction ?? {};
	const enabled = compaction.enabled !== false;
	const override = modelKey ? compaction.modelOverrides?.[modelKey]?.reserveTokens : undefined;
	let reserveTokens = DEFAULT_RESERVE_TOKENS;
	if (Number.isSafeInteger(override) && override >= 0) {
		reserveTokens = override;
	} else if (Number.isSafeInteger(compaction.reserveTokens) && compaction.reserveTokens >= 0) {
		reserveTokens = compaction.reserveTokens;
	}
	return {
		enabled: enabled && reserveTokens < window,
		reserveTokens,
	};
}
