/**
 * Pure parsing, classification, and formatting for the repo-state extension.
 *
 * Kept free of child processes and the file system so the git output grammar,
 * the row classification, and the table layout can be unit-tested with fixtures.
 * The extension in extensions/repo-state.ts collects the raw git text and hands
 * it to these functions.
 */

/** States a repository row can be in, most actionable first. */
export const STATE_DETACHED = "detached";
export const STATE_ERROR = "error";
export const STATE_DIVERGED = "diverged";
export const STATE_BEHIND = "behind";
export const STATE_AHEAD = "ahead";
export const STATE_CLEAN = "clean";
export const STATE_DIRTY = "dirty";
export const STATE_NO_REMOTE = "no-remote";

/**
 * Parse `git status --porcelain=v2 -b --branch` output.
 * Branch header lines start with "# "; every other line is one change entry
 * whose first character is the entry kind.
 */
export function parseStatusPorcelainV2(text) {
	const repo = {
		branch: null,
		upstream: null,
		ahead: 0,
		behind: 0,
		dirty: 0,
		untracked: 0,
		conflicted: 0,
		staged: 0,
		unstaged: 0,
		detached: false,
	};

	for (const line of String(text ?? "").split("\n")) {
		if (line.length === 0) continue;

		if (line.startsWith("# branch.oid ")) continue;

		if (line.startsWith("# branch.head ")) {
			const head = line.slice("# branch.head ".length).trim();
			repo.detached = head === "(detached)" || head === "";
			repo.branch = repo.detached ? null : head;
			continue;
		}

		if (line.startsWith("# branch.upstream ")) {
			const up = line.slice("# branch.upstream ".length).trim();
			// "!<name>" means the upstream ref is gone.
			repo.upstream = up.startsWith("!") ? null : up || null;
			continue;
		}

		if (line.startsWith("# branch.ab ")) {
			const ab = line.slice("# branch.ab ".length).match(/\+(\d+)\s+-(\d+)/);
			if (ab) {
				repo.ahead = Number(ab[1]);
				repo.behind = Number(ab[2]);
			}
			continue;
		}

		if (line.startsWith("#")) continue;

		const kind = line[0];
		if (kind === "?" || kind === "!") {
			repo.untracked += kind === "?" ? 1 : 0;
			repo.dirty += 1;
			continue;
		}
		if (kind === "u") {
			repo.conflicted += 1;
			repo.dirty += 1;
			continue;
		}
		if (kind === "1" || kind === "2") {
			// Columns: XY sub mH mI mW hH hI [X score] path. XY is index/worktree.
			const xy = line.slice(2, 4);
			if (xy[0] !== ".") repo.staged += 1;
			if (xy[1] !== ".") repo.unstaged += 1;
			repo.dirty += 1;
			continue;
		}
		if (kind === "-") {
			// Deleted by us, reported for `git status -uno --ignored` style runs.
			repo.staged += 1;
			repo.dirty += 1;
			continue;
		}
	}

	return repo;
}

/** Parse `git log -1 --format=%h|%cs|%s`. Returns null when the repo has no commits. */
export function parseHeadLine(text) {
	const line = String(text ?? "").trim();
	if (!line) return null;
	const [hash, date, ...rest] = line.split("|");
	if (!hash) return null;
	return { hash, date: date || "", subject: rest.join("|") };
}

/** Parse `git worktree list --porcelain` into one record per worktree. */
export function parseWorktreeList(text) {
	const worktrees = [];
	let current = null;
	for (const line of String(text ?? "").split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current) worktrees.push(current);
			current = { path: line.slice("worktree ".length), head: "", branch: null, prunable: false, detached: false };
			continue;
		}
		if (!current) continue;
		if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
		else if (line.startsWith("branch ")) current.branch = line.slice("branch refs/heads/".length);
		else if (line === "prunable") current.prunable = true;
		else if (line === "detached") current.detached = true;
	}
	if (current) worktrees.push(current);
	return worktrees;
}

/** Parse `git branch --merged` / `git for-each-ref` style name lists, dropping the current-branch marker. */
export function parseBranchNames(text) {
	return String(text ?? "")
		.split("\n")
		.map((line) => line.replace(/^\*?\+?\s*/, "").trim())
		.filter((name) => name.length > 0 && !name.startsWith("("));
}

/**
 * Reduce a candidate directory to one report row. `raw` holds the git text the
 * extension collected; `error` marks a directory git refused to report.
 * `isWorktreeCopy` is true when the checkout shares another checkout's .git
 * dir, which distinguishes a linked worktree from a plain copy.
 */
