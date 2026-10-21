export const STATE_DETACHED: "detached";
export const STATE_ERROR: "error";
export const STATE_DIVERGED: "diverged";
export const STATE_BEHIND: "behind";
export const STATE_AHEAD: "ahead";
export const STATE_CLEAN: "clean";
export const STATE_DIRTY: "dirty";
export const STATE_NO_REMOTE: "no-remote";

export type RepoState =
	| "detached"
	| "error"
	| "diverged"
	| "behind"
	| "ahead"
	| "clean"
	| "dirty"
	| "no-remote";

export interface HeadInfo {
	hash: string;
	date: string;
	subject: string;
}

export interface WorktreeInfo {
	path: string;
	head: string;
	branch: string | null;
	prunable: boolean;
	detached: boolean;
}

/** Status fields parsed from `git status --porcelain=v2 -b --branch`. */
export interface ParsedStatus {
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	dirty: number;
	untracked: number;
	conflicted: number;
	staged: number;
	unstaged: number;
	detached: boolean;
}

/** Raw git text collected by the extension, keyed by command. */
export interface RawGitOutput {
	status?: string;
	head?: string;
	worktrees?: string;
	remote?: string;
	merged?: string;
}

/** One repository row in the report. */
export interface RepoRow extends ParsedStatus {
	path: string;
	name: string;
	remote: string | null;
	head: HeadInfo | null;
	worktrees: WorktreeInfo[];
	mergedBranches: string[];
	commonDir: string | null;
	isWorktreeCopy: boolean;
	error: string | null;
}

export interface DuplicateOrigin {
	remote: string;
	/** Paths, with a "(linked worktree)" tag on checkouts that share another checkout's .git dir. */
	paths: string[];
	/** Checkouts with their own .git dir; more than one means plain copies, which policy forbids. */
	plainCopies: number;
}

export interface ReportSummary {
	total: number;
	parts: string[];
}

export interface TruncatedReport {
	text: string;
	truncated: boolean;
	hidden: number;
}

export function parseStatusPorcelainV2(text: string): ParsedStatus;
export function parseHeadLine(text: string): HeadInfo | null;
export function parseWorktreeList(text: string): WorktreeInfo[];
export function parseBranchNames(text: string): string[];
/** Redacts any user:password token embedded in a remote URL. */
export function sanitizeRemoteUrl(url: string): string;
export function buildRepo(input: {
	path: string;
	name?: string;
	commonDir?: string | null;
	raw?: RawGitOutput;
	isWorktreeCopy?: boolean;
	error?: string | null;
}): RepoRow;
export function classifyRepo(repo: RepoRow): RepoState;
export function repoHints(repo: RepoRow): string[];
export function formatRepoRow(repo: RepoRow): string;
export function summarizeRepos(repos: RepoRow[]): ReportSummary;
export function findDuplicateOrigins(repos: RepoRow[]): DuplicateOrigin[];
export function formatRepoReport(
	repos: RepoRow[],
	options?: { root?: string; fetch?: boolean; detail?: boolean; dirsChecked?: number },
): string;
export function truncateReport(text: string, maxChars: number, fullPath?: string): TruncatedReport;
