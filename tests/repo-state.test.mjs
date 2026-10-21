import test from "node:test";
import assert from "node:assert/strict";

import {
	STATE_AHEAD,
	STATE_BEHIND,
	STATE_CLEAN,
	STATE_DETACHED,
	STATE_DIRTY,
	STATE_DIVERGED,
	STATE_NO_REMOTE,
	buildRepo,
	classifyRepo,
	findDuplicateOrigins,
	formatRepoReport,
	formatRepoRow,
	parseBranchNames,
	parseHeadLine,
	parseStatusPorcelainV2,
	sanitizeRemoteUrl,
	parseWorktreeList,
	repoHints,
	summarizeRepos,
	truncateReport,
} from "../lib/repo-state.mjs";

const CLEAN_UP_TO_DATE = [
	"# branch.oid 6e0f1c2b3d4e5f60718293a4b5c6d7e8f9012345",
	"# branch.head main",
	"# branch.upstream origin/main",
	"# branch.ab +0 -0",
].join("\n");

const BEHIND = [
	"# branch.oid 6e0f1c2b3d4e5f60718293a4b5c6d7e8f9012345",
	"# branch.head main",
	"# branch.upstream origin/main",
	"# branch.ab +0 -3",
].join("\n");

const AHEAD = [
	"# branch.oid 6e0f1c2b3d4e5f60718293a4b5c6d7e8f9012345",
	"# branch.head cadfix",
	"# branch.upstream origin/cadfix",
	"# branch.ab +2 -0",
].join("\n");

const DIVERGED = [
	"# branch.oid 6e0f1c2b3d4e5f60718293a4b5c6d7e8f9012345",
	"# branch.head cadfix",
	"# branch.upstream origin/cadfix",
	"# branch.ab +1 -4",
].join("\n");

const NO_UPSTREAM = [
	"# branch.oid 6e0f1c2b3d4e5f60718293a4b5c6d7e8f9012345",
	"# branch.head solo",
	"# branch.ab +0 -0",
].join("\n");

const DETACHED = [
	"# branch.oid 6e0f1c2b3d4e5f60718293a4b5c6d7e8f9012345",
	"# branch.head (detached)",
	"# branch.ab +0 -0",
	"1 .M N... 100644 100644 100644 b1dd151 b1dd151 README.md",
].join("\n");

const DIRTY = [
	"# branch.oid 6e0f1c2b3d4e5f60718293a4b5c6d7e8f9012345",
	"# branch.head main",
	"# branch.upstream origin/main",
	"# branch.ab +0 -0",
	"1 M. N... 100644 100644 100644 b1dd151 b1dd151 lib/repo-state.mjs",
	"1 .M N... 100644 100644 100644 b1dd151 b1dd151 README.md",
	"1 R. N... 100644 100644 100644 b1dd151 b1dd151 R 100 old-name.ts new-name.ts",
	"2 C. N... 100644 100644 100644 b1dd151 b1dd151 C 090 src/a.ts src/b.ts",
	"? N... 000000 000000 000000 0000000 scratch/",
	"u UU N... 100644 100644 100644 100644 a1 b2 c3 merge-conflict.ts",
].join("\n");

test("parses a clean, up-to-date branch header", () => {
	assert.deepEqual(parseStatusPorcelainV2(CLEAN_UP_TO_DATE), {
		branch: "main",
		upstream: "origin/main",
		ahead: 0,
		behind: 0,
		dirty: 0,
		untracked: 0,
		conflicted: 0,
		staged: 0,
		unstaged: 0,
		detached: false,
	});
});

test("counts ahead and behind separately", () => {
	assert.deepEqual(
		{ ...parseStatusPorcelainV2(BEHIND), ...{} },
		{ branch: "main", upstream: "origin/main", ahead: 0, behind: 3, dirty: 0, untracked: 0, conflicted: 0, staged: 0, unstaged: 0, detached: false },
	);
	assert.equal(parseStatusPorcelainV2(AHEAD).ahead, 2);
	const both = parseStatusPorcelainV2(DIVERGED);
	assert.equal(both.ahead, 1);
	assert.equal(both.behind, 4);
});

test("splits dirty entries into staged, unstaged, untracked, and conflicted", () => {
	const parsed = parseStatusPorcelainV2(DIRTY);
	assert.equal(parsed.dirty, 6, "staged, unstaged, rename, copy, untracked, and conflicted all count");
	assert.equal(parsed.untracked, 1);
	assert.equal(parsed.conflicted, 1);
	assert.equal(parsed.staged, 3, "M., R., and C. have a staged index side");
	assert.equal(parsed.unstaged, 1, "only .M has a worktree side");
});

test("marks detached HEAD and keeps its dirty count", () => {
	const parsed = parseStatusPorcelainV2(DETACHED);
	assert.equal(parsed.detached, true);
	assert.equal(parsed.branch, null);
	assert.equal(parsed.dirty, 1);
});