export function buildRepo({ path, name, commonDir = null, raw = {}, isWorktreeCopy = false, error = null }) {
	const repo = path ? parseStatusPorcelainV2(raw.status) : {
		branch: null,
		upstream: null,
		ahead: 0,
		behind: 0,
		dirty: 0,
		untracked: 0,
		conflicted: 0,
		staged: 0,
		unstaged: 0,
		detached: false,
	};
	return {
		path,
		name: name || path,
		...repo,
		remote: sanitizeRemoteUrl(raw.remote),
		head: parseHeadLine(raw.head),
		worktrees: parseWorktreeList(raw.worktrees || ""),
		mergedBranches: parseBranchNames(raw.merged || ""),
		commonDir,
		isWorktreeCopy,
		error,
	};
}

/** One primary state per row: the first condition a user should act on. */
export function classifyRepo(repo) {
	if (repo.error) return STATE_ERROR;
	if (repo.detached) return STATE_DETACHED;
	if (repo.ahead > 0 && repo.behind > 0) return STATE_DIVERGED;
	if (repo.behind > 0) return STATE_BEHIND;
	if (repo.ahead > 0) return STATE_AHEAD;
	// Uncommitted work outranks a missing upstream: a branch with no upstream
	// cannot be ahead or behind, so reporting no-remote first would hide the
	// dirt that the user actually has to act on.
	if (repo.dirty > 0) return STATE_DIRTY;
	if (!repo.upstream) return STATE_NO_REMOTE;
	return STATE_CLEAN;
}

/** Read-only next-step hints. The tool never runs these commands itself. */
export function repoHints(repo) {
	const state = classifyRepo(repo);
	switch (state) {
		case STATE_CLEAN:
			return repo.ahead === 0 && repo.behind === 0 && !repo.isWorktreeCopy
				? []
				: ["check whether this worktree is still needed"];
		case STATE_BEHIND:
			return ["pull --ff-only"];
		case STATE_DIRTY:
			return [`commit or discard ${repo.dirty} change(s)`];
		case STATE_DIVERGED:
			return ["inspect local commits before any pull"];
		case STATE_AHEAD:
			return [`${repo.ahead} local commit(s) not on ${repo.upstream}`];
		case STATE_DETACHED:
			return ["checkout a branch or note the commit before changing files"];
		case STATE_NO_REMOTE:
			return ["no upstream: cannot compare with a remote"];
		case STATE_ERROR:
			return [repo.error];
		default:
			return [];
	}
}

const COLUMNS = [
	{ key: "name", header: "REPO", width: 34 },
	{ key: "branch", header: "BRANCH", width: 26 },
	{ key: "ahead", header: "AHEAD", width: 5, align: "right" },
	{ key: "behind", header: "BEHIND", width: 6, align: "right" },
	{ key: "dirty", header: "DIRTY", width: 5, align: "right" },
	{ key: "head", header: "HEAD", width: 8 },
	{ key: "date", header: "UPDATED", width: 10 },
	{ key: "state", header: "STATE", width: 10 },
];

function cell(value, width, align) {
	const s = value == null || value === "" ? "-" : String(value);
	const cut = s.length > width ? s.slice(0, width - 1) + "…" : s;
	return align === "right" ? cut.padStart(width) : cut.padEnd(width);
}

/**
 * Hide credentials that sometimes hide in a remote URL so the report is safe to
 * paste into a transcript.
 */
export function sanitizeRemoteUrl(url) {
	return String(url ?? "").replace(/([^:/\/]+):([^@/]+)@/, "$1:***@");
}

/** Format one fixed-width row. Exported so the layout is testable on its own. */
export function formatRepoRow(repo) {
	const cells = {
		name: repo.name,
		branch: repo.branch,
		ahead: repo.ahead,
		behind: repo.behind,
		dirty: repo.dirty,
		head: repo.head?.hash,
		date: repo.head?.date,
		state: classifyRepo(repo),
	};
	// No trimEnd: every line keeps the same width so the columns stay aligned.
	return COLUMNS.map((c) => cell(cells[c.key], c.width, c.align)).join(" ");
}

function formatHeader() {
	return COLUMNS.map((c) => c.header.padEnd(c.width)).join(" ");
}

/** Counts per state, in table order, plus the total. */
export function summarizeRepos(repos) {
	const counts = new Map();
	for (const repo of repos) {
		const state = classifyRepo(repo);
		counts.set(state, (counts.get(state) ?? 0) + 1);
	}
	const parts = [];
	for (const state of [STATE_DETACHED, STATE_ERROR, STATE_DIVERGED, STATE_BEHIND, STATE_AHEAD, STATE_DIRTY, STATE_NO_REMOTE, STATE_CLEAN]) {
		// Order matches classifyRepo precedence: dirty before no-remote.
		const n = counts.get(state);
		if (n) parts.push(`${state} ${n}`);
	}
	return { total: repos.length, parts };
}

