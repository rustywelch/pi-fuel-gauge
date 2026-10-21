export interface CompactionInfo {
	enabled: boolean;
	reserveTokens: number;
}

export const DEFAULT_RESERVE_TOKENS: number;
export function defaultCompactionInfo(window: number): CompactionInfo;
export function resolveCompactionInfo(settings: unknown, modelKey: string | null, window: number): CompactionInfo;