test("treats a missing or dead upstream as no upstream", () => {
	assert.equal(parseStatusPorcelainV2(NO_UPSTREAM).upstream, null);
	const dead = parseStatusPorcelainV2("# branch.head main\n# branch.upstream !origin/gone\n# branch.ab +0 -0");
	assert.equal(dead.upstream, null);
});

test("parses the one-line head record", () => {
	assert.deepEqual(parseHeadLine("e098b0a|2026-10-16|fix(search): handle no matches\n"), {
		hash: "e098b0a",
		date: "2026-10-16",
		subject: "fix(search): handle no matches",
	});
	assert.equal(parseHeadLine(""), null);
});

test("parses a worktree list with a prunable linked worktree", () => {
	const worktrees = parseWorktreeList([
		"worktree /Users/rustywelch/Dev/corti-platform",
		"HEAD 6e0f1c2b3d4e5f60718293a4b5c6d7e8f9012345",
		"branch refs/heads/main",
		"",
		"worktree /Users/rustywelch/Dev/worktrees/cadfix",
		"HEAD 1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
		"branch refs/heads/cadfix",
		"prunable",
		"",
	].join("\n"));
	assert.equal(worktrees.length, 2);
	assert.equal(worktrees[0].branch, "main");
	assert.equal(worktrees[1].path, "/Users/rustywelch/Dev/worktrees/cadfix");
	assert.equal(worktrees[1].branch, "cadfix");
	assert.equal(worktrees[1].prunable, true);
});

test("strips the current-branch marker from branch lists", () => {
	assert.deepEqual(parseBranchNames("* main\n  cadfix\n  (HEAD detached at 1a2b3c4)\n"), ["main", "cadfix"]);
});

test("redacts credentials in remote URLs before they reach the report", () => {
	assert.equal(
		sanitizeRemoteUrl("https://user:ghp_secretsecret@github.com/corti/platform.git"),
		"https://user:***@github.com/corti/platform.git",
	);
	assert.equal(sanitizeRemoteUrl("git@github.com:corti/platform.git"), "git@github.com:corti/platform.git");
	const row = buildRepo({ path: "/Dev/x", raw: { remote: "https://tok:sek@example.internal/r.git" } });
	assert.ok(!row.remote.includes("sek"), row.remote);
});

test("classifies each state by the most actionable condition", () => {
	const row = (text, extra = {}) => buildRepo({ path: "/x/repo", name: "repo", raw: { status: text, ...extra } });
	assert.equal(classifyRepo(row(CLEAN_UP_TO_DATE)), STATE_CLEAN);
	assert.equal(classifyRepo(row(DIRTY)), STATE_DIRTY);
	assert.equal(classifyRepo(row(BEHIND)), STATE_BEHIND);
	assert.equal(classifyRepo(row(AHEAD)), STATE_AHEAD);
	assert.equal(classifyRepo(row(DIVERGED)), STATE_DIVERGED);
	assert.equal(classifyRepo(row(DETACHED)), STATE_DETACHED);
	assert.equal(classifyRepo(row(NO_UPSTREAM)), STATE_NO_REMOTE);
	assert.equal(classifyRepo(buildRepo({ path: "/x/repo", error: "git status failed" })), "error");
});

test("behind outranks dirty so a stale checkout is never called merely dirty", () => {
	const row = buildRepo({ path: "/x/repo", raw: { status: `${BEHIND}\n? N... 000000 000000 000000 0000000 tmp/` } });
	assert.equal(classifyRepo(row), STATE_BEHIND);
	assert.equal(row.dirty, 1);
});

test("dirty outranks no-upstream so uncommitted work is never hidden", () => {
	const row = buildRepo({
		path: "/x/repo",
		raw: { status: `${NO_UPSTREAM}\n1 N... 000000 000000 000000 0000000 0000000 M\tsrc/thing.ts` },
	});
	assert.equal(row.dirty, 1);
	assert.equal(row.upstream, null);
	assert.equal(classifyRepo(row), STATE_DIRTY);
});

test("hints name the read-only next step without deleting anything", () => {
	const clean = buildRepo({ path: "/x/repo", name: "repo", raw: { status: CLEAN_UP_TO_DATE } });
	assert.deepEqual(repoHints(clean), []);
	assert.deepEqual(repoHints(buildRepo({ path: "/x/repo", raw: { status: BEHIND } })), ["pull --ff-only"]);
	assert.deepEqual(repoHints(buildRepo({ path: "/x/repo", raw: { status: DETACHED } })), [
		"checkout a branch or note the commit before changing files",
	]);
});