/**
 * Group checkouts that point at the same origin URL. Linked worktrees of one
 * repository are expected; separate .git dirs with the same origin are the
 * plain copies policy forbids, so `plainCopies` counts them and the report
 * lists every path for a human to resolve. Nothing here deletes anything.
 */
export function findDuplicateOrigins(repos) {
	const byRemote = new Map();
	for (const repo of repos) {
		if (!repo.remote) continue;
		const list = byRemote.get(repo.remote) ?? [];
		list.push(repo);
		byRemote.set(repo.remote, list);
	}
	return [...byRemote.entries()]
		.filter(([, list]) => list.length > 1)
		.map(([remote, list]) => ({
			remote,
			paths: list.map((repo) => (repo.isWorktreeCopy ? `${repo.path} (linked worktree)` : repo.path)),
			plainCopies: list.filter((repo) => !repo.isWorktreeCopy).length,
		}))
		.sort((a, b) => a.remote.localeCompare(b.remote));
}

/** Full text report: table, summary line, duplicate origins, then detail sections. */
export function formatRepoReport(repos, options = {}) {
	const lines = [];
	const root = options.root ? `Root scanned: ${options.root}` : "Root scanned: (unspecified)";
	lines.push(root);
	lines.push(options.fetch ? "Remote state: fetched with git fetch" : "Remote state: local refs only; pass fetch=true to refresh");
	if (typeof options.dirsChecked === "number") lines.push(`Directories probed with git rev-parse: ${options.dirsChecked}`);
	lines.push("");

	if (repos.length === 0) {
		lines.push("No git repositories found under that root.");
		return lines.join("\n");
	}

	lines.push(formatHeader());
	for (const repo of repos) lines.push(formatRepoRow(repo));

	const summary = summarizeRepos(repos);
	lines.push("");
	lines.push(`Summary: ${summary.total} repos; ${summary.parts.join(", ")}`);

	const duplicates = findDuplicateOrigins(repos);
	lines.push("");
	lines.push("Same origin remote in more than one place (this tool never deletes; resolve by hand):");
	if (duplicates.length === 0) {
		lines.push("  none detected");
	} else {
		for (const dup of duplicates) {
			lines.push(`  ${dup.remote}`);
			for (const path of dup.paths) lines.push(`    ${path}`);
			lines.push(
				dup.plainCopies > 1
					? `    WARNING: ${dup.plainCopies} separate .git checkouts of this origin. Untracked plain copies are forbidden policy: verify which path is tracked and remove the extras yourself.`
					: "    one .git dir with linked worktrees; expected layout, not a plain copy",
			);
		}
	}

	const hintLines = [];
	for (const repo of repos) {
		const hints = repoHints(repo);
		if (hints.length > 0) hintLines.push(`  ${repo.name}: ${hints.join("; ")}`);
	}
	lines.push("");
	lines.push("Suggested read-only next steps (run them yourself; this tool changes nothing):");
	lines.push(hintLines.length === 0 ? "  nothing to do; every repo is clean and up to date" : hintLines.join("\n"));

	if (options.detail) {
		lines.push("");
		lines.push("Detail (worktrees and read-only merged-branch hints):");
		for (const repo of repos) {
			lines.push(`  ${repo.name}`);
			if (repo.worktrees.length > 1) {
				for (const wt of repo.worktrees) {
					lines.push(`    worktree ${wt.path}${wt.branch ? ` branch ${wt.branch}` : " (detached)"}${wt.prunable ? " PRUNABLE" : ""}`);
				}
			} else {
				lines.push("    worktrees: 1 (main checkout only)");
			}
			lines.push(`    merged into ${repo.branch || "HEAD"}: ${repo.mergedBranches.length ? repo.mergedBranches.join(", ") : "none"}`);
		}
	}

	return lines.join("\n");
}

/**
 * Cap report size for the model and say plainly what was cut. When `fullPath` is
 * given the note points at the saved full report; otherwise it says how to narrow.
 */
export function truncateReport(text, maxChars, fullPath) {
	const limit = maxChars > 0 ? maxChars : 0;
	if (text.length <= limit) return { text, truncated: false, hidden: 0 };
	const kept = text.slice(0, limit);
	const hidden = text.length - limit;
	const where = fullPath ? `Full report saved to ${fullPath}.` : "Re-run with a narrower group to see less.";
	return {
		text: `${kept}\n\n[TRUNCATED: showed ${limit} of ${text.length} characters (${hidden} more not shown). ${where}]`,
		truncated: true,
		hidden,
	};
}