test("formats a fixed-width row and summary line", () => {
	const repos = [
		buildRepo({ path: "/Users/rustywelch/Dev/corti-platform", name: "corti-platform", raw: { status: BEHIND, head: "e098b0a|2026-10-16|fix: x" } }),
		buildRepo({ path: "/Users/rustywelch/Dev/notes", name: "notes", raw: { status: CLEAN_UP_TO_DATE, head: "abc1234|2026-09-01|docs: y" } }),
	];
	const row = formatRepoRow(repos[0]);
	assert.equal(row.length, formatRepoRow(repos[1]).length, "rows share one width");
	assert.ok(row.startsWith("corti-platform"), row);
	assert.ok(row.includes("behind"), row);

	const report = formatRepoReport(repos, { root: "/Users/rustywelch/Dev" });
	assert.ok(report.includes("Suggested read-only next steps"), report);
	assert.ok(report.includes("corti-platform: pull --ff-only"), report);
	assert.ok(report.includes("Root scanned: /Users/rustywelch/Dev"), report);
	assert.ok(report.includes("Summary: 2 repos; behind 1, clean 1"), report);
	assert.ok(report.includes("local refs only; pass fetch=true to refresh"), report);
});

test("groups duplicate checkouts by origin URL", () => {
	const repos = [
		buildRepo({ path: "/Dev/corti-platform", name: "corti-platform", raw: { status: CLEAN_UP_TO_DATE, remote: "git@github.com:corti/platform.git" } }),
		buildRepo({ path: "/Dev/corti-platform-cadfix", name: "corti-platform-cadfix", raw: { status: CLEAN_UP_TO_DATE, remote: "git@github.com:corti/platform.git" } }),
		buildRepo({ path: "/Dev/other", name: "other", raw: { status: CLEAN_UP_TO_DATE, remote: "git@github.com:corti/other.git" } }),
		buildRepo({ path: "/Dev/plain-copy", name: "plain-copy", raw: { status: CLEAN_UP_TO_DATE } }),
	];
	assert.deepEqual(findDuplicateOrigins(repos), [
		{
			remote: "git@github.com:corti/platform.git",
			paths: ["/Dev/corti-platform", "/Dev/corti-platform-cadfix"],
			plainCopies: 2,
		},
	]);
	const report = formatRepoReport(repos, { root: "/Dev", dirsChecked: 42 });
	assert.ok(report.includes("Same origin remote in more than one place"), report);
	assert.ok(report.includes("/Dev/corti-platform-cadfix"), report);
	assert.ok(report.includes("WARNING: 2 separate .git checkouts of this origin"), report);
	assert.ok(report.includes("Directories probed with git rev-parse: 42"), report);
});

test("a linked worktree of one repo is not reported as a plain copy", () => {
	const repos = [
		buildRepo({ path: "/Dev/corti-platform", name: "corti-platform", commonDir: "/Dev/corti-platform/.git", raw: { status: CLEAN_UP_TO_DATE, remote: "git@github.com:corti/platform.git" } }),
		buildRepo({
			path: "/Dev/worktrees/cadfix",
			name: "cadfix",
			commonDir: "/Dev/corti-platform/.git",
			isWorktreeCopy: true,
			raw: { status: CLEAN_UP_TO_DATE, remote: "git@github.com:corti/platform.git" },
		}),
	];
	const [group] = findDuplicateOrigins(repos);
	assert.deepEqual(group.paths, ["/Dev/corti-platform", "/Dev/worktrees/cadfix (linked worktree)"]);
	assert.equal(group.plainCopies, 1);
	assert.ok(formatRepoReport(repos, { root: "/Dev" }).includes("expected layout, not a plain copy"));
});

test("adds worktree and merged-branch detail only when detail is requested", () => {
	const repos = [
		buildRepo({
			path: "/Dev/corti-platform",
			name: "corti-platform",
			raw: {
				status: CLEAN_UP_TO_DATE,
				worktrees: "worktree /Dev/corti-platform\nHEAD 1a2b\nbranch refs/heads/main\n\nworktree /Dev/worktrees/cadfix\nHEAD 3c4d\nbranch refs/heads/cadfix\n",
				merged: "* main\n  cadfix\n",
			},
		}),
	];
	assert.ok(!formatRepoReport(repos, { root: "/Dev" }).includes("worktrees: 1"));
	const detailed = formatRepoReport(repos, { root: "/Dev", detail: true });
	assert.ok(detailed.includes("Detail (worktrees and read-only merged-branch hints):"), detailed);
	assert.ok(detailed.includes("worktree /Dev/worktrees/cadfix branch cadfix"), detailed);
	assert.ok(detailed.includes("merged into main: main, cadfix"), detailed);
});

test("truncates and says where the full data is", () => {
	const long = "x".repeat(500);
	const kept = truncateReport(long, 600);
	assert.equal(kept.truncated, false);
	assert.equal(kept.hidden, 0);

	const cut = truncateReport(long, 100);
	assert.equal(cut.truncated, true);
	assert.equal(cut.hidden, 400);
	assert.ok(cut.text.startsWith("x".repeat(100)));
	assert.ok(cut.text.includes("TRUNCATED: showed 100 of 500 characters (400 more not shown)"), cut.text);
	assert.ok(cut.text.includes("Re-run with a narrower group to see less."), cut.text);

	const saved = truncateReport(long, 100, "/tmp/pi-repo-state/report.txt");
	assert.ok(saved.text.includes("Full report saved to /tmp/pi-repo-state/report.txt."), saved.text);
});
